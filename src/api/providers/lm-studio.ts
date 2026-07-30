import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import axios from "axios"

import { type ModelInfo, openAiModelInfoSaneDefaults, LMSTUDIO_DEFAULT_TEMPERATURE } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { TagMatcher } from "../../utils/tag-matcher"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"

import { BaseProvider } from "./base-provider"
import type { CompletionResult, SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { openAiCompletionUsage } from "./utils/completion-usage"
import { getModelsFromCache } from "./fetchers/modelCache"
import { getApiRequestTimeout } from "./utils/timeout-config"
import { handleOpenAIError } from "./utils/openai-error-handler"
import { emitToolCallChunks, emitFinishReasonChunk } from "./utils/openai-stream-chunks"

export class LmStudioHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: OpenAI | null = null
	private abortController?: AbortController
	private readonly providerName = "LM Studio"

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options

		// LM Studio uses "noop" as a placeholder API key
		const apiKey = "noop"

		this.client = new OpenAI({
			baseURL: (this.options.lmStudioBaseUrl || "http://localhost:1234") + "/v1",
			apiKey: apiKey,
			timeout: getApiRequestTimeout(),
		})
	}

	/**
	 * Gets the client, recreating it if it was previously destroyed.
	 */
	private getClient(): OpenAI {
		if (!this.client) {
			this.client = new OpenAI({
				baseURL: (this.options.lmStudioBaseUrl || "http://localhost:1234") + "/v1",
				apiKey: "noop",
				timeout: getApiRequestTimeout(),
			})
		}
		return this.client
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

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		// -------------------------
		// Track token usage
		// -------------------------
		const toContentBlocks = (
			blocks: Anthropic.Messages.MessageParam[] | string,
		): Anthropic.Messages.ContentBlockParam[] => {
			if (typeof blocks === "string") {
				return [{ type: "text", text: blocks }]
			}

			const result: Anthropic.Messages.ContentBlockParam[] = []
			for (const msg of blocks) {
				if (typeof msg.content === "string") {
					result.push({ type: "text", text: msg.content })
				} else if (Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === "text") {
							result.push({ type: "text", text: part.text })
						}
					}
				}
			}
			return result
		}

		let inputTokens = 0
		try {
			inputTokens = await this.countTokens([{ type: "text", text: systemPrompt }, ...toContentBlocks(messages)])
		} catch (err) {
			console.error("[LmStudio] Failed to count input tokens:", err)
			inputTokens = 0
		}

		let assistantText = ""

		try {
			const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & { draft_model?: string } = {
				model: this.getModel().id,
				messages: openAiMessages,
				temperature: this.options.modelTemperature ?? LMSTUDIO_DEFAULT_TEMPERATURE,
				stream: true,
				tools: this.convertToolsForOpenAI(metadata?.tools),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			if (this.options.lmStudioSpeculativeDecodingEnabled && this.options.lmStudioDraftModelId) {
				params.draft_model = this.options.lmStudioDraftModelId
			}

			this.abortController = new AbortController()
			let results
			try {
				results = await this.getClient().chat.completions.create(params, {
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

			try {
				for await (const chunk of results) {
					const delta = chunk.choices?.[0]?.delta
					const finishReason = chunk.choices?.[0]?.finish_reason

					if (delta?.content) {
						assistantText += delta.content
						for (const processedChunk of matcher.update(delta.content)) {
							yield processedChunk
						}
					}

					// Handle tool calls in stream - emit partial chunks for NativeToolCallParser
					yield* emitToolCallChunks(delta)

					// Yield finish_reason so TaskStreamProcessor can handle it with per-task parser state
					yield* emitFinishReasonChunk(finishReason)
				}

				for (const processedChunk of matcher.final()) {
					yield processedChunk
				}

				let outputTokens = 0
				try {
					outputTokens = await this.countTokens([{ type: "text", text: assistantText }])
				} catch (err) {
					console.error("[LmStudio] Failed to count output tokens:", err)
					outputTokens = 0
				}

				yield {
					type: "usage",
					inputTokens,
					outputTokens,
				} as const
			} finally {
				this.abortController = undefined
			}
		} catch (error) {
			throw new Error(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Roo Code's prompts.",
			)
		}
	}

	override getModel(): { id: string; info: ModelInfo } {
		const models = getModelsFromCache("lmstudio")
		if (models && this.options.lmStudioModelId && models[this.options.lmStudioModelId]) {
			return {
				id: this.options.lmStudioModelId,
				info: models[this.options.lmStudioModelId],
			}
		} else {
			return {
				id: this.options.lmStudioModelId || "",
				info: openAiModelInfoSaneDefaults,
			}
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		return (await this.completePromptWithUsage(prompt)).text
	}

	async completePromptWithUsage(prompt: string): Promise<CompletionResult> {
		try {
			// Create params object with optional draft model
			const params: any = {
				model: this.getModel().id,
				messages: [{ role: "user", content: prompt }],
				temperature: this.options.modelTemperature ?? LMSTUDIO_DEFAULT_TEMPERATURE,
				stream: false,
			}

			// Add draft model if speculative decoding is enabled and a draft model is specified
			if (this.options.lmStudioSpeculativeDecodingEnabled && this.options.lmStudioDraftModelId) {
				params.draft_model = this.options.lmStudioDraftModelId
			}

			this.abortController = new AbortController()
			let response
			try {
				response = await this.getClient().chat.completions.create(params, {
					signal: this.abortController.signal,
				})
			} catch (error) {
				throw handleOpenAIError(error, this.providerName)
			} finally {
				this.abortController = undefined
			}
			return {
				text: response.choices?.[0]?.message?.content || "",
				usage: openAiCompletionUsage(response.usage),
			}
		} catch (error) {
			throw new Error(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Roo Code's prompts.",
			)
		}
	}
}

export async function getLmStudioModels(baseUrl = "http://localhost:1234") {
	try {
		if (!URL.canParse(baseUrl)) {
			return []
		}

		const response = await axios.get(`${baseUrl}/v1/models`)
		const modelsArray = response.data?.data?.map((model: any) => model.id) || []
		return [...new Set<string>(modelsArray)]
	} catch (error) {
		return []
	}
}
