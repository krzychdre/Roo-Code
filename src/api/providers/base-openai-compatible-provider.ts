import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import type { ModelInfo } from "@roo-code/types"

import { type ApiHandlerOptions, getModelMaxOutputTokens } from "../../shared/api"
import { TagMatcher } from "../../utils/tag-matcher"
import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"

import type { CompletionResult, SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { DEFAULT_HEADERS } from "./constants"
import { BaseProvider } from "./base-provider"
import { handleOpenAIError } from "./utils/openai-error-handler"
import { openAiCompletionUsage } from "./utils/completion-usage"
import { calculateApiCostOpenAI } from "../../shared/cost"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"
import { emitToolCallChunks, emitFinishReasonChunk } from "./utils/openai-stream-chunks"

type BaseOpenAiCompatibleProviderOptions<ModelName extends string> = ApiHandlerOptions & {
	providerName: string
	baseURL: string
	defaultProviderModelId: ModelName
	providerModels: Record<ModelName, ModelInfo>
	defaultTemperature?: number
}

export abstract class BaseOpenAiCompatibleProvider<ModelName extends string>
	extends BaseProvider
	implements SingleCompletionHandler
{
	protected readonly providerName: string
	protected readonly baseURL: string
	protected readonly defaultTemperature: number
	protected readonly defaultProviderModelId: ModelName
	protected readonly providerModels: Record<ModelName, ModelInfo>

	protected readonly options: ApiHandlerOptions

	protected client: OpenAI | null = null
	protected abortController?: AbortController

	constructor({
		providerName,
		baseURL,
		defaultProviderModelId,
		providerModels,
		defaultTemperature,
		...options
	}: BaseOpenAiCompatibleProviderOptions<ModelName>) {
		super()

		this.providerName = providerName
		this.baseURL = baseURL
		this.defaultProviderModelId = defaultProviderModelId
		this.providerModels = providerModels
		this.defaultTemperature = defaultTemperature ?? 0

		this.options = options

		if (!this.options.apiKey) {
			throw new Error("API key is required")
		}

		this.client = new OpenAI({
			baseURL,
			apiKey: this.options.apiKey,
			defaultHeaders: DEFAULT_HEADERS,
			timeout: this.timeoutMs,
		})
	}

	/**
	 * Gets the client, recreating it if it was previously destroyed.
	 */
	protected getClient(): OpenAI {
		if (!this.client) {
			this.client = new OpenAI({
				baseURL: this.baseURL,
				apiKey: this.options.apiKey,
				defaultHeaders: DEFAULT_HEADERS,
				timeout: this.timeoutMs,
			})
		}
		return this.client
	}

	protected createStream(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
		requestOptions?: OpenAI.RequestOptions,
	) {
		const { id: model, info } = this.getModel()

		// Centralized cap: clamp to 20% of the context window (unless provider-specific exceptions apply)
		const max_tokens =
			getModelMaxOutputTokens({
				modelId: model,
				model: info,
				settings: this.options,
				format: "openai",
			}) ?? undefined

		const temperature = this.options.modelTemperature ?? info.defaultTemperature ?? this.defaultTemperature

		const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
			model,
			max_tokens,
			temperature,
			messages: [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
			stream: true,
			stream_options: { include_usage: true },
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}

		// Add thinking parameter if reasoning is enabled and model supports it
		if (this.options.enableReasoningEffort && info.supportsReasoningBinary) {
			;(params as any).thinking = { type: "enabled" }
		}

		// Create a fresh AbortController for this request
		this.abortController = new AbortController()
		const mergedRequestOptions: OpenAI.RequestOptions = {
			...requestOptions,
			signal: this.abortController.signal,
		}

		try {
			return this.getClient().chat.completions.create(params, mergedRequestOptions)
		} catch (error) {
			this.abortController = undefined
			throw handleOpenAIError(error, this.providerName)
		}
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const stream = await this.createStream(systemPrompt, messages, metadata)

		const matcher = new TagMatcher(
			["think", "thought"],
			(chunk) =>
				({
					type: chunk.matched ? "reasoning" : "text",
					text: chunk.data,
				}) as const,
		)

		let lastUsage: OpenAI.CompletionUsage | undefined

		try {
			for await (const chunk of stream) {
				// Check for provider-specific error responses (e.g., MiniMax base_resp)
				const chunkAny = chunk as any
				if (chunkAny.base_resp?.status_code && chunkAny.base_resp.status_code !== 0) {
					throw new Error(
						`${this.providerName} API Error (${chunkAny.base_resp.status_code}): ${chunkAny.base_resp.status_msg || "Unknown error"}`,
					)
				}

				const delta = chunk.choices?.[0]?.delta
				const finishReason = chunk.choices?.[0]?.finish_reason

				if (delta?.content) {
					for (const processedChunk of matcher.update(delta.content)) {
						yield processedChunk
					}
				}

				const reasoningText = extractReasoningFromDelta(delta)
				if (reasoningText) {
					yield { type: "reasoning", text: reasoningText }
				}

				// Emit raw tool call chunks - NativeToolCallParser handles state management
				yield* emitToolCallChunks(delta)

				// Yield finish_reason so TaskStreamProcessor can handle it with per-task parser state.
				// This covers ALL finish reasons (not just "tool_calls") — many local/weak
				// OpenAI-compatible servers (llama.cpp, vLLM, older LM Studio) return "stop"
				// even after emitting tool_calls deltas (AP-2).
				yield* emitFinishReasonChunk(finishReason)

				if (chunk.usage) {
					lastUsage = chunk.usage
				}
			}

			if (lastUsage) {
				yield this.processUsageMetrics(lastUsage, this.getModel().info)
			}

			// Process any remaining content
			for (const processedChunk of matcher.final()) {
				yield processedChunk
			}
		} finally {
			this.abortController = undefined
		}
	}

	protected processUsageMetrics(usage: any, modelInfo?: any): ApiStreamUsageChunk {
		// Spike instrumentation: dump the provider's raw usage object so cache
		// reporting can be verified endpoint-by-endpoint (e.g. whether Z.ai's
		// coding plan returns prompt_tokens_details.cached_tokens). See
		// ai_plans/2026-07-12_glm-agent-loop-efficiency-implementation.md (WS-6).
		if (process.env.ROO_LOG_RAW_USAGE === "1") {
			console.log(`[${this.providerName}] raw usage: ${JSON.stringify(usage)}`)
		}

		const inputTokens = usage?.prompt_tokens || 0
		const outputTokens = usage?.completion_tokens || 0
		const cacheWriteTokens = usage?.prompt_tokens_details?.cache_write_tokens || 0
		const cacheReadTokens = usage?.prompt_tokens_details?.cached_tokens || 0

		const { totalCost } = modelInfo
			? calculateApiCostOpenAI(modelInfo, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)
			: { totalCost: 0 }

		return {
			type: "usage",
			inputTokens,
			outputTokens,
			cacheWriteTokens: cacheWriteTokens || undefined,
			cacheReadTokens: cacheReadTokens || undefined,
			totalCost,
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		return (await this.completePromptWithUsage(prompt)).text
	}

	async completePromptWithUsage(prompt: string): Promise<CompletionResult> {
		const { id: modelId, info: modelInfo } = this.getModel()

		const params: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
			model: modelId,
			messages: [{ role: "user", content: prompt }],
		}

		// Add thinking parameter if reasoning is enabled and model supports it
		if (this.options.enableReasoningEffort && modelInfo.supportsReasoningBinary) {
			;(params as any).thinking = { type: "enabled" }
		}

		this.abortController = new AbortController()
		try {
			const response = await this.getClient().chat.completions.create(params, {
				signal: this.abortController.signal,
			})

			// Check for provider-specific error responses (e.g., MiniMax base_resp)
			const responseAny = response as any
			if (responseAny.base_resp?.status_code && responseAny.base_resp.status_code !== 0) {
				throw new Error(
					`${this.providerName} API Error (${responseAny.base_resp.status_code}): ${responseAny.base_resp.status_msg || "Unknown error"}`,
				)
			}

			return {
				text: response.choices?.[0]?.message.content || "",
				usage: openAiCompletionUsage(response.usage),
			}
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		} finally {
			this.abortController = undefined
		}
	}

	cancelRequest(destroyClient: boolean = false): void {
		if (this.abortController) {
			this.abortController.abort()
			this.abortController = undefined
		}

		if (destroyClient && this.client) {
			this.client = null
		}
	}

	override getModel() {
		const id =
			this.options.apiModelId && this.options.apiModelId in this.providerModels
				? (this.options.apiModelId as ModelName)
				: this.defaultProviderModelId

		return { id, info: this.providerModels[id] }
	}
}
