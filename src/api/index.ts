import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { classifyProvider, type ProviderSettings, type ModelInfo } from "@roo-code/types"

import { ApiStream } from "./transform/stream"
import {
	defaultRuntimeProviderId,
	getRuntimeProviderFactory,
	runtimeProviderRegistry,
} from "./runtime-provider-registry"

/**
 * What a one-shot completion cost, as the provider reported it.
 *
 * Optional throughout: not every provider returns a usage block, and an absent
 * figure must stay absent rather than become a zero that quietly lands in a
 * total. `cacheReadTokens`/`cacheWriteTokens` follow the same convention as the
 * streaming path — for OpenAI-protocol providers the cached part is already
 * inside `inputTokens`.
 */
export interface CompletionUsage {
	inputTokens: number
	outputTokens: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
	totalCost?: number
}

/**
 * A one-shot completion plus what it cost.
 */
export interface CompletionResult {
	text: string
	usage?: CompletionUsage
}

export interface SingleCompletionHandler {
	completePrompt(prompt: string): Promise<string>
	/**
	 * The same call, reporting what it cost.
	 *
	 * `completePrompt` returns a bare string, so every one-shot call the
	 * extension makes off the main task loop — enhancing a prompt, ranking
	 * memories — threw its token usage away and appeared nowhere in the usage
	 * metrics, while still costing real prompt processing on the server.
	 *
	 * Providers implement this and let `completePrompt` delegate to it, so the
	 * request itself is unchanged. Optional so that an implementation which has
	 * not been converted (or lives outside this repo) still works; callers go
	 * through `runCompletion`, which falls back and reports the usage as
	 * unknown rather than as zero.
	 */
	completePromptWithUsage?(prompt: string): Promise<CompletionResult>
}

export interface ApiHandlerCreateMessageMetadata {
	/**
	 * Task ID used for tracking and provider-specific features:
	 * - Requesty: Sent as trace_id
	 */
	taskId: string
	/**
	 * Current mode slug for provider-specific tracking:
	 * - Requesty: Sent in extra metadata
	 */
	mode?: string
	suppressPreviousResponseId?: boolean
	/**
	 * Controls whether the response should be stored for 30 days in OpenAI's Responses API.
	 * When true (default), responses are stored and can be referenced in future requests
	 * using the previous_response_id for efficient conversation continuity.
	 * Set to false to opt out of response storage for privacy or compliance reasons.
	 * @default true
	 */
	store?: boolean
	/**
	 * Optional array of tool definitions to pass to the model.
	 * For OpenAI-compatible providers, these are ChatCompletionTool definitions.
	 */
	tools?: OpenAI.Chat.ChatCompletionTool[]
	/**
	 * Controls which (if any) tool is called by the model.
	 * Can be "none", "auto", "required", or a specific tool choice.
	 */
	tool_choice?: OpenAI.Chat.ChatCompletionCreateParams["tool_choice"]
	/**
	 * Controls whether the model can return multiple tool calls in a single response.
	 * When true (default), parallel tool calls are enabled (OpenAI's parallel_tool_calls=true).
	 * When false, only one tool call is returned per response.
	 */
	parallelToolCalls?: boolean
	/**
	 * Optional array of tool names that the model is allowed to call.
	 * When provided, all tool definitions are passed to the model (so it can reference
	 * historical tool calls), but only the specified tools can actually be invoked.
	 * This is used when switching modes to prevent model errors from missing tool
	 * definitions while still restricting callable tools to the current mode's permissions.
	 * Only applies to providers that support function calling restrictions (e.g., Gemini).
	 */
	allowedFunctionNames?: string[]
}

export interface ApiHandler {
	createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream

	getModel(): { id: string; info: ModelInfo }

	/**
	 * Counts tokens for content blocks
	 * All providers extend BaseProvider which provides a default tiktoken implementation,
	 * but they can override this to use their native token counting endpoints
	 *
	 * @param content The content to count tokens for
	 * @returns A promise resolving to the token count
	 */
	countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number>

	/**
	 * Cancels the current in-flight request and optionally destroys the client.
	 * This allows providers to perform provider-specific cleanup when a request is cancelled.
	 * For local models, this can include destroying the SDK client to sever HTTP connections.
	 *
	 * @param destroyClient - If true, destroy and recreate the client to force connection termination
	 */
	cancelRequest?(destroyClient?: boolean): void
}

export function buildApiHandler(configuration: ProviderSettings): ApiHandler {
	const { apiProvider, ...options } = configuration
	const providerId = apiProvider ?? defaultRuntimeProviderId
	const classification = classifyProvider(providerId)

	if (classification === "retired" || classification === "unknown") {
		throw new ProviderUnavailableError(providerId, classification)
	}

	const providerFactory = getRuntimeProviderFactory(providerId) ?? runtimeProviderRegistry[defaultRuntimeProviderId]

	return providerFactory(options)
}

export class ProviderUnavailableError extends Error {
	readonly code = "PROVIDER_UNAVAILABLE"

	constructor(
		readonly providerId: string,
		readonly classification: "retired" | "unknown",
	) {
		super(
			classification === "retired"
				? `Sorry, provider "${providerId}" is no longer supported. Please select a different provider in your API profile settings.`
				: `Provider "${providerId}" is unknown to this version and cannot be executed.`,
		)
		this.name = "ProviderUnavailableError"
	}
}
