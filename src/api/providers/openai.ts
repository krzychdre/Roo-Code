import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { AzureOpenAI } from "openai"
import axios from "axios"

import {
	type ModelInfo,
	azureOpenAiDefaultApiVersion,
	openAiModelInfoSaneDefaults,
	DEEP_SEEK_DEFAULT_TEMPERATURE,
	OPENAI_AZURE_AI_INFERENCE_PATH,
} from "@roo-code/types"

import { type ApiHandlerOptions, shouldUseReasoningEffort } from "../../shared/api"

import { TagMatcher } from "../../utils/tag-matcher"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { convertToR1Format } from "../transform/r1-format"
import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import { DEFAULT_HEADERS } from "./constants"
import { BaseProvider } from "./base-provider"
import type { CompletionResult, SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { handleOpenAIError } from "./utils/openai-error-handler"
import { openAiCompletionUsage } from "./utils/completion-usage"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"

/**
 * Custom interface for GLM params to support thinking mode.
 * GLM models (GLM-4.5, GLM-4.6, GLM-4.7, GLM-5) from z.ai support a thinking
 * object that enables chain-of-thought reasoning.
 *
 * - LOW budget: { type: "enabled" } - Basic thinking (reasoning within turn)
 * - MEDIUM budget: { type: "enabled", clear_thinking: false } - Turn-level/preserved thinking
 * - Disabled: { type: "disabled" }
 *
 * @see https://docs.z.ai/guides/llm/glm-4.7
 */
type GLMChatCompletionParams = OpenAI.Chat.ChatCompletionCreateParamsStreaming & {
	thinking?: { type: "enabled" | "disabled"; clear_thinking?: boolean }
}

/**
 * Detects if the model ID is a GLM model that supports thinking mode.
 * Matches GLM-4.5, GLM-4.6, GLM-4.7, GLM-5 and their variants.
 */
function isGLMThinkingModel(modelId: string): boolean {
	const normalized = modelId.toLowerCase()
	return (
		normalized.includes("glm-4.5") ||
		normalized.includes("glm-4.6") ||
		normalized.includes("glm-4.7") ||
		normalized.includes("glm-5")
	)
}

// TODO: Rename this to OpenAICompatibleHandler. Also, I think the
// `OpenAINativeHandler` can subclass from this, since it's obviously
// compatible with the OpenAI API. We can also rename it to `OpenAIHandler`.
export class OpenAiHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	protected client: OpenAI | null = null
	private abortController?: AbortController
	private readonly providerName = "OpenAI"

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		// Client is created lazily on first use via getClient()
	}

	/**
	 * Creates or recreates the OpenAI SDK client.
	 * Called lazily on first request or after client destruction.
	 */
	private createClient(): OpenAI {
		const baseURL = this.options.openAiBaseUrl || "https://api.openai.com/v1"
		const apiKey = this.options.openAiApiKey ?? "not-provided"
		const isAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)
		const urlHost = this._getUrlHost(this.options.openAiBaseUrl)
		const isAzureOpenAi = urlHost === "azure.com" || urlHost.endsWith(".azure.com") || this.options.openAiUseAzure

		const headers = {
			...DEFAULT_HEADERS,
			...(this.options.openAiHeaders || {}),
		}

		const timeout = this.timeoutMs

		if (isAzureAiInference) {
			// Azure AI Inference Service (e.g., for DeepSeek) uses a different path structure
			return new OpenAI({
				baseURL,
				apiKey,
				defaultHeaders: headers,
				defaultQuery: { "api-version": this.options.azureApiVersion || "2024-05-01-preview" },
				timeout,
			})
		} else if (isAzureOpenAi) {
			// Azure API shape slightly differs from the core API shape:
			// https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
			return new AzureOpenAI({
				baseURL,
				apiKey,
				apiVersion: this.options.azureApiVersion || azureOpenAiDefaultApiVersion,
				defaultHeaders: headers,
				timeout,
			})
		} else {
			return new OpenAI({
				baseURL,
				apiKey,
				defaultHeaders: headers,
				timeout,
			})
		}
	}

	/**
	 * Gets the client, creating it if necessary (lazy initialization).
	 */
	protected getClient(): OpenAI {
		if (!this.client) {
			this.client = this.createClient()
		}
		return this.client
	}

	/**
	 * Cancels the current in-flight request and optionally destroys the client.
	 *
	 * @param destroyClient - If true, nullify the client to force connection termination.
	 *                        The client will be lazily recreated on the next request.
	 */
	cancelRequest(destroyClient: boolean = false): void {
		// Abort any in-flight request
		if (this.abortController) {
			this.abortController.abort()
			this.abortController = undefined
		}

		// Optionally destroy the client to sever HTTP connections
		if (destroyClient && this.client) {
			this.client = null
		}
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { info: modelInfo, reasoning } = this.getModel()
		const modelUrl = this.options.openAiBaseUrl ?? ""
		const modelId = this.options.openAiModelId ?? ""
		const enabledR1Format = this.options.openAiR1FormatEnabled ?? false
		const isAzureAiInference = this._isAzureAiInference(modelUrl)
		const deepseekReasoner = modelId.includes("deepseek-reasoner") || enabledR1Format

		if (modelId.includes("o1") || modelId.includes("o3") || modelId.includes("o4")) {
			yield* this.handleO3FamilyMessage(modelId, systemPrompt, messages, metadata)
			return
		}

		let systemMessage: OpenAI.Chat.ChatCompletionSystemMessageParam = {
			role: "system",
			content: systemPrompt,
		}

		if (this.options.openAiStreamingEnabled ?? true) {
			let convertedMessages

			if (deepseekReasoner) {
				convertedMessages = convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
			} else {
				if (modelInfo.supportsPromptCache) {
					systemMessage = {
						role: "system",
						content: [
							{
								type: "text",
								text: systemPrompt,
								// @ts-ignore-next-line
								cache_control: { type: "ephemeral" },
							},
						],
					}
				}

				convertedMessages = [systemMessage, ...convertToOpenAiMessages(messages)]

				if (modelInfo.supportsPromptCache) {
					// Note: the following logic is copied from openrouter:
					// Add cache_control to the last two user messages
					// (note: this works because we only ever add one user message at a time, but if we added multiple we'd need to mark the user message before the last assistant message)
					const lastTwoUserMessages = convertedMessages.filter((msg) => msg.role === "user").slice(-2)

					lastTwoUserMessages.forEach((msg) => {
						if (typeof msg.content === "string") {
							msg.content = [{ type: "text", text: msg.content }]
						}

						if (Array.isArray(msg.content)) {
							// NOTE: this is fine since env details will always be added at the end. but if it weren't there, and the user added a image_url type message, it would pop a text part before it and then move it after to the end.
							let lastTextPart = msg.content.filter((part) => part.type === "text").pop()

							if (!lastTextPart) {
								lastTextPart = { type: "text", text: "..." }
								msg.content.push(lastTextPart)
							}

							// @ts-ignore-next-line
							lastTextPart["cache_control"] = { type: "ephemeral" }
						}
					})
				}
			}

			const isGrokXAI = this._isGrokXAI(this.options.openAiBaseUrl)

			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
				model: modelId,
				// Some OpenAI-Compatible models (e.g. claude-opus-4-7, claude-opus-4-8) reject
				// `temperature` as deprecated/unsupported, so honor the model's `supportsTemperature`
				// flag and omit it when that flag is false. Beyond that, only send `temperature` when
				// the user set a custom value or the model needs a specific default (deepseek-reasoner);
				// otherwise omit it so the server's own default applies instead of forcing 0.
				...(modelInfo.supportsTemperature !== false &&
					(this.options.modelTemperature != null || deepseekReasoner) && {
						temperature: this.options.modelTemperature ?? DEEP_SEEK_DEFAULT_TEMPERATURE,
					}),
				messages: convertedMessages,
				stream: true as const,
				...(isGrokXAI ? {} : { stream_options: { include_usage: true } }),
				...(reasoning && reasoning),
				tools: this.convertToolsForOpenAI(metadata?.tools),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			// Add GLM thinking parameter for GLM models (GLM-4.5, GLM-4.6, GLM-4.7, GLM-5)
			// when reasoning is enabled via settings
			this.addGLMThinkingIfNeeded(requestOptions as GLMChatCompletionParams, modelId, modelInfo)

			this.abortController = new AbortController()
			let stream
			try {
				stream = await this.getClient().chat.completions.create(requestOptions, {
					...(isAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
					signal: this.abortController.signal,
				})
			} catch (error) {
				this.abortController = undefined
				throw handleOpenAIError(error, this.providerName)
			}

			const matcher = new TagMatcher(
				["think", "thought"],
				(chunk) =>
					({
						type: chunk.matched ? "reasoning" : "text",
						text: chunk.data,
					}) as const,
			)

			let lastUsage
			const activeToolCallIds = new Set<string>()

			try {
				for await (const chunk of stream) {
					const delta = chunk.choices?.[0]?.delta ?? {}
					const finishReason = chunk.choices?.[0]?.finish_reason

					if (delta.content) {
						for (const chunk of matcher.update(delta.content)) {
							yield chunk
						}
					}

					const reasoningText = extractReasoningFromDelta(delta)
					if (reasoningText) {
						yield { type: "reasoning", text: reasoningText }
					}

					yield* this.processToolCalls(delta, finishReason, activeToolCallIds)

					if (chunk.usage) {
						lastUsage = chunk.usage
					}
				}

				for (const chunk of matcher.final()) {
					yield chunk
				}

				if (lastUsage) {
					yield this.processUsageMetrics(lastUsage, modelInfo)
				}
			} finally {
				this.abortController = undefined
			}
		} else {
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: modelId,
				messages: deepseekReasoner
					? convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
					: [systemMessage, ...convertToOpenAiMessages(messages)],
				// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS)
				tools: this.convertToolsForOpenAI(metadata?.tools),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			// Add GLM thinking parameter for GLM models (GLM-4.5, GLM-4.6, GLM-4.7, GLM-5)
			// when reasoning is enabled via settings
			this.addGLMThinkingIfNeeded(requestOptions as unknown as GLMChatCompletionParams, modelId, modelInfo)

			this.abortController = new AbortController()
			let response
			try {
				response = await this.getClient().chat.completions.create(requestOptions, {
					...(this._isAzureAiInference(modelUrl) ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
					signal: this.abortController.signal,
				})
			} catch (error) {
				this.abortController = undefined
				throw handleOpenAIError(error, this.providerName)
			} finally {
				this.abortController = undefined
			}

			const message = response.choices?.[0]?.message

			if (message?.tool_calls) {
				for (const toolCall of message.tool_calls) {
					if (toolCall.type === "function") {
						yield {
							type: "tool_call",
							id: toolCall.id,
							name: toolCall.function.name,
							arguments: toolCall.function.arguments,
						}
					}
				}
			}

			yield {
				type: "text",
				text: message?.content || "",
			}

			yield this.processUsageMetrics(response.usage, modelInfo)
		}
	}

	protected processUsageMetrics(usage: any, _modelInfo?: ModelInfo): ApiStreamUsageChunk {
		// Spike instrumentation: dump the endpoint's raw usage object so cache
		// reporting can be verified endpoint-by-endpoint (e.g. whether a local
		// vLLM server reports prefix-cache hits). Mirrors the same switch in
		// base-openai-compatible-provider.ts.
		if (process.env.ROO_LOG_RAW_USAGE === "1") {
			console.log(`[openai-compatible] raw usage: ${JSON.stringify(usage)}`)
		}

		// Cached prompt tokens are reported two different ways by OpenAI-compatible
		// servers: the OpenAI standard nests them under `prompt_tokens_details`
		// (vLLM, SGLang, LiteLLM, OpenAI itself), while Anthropic-style gateways
		// put them at the top level. Read the standard shape first and fall back
		// to the Anthropic-style fields, otherwise prefix-cache hits from a
		// self-hosted server are invisible to the client and always read as zero.
		// Both conventions include cached tokens in `prompt_tokens`, which is what
		// calculateApiCostOpenAI expects, so nothing is double-counted here.
		const cacheWriteTokens = usage?.prompt_tokens_details?.cache_write_tokens || usage?.cache_creation_input_tokens
		const cacheReadTokens = usage?.prompt_tokens_details?.cached_tokens || usage?.cache_read_input_tokens

		return {
			type: "usage",
			inputTokens: usage?.prompt_tokens || 0,
			outputTokens: usage?.completion_tokens || 0,
			cacheWriteTokens: cacheWriteTokens || undefined,
			cacheReadTokens: cacheReadTokens || undefined,
		}
	}

	override getModel() {
		const id = this.options.openAiModelId ?? ""
		const info: ModelInfo = this.options.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})
		return { id, info, ...params }
	}

	async completePrompt(prompt: string): Promise<string> {
		return (await this.completePromptWithUsage(prompt)).text
	}

	async completePromptWithUsage(prompt: string): Promise<CompletionResult> {
		try {
			const isAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)
			const model = this.getModel()
			const modelInfo = model.info

			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: model.id,
				messages: [{ role: "user", content: prompt }],
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			this.abortController = new AbortController()
			let response
			try {
				response = await this.getClient().chat.completions.create(requestOptions, {
					...(isAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
					signal: this.abortController.signal,
				})
			} catch (error) {
				throw handleOpenAIError(error, this.providerName)
			} finally {
				this.abortController = undefined
			}

			return {
				text: response.choices?.[0]?.message.content || "",
				usage: openAiCompletionUsage(response.usage),
			}
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`${this.providerName} completion error: ${error.message}`)
			}

			throw error
		}
	}

	private async *handleO3FamilyMessage(
		modelId: string,
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const modelInfo = this.getModel().info
		const methodIsAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)

		if (this.options.openAiStreamingEnabled ?? true) {
			const isGrokXAI = this._isGrokXAI(this.options.openAiBaseUrl)

			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
				model: modelId,
				messages: [
					{
						role: "developer",
						content: `Formatting re-enabled\n${systemPrompt}`,
					},
					...convertToOpenAiMessages(messages),
				],
				stream: true,
				...(isGrokXAI ? {} : { stream_options: { include_usage: true } }),
				reasoning_effort: modelInfo.reasoningEffort as "low" | "medium" | "high" | undefined,
				temperature: undefined,
				// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS)
				tools: this.convertToolsForOpenAI(metadata?.tools),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			// O3 family models do not support the deprecated max_tokens parameter
			// but they do support max_completion_tokens (the modern OpenAI parameter)
			// This allows O3 models to limit response length when includeMaxTokens is enabled
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			this.abortController = new AbortController()
			let stream
			try {
				stream = await this.getClient().chat.completions.create(requestOptions, {
					...(methodIsAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
					signal: this.abortController.signal,
				})
			} catch (error) {
				this.abortController = undefined
				throw handleOpenAIError(error, this.providerName)
			}

			try {
				yield* this.handleStreamResponse(stream)
			} finally {
				this.abortController = undefined
			}
		} else {
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: modelId,
				messages: [
					{
						role: "developer",
						content: `Formatting re-enabled\n${systemPrompt}`,
					},
					...convertToOpenAiMessages(messages),
				],
				reasoning_effort: modelInfo.reasoningEffort as "low" | "medium" | "high" | undefined,
				temperature: undefined,
				// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS)
				tools: this.convertToolsForOpenAI(metadata?.tools),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			// O3 family models do not support the deprecated max_tokens parameter
			// but they do support max_completion_tokens (the modern OpenAI parameter)
			// This allows O3 models to limit response length when includeMaxTokens is enabled
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			this.abortController = new AbortController()
			let response
			try {
				response = await this.getClient().chat.completions.create(requestOptions, {
					...(methodIsAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
					signal: this.abortController.signal,
				})
			} catch (error) {
				this.abortController = undefined
				throw handleOpenAIError(error, this.providerName)
			} finally {
				this.abortController = undefined
			}

			const message = response.choices?.[0]?.message
			if (message?.tool_calls) {
				for (const toolCall of message.tool_calls) {
					if (toolCall.type === "function") {
						yield {
							type: "tool_call",
							id: toolCall.id,
							name: toolCall.function.name,
							arguments: toolCall.function.arguments,
						}
					}
				}
			}

			yield {
				type: "text",
				text: message?.content || "",
			}
			yield this.processUsageMetrics(response.usage)
		}
	}

	private async *handleStreamResponse(stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>): ApiStream {
		const activeToolCallIds = new Set<string>()

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			const finishReason = chunk.choices?.[0]?.finish_reason

			if (delta) {
				if (delta.content) {
					yield {
						type: "text",
						text: delta.content,
					}
				}

				// AP-8: Extract reasoning_content/reasoning from the delta the
				// same way the main streaming path does, so reasoning-capable
				// servers routed through the O3 branch (DeepSeek-R1 distills,
				// QwQ behind adapters, etc.) surface reasoning output.
				const reasoningText = extractReasoningFromDelta(delta)
				if (reasoningText) {
					yield { type: "reasoning", text: reasoningText }
				}

				yield* this.processToolCalls(delta, finishReason, activeToolCallIds)
			}

			if (chunk.usage) {
				yield {
					type: "usage",
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0,
				}
			}
		}
	}

	/**
	 * Helper generator to process tool calls from a stream chunk.
	 * Tracks active tool call IDs and yields tool_call_partial and tool_call_end events.
	 * @param delta - The delta object from the stream chunk
	 * @param finishReason - The finish_reason from the stream chunk
	 * @param activeToolCallIds - Set to track active tool call IDs (mutated in place)
	 */
	private *processToolCalls(
		delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta | undefined,
		finishReason: string | null | undefined,
		activeToolCallIds: Set<string>,
	): Generator<
		| { type: "tool_call_partial"; index: number; id?: string; name?: string; arguments?: string }
		| { type: "tool_call_end"; id: string }
	> {
		if (delta?.tool_calls) {
			for (const toolCall of delta.tool_calls) {
				if (toolCall.id) {
					activeToolCallIds.add(toolCall.id)
				}
				yield {
					type: "tool_call_partial",
					index: toolCall.index,
					id: toolCall.id,
					name: toolCall.function?.name,
					arguments: toolCall.function?.arguments,
				}
			}
		}

		// Emit tool_call_end events when finish_reason is "tool_calls"
		// This ensures tool calls are finalized even if the stream doesn't properly close
		if (finishReason === "tool_calls" && activeToolCallIds.size > 0) {
			for (const id of activeToolCallIds) {
				yield { type: "tool_call_end", id }
			}
			activeToolCallIds.clear()
		}
	}

	protected _getUrlHost(baseUrl?: string): string {
		try {
			return new URL(baseUrl ?? "").host
		} catch (error) {
			return ""
		}
	}

	private _isGrokXAI(baseUrl?: string): boolean {
		const urlHost = this._getUrlHost(baseUrl)
		return urlHost.includes("x.ai")
	}

	protected _isAzureAiInference(baseUrl?: string): boolean {
		const urlHost = this._getUrlHost(baseUrl)
		return urlHost.endsWith(".services.ai.azure.com")
	}

	/**
	 * Adds max_completion_tokens to the request body if needed based on provider configuration
	 * Note: max_tokens is deprecated in favor of max_completion_tokens as per OpenAI documentation
	 * O3 family models handle max_tokens separately in handleO3FamilyMessage
	 */
	protected addMaxTokensIfNeeded(
		requestOptions:
			| OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
			| OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
		modelInfo: ModelInfo,
	): void {
		// Only add max_completion_tokens if includeMaxTokens is true
		if (this.options.includeMaxTokens === true) {
			// Use user-configured modelMaxTokens if available, otherwise fall back to model's default maxTokens
			// Using max_completion_tokens as max_tokens is deprecated
			requestOptions.max_completion_tokens = this.options.modelMaxTokens || modelInfo.maxTokens
		}
	}

	/**
	 * Adds GLM thinking parameter for GLM models (GLM-4.5, GLM-4.6, GLM-4.7, GLM-5)
	 * when used through custom OpenAI-compatible providers.
	 *
	 * GLM models support a `thinking` object with:
	 * - LOW budget: { type: "enabled" } - Basic thinking within the turn
	 * - MEDIUM budget: { type: "enabled", clear_thinking: false } - Turn-level/preserved thinking
	 * - Disabled: { type: "disabled" }
	 *
	 * @see https://docs.z.ai/guides/llm/glm-4.7
	 */
	protected addGLMThinkingIfNeeded(
		requestOptions: GLMChatCompletionParams,
		modelId: string,
		modelInfo: ModelInfo,
	): void {
		// Only apply to GLM models
		if (!isGLMThinkingModel(modelId)) {
			return
		}

		// Check if reasoning should be used based on model capabilities and settings
		const useReasoning = shouldUseReasoningEffort({ model: modelInfo, settings: this.options })

		if (useReasoning) {
			// Determine thinking level based on reasoningEffort setting
			// "medium" or higher = preserved thinking (clear_thinking: false)
			// "low" or default = basic thinking
			const reasoningEffort = this.options.reasoningEffort ?? modelInfo.reasoningEffort
			const useMediumOrHigher =
				reasoningEffort === "medium" || reasoningEffort === "high" || reasoningEffort === "xhigh"

			if (useMediumOrHigher) {
				// MEDIUM budget: preserved/turn-level thinking
				requestOptions.thinking = { type: "enabled", clear_thinking: false }
			} else {
				// LOW budget: basic thinking
				requestOptions.thinking = { type: "enabled" }
			}
		} else {
			// Reasoning is explicitly disabled
			// For GLM-4.7 and GLM-5, thinking is ON by default in the API,
			// so we need to explicitly disable it
			requestOptions.thinking = { type: "disabled" }
		}
	}
}

export async function getOpenAiModels(baseUrl?: string, apiKey?: string, openAiHeaders?: Record<string, string>) {
	try {
		if (!baseUrl) {
			return []
		}

		// Trim whitespace from baseUrl to handle cases where users accidentally include spaces
		const trimmedBaseUrl = baseUrl.trim()

		if (!URL.canParse(trimmedBaseUrl)) {
			return []
		}

		const config: Record<string, any> = {}
		const headers: Record<string, string> = {
			...DEFAULT_HEADERS,
			...(openAiHeaders || {}),
		}

		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		if (Object.keys(headers).length > 0) {
			config["headers"] = headers
		}

		const response = await axios.get(`${trimmedBaseUrl}/models`, config)
		const modelsArray = response.data?.data?.map((model: any) => model.id) || []
		return [...new Set<string>(modelsArray)]
	} catch (error) {
		return []
	}
}
