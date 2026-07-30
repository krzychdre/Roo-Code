/**
 * OpenAI-compatible provider base class using Vercel AI SDK.
 * This provides a parallel implementation to OpenAiHandler using @ai-sdk/openai-compatible.
 */

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { streamText, generateText, LanguageModel, ToolSet } from "ai"

import type { ModelInfo } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { convertToAiSdkMessages, convertToolsForAiSdk, processAiSdkStreamPart } from "../transform/ai-sdk"
import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"

import { DEFAULT_HEADERS } from "./constants"
import { BaseProvider } from "./base-provider"
import type { CompletionResult, SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { aiSdkCompletionUsage } from "./utils/completion-usage"

/**
 * Configuration options for creating an OpenAI-compatible provider.
 */
export interface OpenAICompatibleConfig {
	/** Provider name for identification */
	providerName: string
	/** Base URL for the API endpoint */
	baseURL: string
	/** API key for authentication */
	apiKey: string
	/** Model ID to use */
	modelId: string
	/** Model information */
	modelInfo: ModelInfo
	/** Optional custom headers */
	headers?: Record<string, string>
	/** Whether to include max_tokens in requests (default: false uses max_completion_tokens) */
	useMaxTokens?: boolean
	/** User-configured max tokens override */
	modelMaxTokens?: number
	/** Temperature setting */
	temperature?: number
}

/**
 * Base class for OpenAI-compatible API providers using Vercel AI SDK.
 * Extends BaseProvider and implements SingleCompletionHandler.
 */
export abstract class OpenAICompatibleHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	protected config: OpenAICompatibleConfig
	protected provider: ReturnType<typeof createOpenAICompatible>

	constructor(options: ApiHandlerOptions, config: OpenAICompatibleConfig) {
		super()
		this.options = options
		this.config = config

		// Create the OpenAI-compatible provider using AI SDK
		this.provider = createOpenAICompatible({
			name: config.providerName,
			baseURL: config.baseURL,
			apiKey: config.apiKey,
			headers: {
				...DEFAULT_HEADERS,
				...(config.headers || {}),
			},
		})
	}

	/**
	 * Get the language model for the configured model ID.
	 */
	protected getLanguageModel(): LanguageModel {
		return this.provider(this.config.modelId)
	}

	/**
	 * Get the model information. Must be implemented by subclasses.
	 */
	abstract override getModel(): { id: string; info: ModelInfo; maxTokens?: number; temperature?: number }

	/**
	 * Process usage metrics from the AI SDK response.
	 * Can be overridden by subclasses to handle provider-specific usage formats.
	 */
	protected processUsageMetrics(usage: {
		inputTokens?: number
		outputTokens?: number
		details?: {
			cachedInputTokens?: number
			reasoningTokens?: number
		}
		raw?: Record<string, unknown>
	}): ApiStreamUsageChunk {
		return {
			type: "usage",
			inputTokens: usage.inputTokens || 0,
			outputTokens: usage.outputTokens || 0,
			cacheReadTokens: usage.details?.cachedInputTokens,
			reasoningTokens: usage.details?.reasoningTokens,
		}
	}

	/**
	 * Map OpenAI tool_choice to AI SDK toolChoice format.
	 */
	protected mapToolChoice(
		toolChoice: OpenAI.Chat.ChatCompletionCreateParams["tool_choice"],
	): "auto" | "none" | "required" | { type: "tool"; toolName: string } | undefined {
		if (!toolChoice) {
			return undefined
		}

		// Handle string values
		if (typeof toolChoice === "string") {
			switch (toolChoice) {
				case "auto":
					return "auto"
				case "none":
					return "none"
				case "required":
					return "required"
				default:
					return "auto"
			}
		}

		// Handle object values (OpenAI ChatCompletionNamedToolChoice format)
		if (typeof toolChoice === "object" && "type" in toolChoice) {
			if (toolChoice.type === "function" && "function" in toolChoice && toolChoice.function?.name) {
				return { type: "tool", toolName: toolChoice.function.name }
			}
		}

		return undefined
	}

	/**
	 * Get the max tokens parameter to include in the request.
	 */
	protected getMaxOutputTokens(): number | undefined {
		const modelInfo = this.config.modelInfo
		const maxTokens = this.config.modelMaxTokens || modelInfo.maxTokens

		return maxTokens ?? undefined
	}

	/**
	 * Create a message stream using the AI SDK.
	 */
	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const model = this.getModel()
		const languageModel = this.getLanguageModel()

		// Convert messages to AI SDK format
		const aiSdkMessages = convertToAiSdkMessages(messages)

		// Convert tools to OpenAI format first, then to AI SDK format
		const openAiTools = this.convertToolsForOpenAI(metadata?.tools)
		const aiSdkTools = convertToolsForAiSdk(openAiTools) as ToolSet | undefined

		// Build the request options
		// Only include temperature if explicitly set (model.temperature or config.temperature)
		const temperature = model.temperature ?? this.config.temperature
		const requestOptions: Parameters<typeof streamText>[0] = {
			model: languageModel,
			system: systemPrompt,
			messages: aiSdkMessages,
			...(temperature !== undefined && { temperature }),
			maxOutputTokens: this.getMaxOutputTokens(),
			tools: aiSdkTools,
			toolChoice: this.mapToolChoice(metadata?.tool_choice),
		}

		// Use streamText for streaming responses
		const result = streamText(requestOptions)

		// Track assistant text for fallback token counting (AP-4)
		let assistantText = ""

		// Process the full stream to get all events
		for await (const part of result.fullStream) {
			// Use the processAiSdkStreamPart utility to convert stream parts
			for (const chunk of processAiSdkStreamPart(part)) {
				// Accumulate text chunks for fallback usage computation
				if (chunk.type === "text") {
					assistantText += chunk.text
				}
				yield chunk
			}
		}

		// Yield usage metrics at the end (AP-4: always yield exactly one usage chunk)
		const usage = await result.usage
		const hasRealUsage = usage && ((usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0)

		if (hasRealUsage) {
			yield this.processUsageMetrics(usage!)
		} else {
			// Fallback: compute tokens locally when server omits usage or returns all-zero.
			// Many local/weak OpenAI-compatible servers (llama.cpp, Ollama, LM Studio)
			// omit the usage block entirely even when stream_options.include_usage is set.
			// Mirror lm-studio.ts approach with try/catch-to-0 error handling.
			let inputTokens = 0
			try {
				const inputContent: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: systemPrompt }]
				for (const msg of messages) {
					if (typeof msg.content === "string") {
						inputContent.push({ type: "text", text: msg.content })
					} else if (Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (block.type === "text") {
								inputContent.push({ type: "text", text: block.text })
							}
						}
					}
				}
				inputTokens = await this.countTokens(inputContent)
			} catch (err) {
				console.error(`[${this.config.providerName}] Failed to count input tokens:`, err)
				inputTokens = 0
			}

			let outputTokens = 0
			if (assistantText) {
				try {
					outputTokens = await this.countTokens([{ type: "text", text: assistantText }])
				} catch (err) {
					console.error(`[${this.config.providerName}] Failed to count output tokens:`, err)
					outputTokens = 0
				}
			}

			yield {
				type: "usage",
				inputTokens,
				outputTokens,
			} as const
		}
	}

	/**
	 * Complete a prompt using the AI SDK generateText.
	 */
	async completePrompt(prompt: string): Promise<string> {
		return (await this.completePromptWithUsage(prompt)).text
	}

	async completePromptWithUsage(prompt: string): Promise<CompletionResult> {
		const languageModel = this.getLanguageModel()

		// Only include temperature if explicitly set
		const temperature = this.config.temperature
		const { text, usage } = await generateText({
			model: languageModel,
			prompt,
			maxOutputTokens: this.getMaxOutputTokens(),
			...(temperature !== undefined && { temperature }),
		})

		return { text, usage: aiSdkCompletionUsage(usage) }
	}
}
