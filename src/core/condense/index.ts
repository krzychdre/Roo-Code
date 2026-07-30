import Anthropic from "@anthropic-ai/sdk"
import crypto from "crypto"

import { TelemetryService } from "@roo-code/telemetry"

import { t } from "../../i18n"
import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import { ApiMessage } from "../task-persistence/apiMessages"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import { findLast } from "../../shared/array"
import { supportPrompt } from "../../shared/support-prompt"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import type { ContextLedger } from "../context-management/ledger/types"
import { generateFoldedFileContext } from "./foldedFileContext"
import { validateSummaryFacts } from "./factValidation"

export type { FoldedFileContextResult, FoldedFileContextOptions } from "./foldedFileContext"
export * from "./factValidation"

/**
 * Converts a tool_use block to a text representation.
 * This allows the conversation to be summarized without requiring the tools parameter.
 */
export function toolUseToText(block: Anthropic.Messages.ToolUseBlockParam): string {
	let input: string
	if (typeof block.input === "object" && block.input !== null) {
		input = Object.entries(block.input)
			.map(([key, value]) => {
				const formattedValue =
					typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : String(value)
				return `${key}: ${formattedValue}`
			})
			.join("\n")
	} else {
		input = String(block.input)
	}
	return `[Tool Use: ${block.name}]\n${input}`
}

/**
 * Converts a tool_result block to a text representation.
 * This allows the conversation to be summarized without requiring the tools parameter.
 */
export function toolResultToText(block: Anthropic.Messages.ToolResultBlockParam): string {
	const errorSuffix = block.is_error ? " (Error)" : ""
	if (typeof block.content === "string") {
		return `[Tool Result${errorSuffix}]\n${block.content}`
	} else if (Array.isArray(block.content)) {
		const contentText = block.content
			.map((contentBlock) => {
				if (contentBlock.type === "text") {
					return contentBlock.text
				}
				if (contentBlock.type === "image") {
					return "[Image]"
				}
				// Handle any other content block types
				return `[${(contentBlock as { type: string }).type}]`
			})
			.join("\n")
		return `[Tool Result${errorSuffix}]\n${contentText}`
	}
	return `[Tool Result${errorSuffix}]`
}

/**
 * Converts all tool_use and tool_result blocks in a message's content to text representations.
 * This is necessary for providers like Bedrock that require the tools parameter when tool blocks are present.
 * By converting to text, we can send the conversation for summarization without the tools parameter.
 *
 * @param content - The message content (string or array of content blocks)
 * @returns The transformed content with tool blocks converted to text blocks
 */
export function convertToolBlocksToText(
	content: string | Anthropic.Messages.ContentBlockParam[],
): string | Anthropic.Messages.ContentBlockParam[] {
	if (typeof content === "string") {
		return content
	}

	return content.map((block) => {
		if (block.type === "tool_use") {
			return {
				type: "text" as const,
				text: toolUseToText(block),
			}
		}
		if (block.type === "tool_result") {
			return {
				type: "text" as const,
				text: toolResultToText(block),
			}
		}
		return block
	})
}

/**
 * Transforms all messages by converting tool_use and tool_result blocks to text representations.
 * This ensures the conversation can be sent for summarization without requiring the tools parameter.
 *
 * @param messages - The messages to transform
 * @returns The transformed messages with tool blocks converted to text
 */
export function transformMessagesForCondensing<
	T extends { role: string; content: string | Anthropic.Messages.ContentBlockParam[] },
>(messages: T[]): T[] {
	return messages.map((msg) => ({
		...msg,
		content: convertToolBlocksToText(msg.content),
	}))
}

export const MIN_CONDENSE_THRESHOLD = 5 // Minimum percentage of context window to trigger condensing
export const MAX_CONDENSE_THRESHOLD = 100 // Maximum percentage of context window to trigger condensing

/**
 * How many of the most-recent messages to keep RAW (verbatim) in the effective
 * history after a full condense, instead of collapsing to the summary alone.
 * ~3 native tool turns (assistant tool_use + user tool_result = 2 messages each),
 * i.e. the model's immediate working set. Keeping these intact lets work continue
 * seamlessly after a condense — the exact recent tool calls / results / decisions
 * survive, not just the lossy paraphrase.
 */
export const CONDENSE_KEEP_RECENT_MESSAGES = 6

/**
 * The recent raw tail is only kept when the since-last-summary region is at least
 * `CONDENSE_KEEP_RECENT_MESSAGES + CONDENSE_MIN_SUMMARIZED_MESSAGES` long, so that
 * summarizing the older prefix still yields a worthwhile reduction. On smaller
 * histories the classic fresh-start (summarize everything, no tail) is used.
 */
export const CONDENSE_MIN_SUMMARIZED_MESSAGES = 4

const SUMMARY_PROMPT = `You are a helpful AI assistant tasked with summarizing conversations.

CRITICAL: This is a summarization-only request. DO NOT call any tools or functions.
Your ONLY task is to analyze the conversation and produce a text summary.
Respond with text only - no tool calls will be processed.

CRITICAL: This summarization request is a SYSTEM OPERATION, not a user message.
When analyzing "user requests" and "user intent", completely EXCLUDE this summarization message.
The "most recent user request" and "next step" must be based on what the user was doing BEFORE this system message appeared.
The goal is for work to continue seamlessly after condensation - as if it never happened.`

/**
 * Injects synthetic tool_results for orphan tool_calls that don't have matching results.
 * This is necessary because OpenAI's Responses API rejects conversations with orphan tool_calls.
 * This can happen when the user triggers condense after receiving a tool_call (like attempt_completion)
 * but before responding to it.
 *
 * @param messages - The conversation messages to process
 * @returns The messages with synthetic tool_results appended if needed
 */
export function injectSyntheticToolResults(messages: ApiMessage[]): ApiMessage[] {
	// Find all tool_call IDs in assistant messages
	const toolCallIds = new Set<string>()
	// Find all tool_result IDs in user messages
	const toolResultIds = new Set<string>()

	for (const msg of messages) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_use") {
					toolCallIds.add(block.id)
				}
			}
		}
		if (msg.role === "user" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_result") {
					toolResultIds.add(block.tool_use_id)
				}
			}
		}
	}

	// Find orphans (tool_calls without matching tool_results)
	const orphanIds = [...toolCallIds].filter((id) => !toolResultIds.has(id))

	if (orphanIds.length === 0) {
		return messages
	}

	// Inject synthetic tool_results as a new user message
	const syntheticResults: Anthropic.Messages.ToolResultBlockParam[] = orphanIds.map((id) => ({
		type: "tool_result" as const,
		tool_use_id: id,
		content: "Context condensation triggered. Tool execution deferred.",
	}))

	const syntheticMessage: ApiMessage = {
		role: "user",
		content: syntheticResults,
		ts: Date.now(),
	}

	return [...messages, syntheticMessage]
}

/**
 * Extracts <command> blocks from a message's content.
 * These blocks represent active workflows that must be preserved across condensings.
 *
 * @param message - The message to extract command blocks from
 * @returns A string containing all command blocks found, or empty string if none
 */
export function extractCommandBlocks(message: ApiMessage): string {
	const content = message.content
	let text: string

	if (typeof content === "string") {
		text = content
	} else if (Array.isArray(content)) {
		// Concatenate all text blocks
		text = content
			.filter((block): block is Anthropic.Messages.TextBlockParam => block.type === "text")
			.map((block) => block.text)
			.join("\n")
	} else {
		return ""
	}

	// Match all <command> blocks including their content
	const commandRegex = /<command[^>]*>[\s\S]*?<\/command>/g
	const matches = text.match(commandRegex)

	if (!matches || matches.length === 0) {
		return ""
	}

	return matches.join("\n")
}

export type SummarizeResponse = {
	messages: ApiMessage[] // The messages after summarization
	summary: string // The summary text; empty string for no summary
	cost: number // The cost of the summarization operation
	newContextTokens?: number // The number of tokens in the context for the next API request
	error?: string // Populated iff the operation fails: error message shown to the user on failure (see Task.ts)
	errorDetails?: string // Detailed error information including stack trace and API error info
	condenseId?: string // The unique ID of the created Summary message, for linking to condense_context clineMessage
	factsChecked?: number // Critical ledger facts the summary was validated against (0 when no ledger was supplied)
	factsRecovered?: number // Critical facts the summary dropped and the addendum restored
}

export type SummarizeConversationOptions = {
	messages: ApiMessage[]
	apiHandler: ApiHandler
	systemPrompt: string
	taskId: string
	isAutomaticTrigger?: boolean
	customCondensingPrompt?: string
	metadata?: ApiHandlerCreateMessageMetadata
	environmentDetails?: string
	filesReadByRoo?: string[]
	cwd?: string
	rooIgnoreController?: RooIgnoreController
	/**
	 * Deterministic state ledger for the history being condensed. When supplied, the summary is
	 * checked against its critical facts and anything the model dropped is appended verbatim.
	 * Passed in rather than built here so the caller can share the single build it already does
	 * for microcompaction — and so this module keeps no dependency on the ledger builder, which
	 * imports `getEffectiveApiHistory` from here.
	 */
	ledger?: ContextLedger
}

/**
 * Summarizes the conversation messages using an LLM call.
 *
 * This implements the "fresh start" model where:
 * - The summary becomes a user message (not assistant)
 * - Post-condense, the model sees only the summary (true fresh start)
 * - All messages are still stored but tagged with condenseParent
 * - <command> blocks from the original task are preserved across condensings
 * - File context (folded code definitions) can be preserved for continuity
 *
 * Environment details handling:
 * - For AUTOMATIC condensing (isAutomaticTrigger=true): Environment details are included
 *   in the summary because the API request is already in progress and the next user
 *   message won't have fresh environment details injected.
 * - For MANUAL condensing (isAutomaticTrigger=false): Environment details are NOT included
 *   because fresh environment details will be injected on the very next turn via
 *   getEnvironmentDetails() in recursivelyMakeClineRequests().
 */

/** What a condense call cost, as the provider reported it. */
type CondenseUsage = {
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	totalCost?: number
}

/**
 * Report a condense call to the usage metrics.
 *
 * Condensing is a full API request — often the largest single request a long
 * task makes, since it sends the whole history — and it used to be recorded
 * only as "Context Condensed", an event with no figures. It is emitted here
 * with its own kind so the console can show what the machinery around the
 * conversation costs, separately from the conversation.
 *
 * The model is stated explicitly: telemetry otherwise labels an event with the
 * *current task's* model, and condensing routinely runs on its own profile (see
 * BackgroundModelHandler).
 */
function reportCondenseUsage(taskId: string, handler: ApiHandler, usage: CondenseUsage | undefined): void {
	if (!TelemetryService.hasInstance()) {
		return
	}
	const model = handler.getModel?.()
	TelemetryService.instance.captureLlmCompletion(taskId, {
		inputTokens: usage?.inputTokens ?? 0,
		outputTokens: usage?.outputTokens ?? 0,
		cacheReadTokens: usage?.cacheReadTokens ?? 0,
		cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
		cost: usage?.totalCost,
		completionKind: "condense",
		usageReported: usage !== undefined,
		...(model?.id && { modelId: model.id }),
	})
}

/**
 * Stream a condense summary from `handler`, accumulating text/usage chunks.
 *
 * With the deep-rewrite `BackgroundModelHandler`, mid-stream fallback is
 * handled INSIDE the wrapper (it buffers the background stream and replays on
 * the fallback on a trigger error, discarding partial output). This function
 * therefore only sees the final, seamless stream and does not need its own
 * fallback retry — any error that reaches here is either a non-trigger (abort
 * / programmer error) or a foreground failure on a passthrough, both of which
 * must surface via the error-shaping path.
 *
 * Returns the trimmed summary plus accumulated cost/outputTokens. Throws on
 * stream errors, but attaches the partial cost accumulated so far as
 * `error.partialCost` so the caller can still account for spend from a failed
 * attempt (Claim 7: failed-condense cost must not be silently lost).
 */
async function streamSummary(
	handler: ApiHandler,
	promptToUse: string,
	requestMessages: Anthropic.Messages.MessageParam[],
	metadata: ApiHandlerCreateMessageMetadata | undefined,
): Promise<{ summary: string; cost: number; outputTokens: number; usage?: CondenseUsage }> {
	let summary = ""
	let cost = 0
	let outputTokens = 0
	let usage: CondenseUsage | undefined
	const stream = handler.createMessage(promptToUse, requestMessages, metadata)
	try {
		for await (const chunk of stream) {
			if (chunk.type === "text") {
				summary += chunk.text
			} else if (chunk.type === "usage") {
				// Accumulate usage: providers emit usage once at stream end
				// (OpenAI-family) or at message_delta boundaries (Anthropic).
				// Overwriting keeps the LAST usage chunk's totals, which for
				// end-of-stream providers is the full cost and for Anthropic
				// is the running cumulative total (Anthropic's message_delta
				// usage is cumulative). Either way the final value is correct.
				cost = chunk.totalCost ?? 0
				outputTokens = chunk.outputTokens ?? 0
				// Everything the chunk reports, not only the two fields the
				// summary itself needs: condensing is a real API call on a real
				// model and has to be accountable in the usage metrics like any
				// other. Keeping only cost/outputTokens is what made it invisible.
				usage = {
					inputTokens: chunk.inputTokens ?? 0,
					outputTokens: chunk.outputTokens ?? 0,
					cacheReadTokens: chunk.cacheReadTokens ?? 0,
					cacheWriteTokens: chunk.cacheWriteTokens ?? 0,
					totalCost: chunk.totalCost,
				}
			}
		}
	} catch (error) {
		// Attach the partial cost so the caller can account for spend from the
		// failed attempt. Anthropic emits usage mid-stream, so a failure after
		// a message_delta may have captured real spend that must not be lost.
		if (error instanceof Error && cost > 0) {
			;(error as Error & { partialCost?: number }).partialCost = cost
		}
		throw error
	}
	return { summary: summary.trim(), cost, outputTokens, usage }
}

export async function summarizeConversation(options: SummarizeConversationOptions): Promise<SummarizeResponse> {
	const {
		messages,
		apiHandler,
		systemPrompt,
		taskId,
		isAutomaticTrigger,
		customCondensingPrompt,
		metadata,
		environmentDetails,
		filesReadByRoo,
		cwd,
		rooIgnoreController,
		ledger,
	} = options
	TelemetryService.instance.captureContextCondensed(
		taskId,
		isAutomaticTrigger ?? false,
		!!customCondensingPrompt?.trim(),
	)

	const response: SummarizeResponse = { messages, cost: 0, summary: "" }

	// Get messages to summarize (all messages since the last summary, if any)
	const messagesToSummarize = getMessagesSinceLastSummary(messages)

	if (messagesToSummarize.length <= 1) {
		const error =
			messages.length <= 1
				? t("common:errors.condense_not_enough_messages")
				: t("common:errors.condensed_recently")
		return { ...response, error }
	}

	// Check if there's a recent summary in the messages (edge case)
	const recentSummaryExists = messagesToSummarize.some((message: ApiMessage) => message.isSummary)

	if (recentSummaryExists && messagesToSummarize.length <= 2) {
		const error = t("common:errors.condensed_recently")
		return { ...response, error }
	}

	// Use custom prompt if provided and non-empty, otherwise use the default CONDENSE prompt
	// This respects user's custom condensing prompt setting
	const condenseInstructions = customCondensingPrompt?.trim() || supportPrompt.default.CONDENSE

	const finalRequestMessage: Anthropic.MessageParam = {
		role: "user",
		content: condenseInstructions,
	}

	// Inject synthetic tool_results for orphan tool_calls to prevent API rejections
	// (e.g., when user triggers condense after receiving attempt_completion but before responding)
	const messagesWithToolResults = injectSyntheticToolResults(messagesToSummarize)

	// Transform tool_use and tool_result blocks to text representations.
	// This is necessary because some providers (like Bedrock via LiteLLM) require the `tools` parameter
	// when tool blocks are present. By converting them to text, we can send the conversation for
	// summarization without needing to pass the tools parameter.
	const messagesWithTextToolBlocks = transformMessagesForCondensing(
		maybeRemoveImageBlocks([...messagesWithToolResults, finalRequestMessage], apiHandler),
	)

	const requestMessages = messagesWithTextToolBlocks.map(({ role, content }) => ({ role, content }))

	// Note: this doesn't need to be a stream, consider using something like apiHandler.completePrompt
	const promptToUse = SUMMARY_PROMPT

	// Validate that the API handler supports message creation
	if (!apiHandler || typeof apiHandler.createMessage !== "function") {
		console.error("API handler is invalid for condensing. Cannot proceed.")
		const error = t("common:errors.condense_handler_invalid")
		return { ...response, error }
	}

	let summary = ""
	let cost = 0
	let outputTokens = 0

	// Background-model fallback is handled INSIDE the BackgroundModelHandler
	// wrapper (it buffers the background stream and, on a trigger error
	// mid-flight, discards the partial output and replays the producer against
	// the fallback). Any error that reaches this catch is therefore either a
	// non-trigger (abort / programmer error) or a genuine foreground failure
	// on a passthrough — both must surface via the error-shaping path so
	// cancellations still cancel condense. There is no bespoke retry here; the
	// wrapper is the single source of fallback policy and every consumer
	// (condense, memory, future features) gets it for free.
	try {
		const result = await streamSummary(apiHandler, promptToUse, requestMessages, metadata)
		summary = result.summary
		cost = result.cost
		outputTokens = result.outputTokens
		reportCondenseUsage(taskId, apiHandler, result.usage)
	} catch (error) {
		// Capture partial cost from the failed attempt (Claim 7: failed-condense
		// spend must not be silently lost — Anthropic emits usage mid-stream).
		const partialCost = (error as Error & { partialCost?: number })?.partialCost
		if (typeof partialCost === "number" && partialCost > 0) cost = partialCost

		console.error("Error during condensing API call:", error)
		const errorMessage = error instanceof Error ? error.message : String(error)

		// Capture detailed error information for debugging
		let errorDetails = ""
		if (error instanceof Error) {
			errorDetails = `Error: ${error.message}`
			// Capture any additional API error properties
			const anyError = error as unknown as Record<string, unknown>
			if (anyError.status) {
				errorDetails += `\n\nHTTP Status: ${anyError.status}`
			}
			if (anyError.code) {
				errorDetails += `\nError Code: ${anyError.code}`
			}
			if (anyError.response) {
				try {
					errorDetails += `\n\nAPI Response:\n${JSON.stringify(anyError.response, null, 2)}`
				} catch {
					errorDetails += `\n\nAPI Response: [Unable to serialize]`
				}
			}
			if (anyError.body) {
				try {
					errorDetails += `\n\nResponse Body:\n${JSON.stringify(anyError.body, null, 2)}`
				} catch {
					errorDetails += `\n\nResponse Body: [Unable to serialize]`
				}
			}
		} else {
			errorDetails = String(error)
		}

		return {
			...response,
			cost,
			error: t("common:errors.condense_api_failed", { message: errorMessage }),
			errorDetails,
		}
	}

	summary = summary.trim()

	if (summary.length === 0) {
		const error = t("common:errors.condense_failed")
		return { ...response, cost, error }
	}

	// Extract command blocks from the first message (original task)
	// These represent active workflows that must persist across condensings
	const firstMessage = messages[0]
	const commandBlocks = firstMessage ? extractCommandBlocks(firstMessage) : ""

	// Computed here rather than at the rewrite below because the fact check needs to know what
	// survives the condense verbatim: a fact still sitting in the kept raw tail was never at risk.
	const keepBoundary = computeCondenseKeepBoundary(messages)
	const recentTail = messages.slice(keepBoundary)

	// Build the summary content as separate text blocks
	const summaryContent: Anthropic.Messages.ContentBlockParam[] = [
		{ type: "text", text: `## Conversation Summary\n${summary}` },
	]

	// Critical-fact validation. Deterministic, no model call, and it can only ADD text — a
	// summary that already carried everything is left exactly as the model wrote it.
	const retainedText = transformMessagesForCondensing(recentTail)
		.flatMap(({ content }) =>
			typeof content === "string" ? [content] : content.map((block) => (block.type === "text" ? block.text : "")),
		)
		.join("\n")
	const retainedToolUseIds = new Set<string>()
	for (const message of recentTail) {
		if (!Array.isArray(message.content)) {
			continue
		}
		for (const block of message.content) {
			if (block.type === "tool_result") {
				retainedToolUseIds.add(block.tool_use_id)
			}
		}
	}
	const factCheck = validateSummaryFacts(summary, ledger, { text: retainedText, toolUseIds: retainedToolUseIds })
	if (factCheck.addendum) {
		summaryContent.push({ type: "text", text: factCheck.addendum })
	}

	// Add command blocks (active workflows) in their own system-reminder block if present
	if (commandBlocks) {
		summaryContent.push({
			type: "text",
			text: `<system-reminder>
## Active Workflows
The following directives must be maintained across all future condensings:
${commandBlocks}
</system-reminder>`,
		})
	}

	// Generate and add folded file context (smart code folding) if file paths are provided
	// Each file gets its own <system-reminder> block as a separate content block
	if (filesReadByRoo && filesReadByRoo.length > 0 && cwd) {
		try {
			const foldedResult = await generateFoldedFileContext(filesReadByRoo, {
				cwd,
				rooIgnoreController,
			})
			if (foldedResult.sections.length > 0) {
				for (const section of foldedResult.sections) {
					if (section.trim()) {
						summaryContent.push({
							type: "text",
							text: section,
						})
					}
				}
			}
		} catch (error) {
			console.error("[summarizeConversation] Failed to generate folded file context:", error)
			// Continue without folded context - non-critical failure
		}
	}

	// Add environment details as a separate text block if provided AND this is an automatic trigger.
	// For manual condensing, fresh environment details will be injected on the next turn.
	// For automatic condensing, the API request is already in progress so we need them in the summary.
	if (isAutomaticTrigger && environmentDetails?.trim()) {
		summaryContent.push({
			type: "text",
			text: environmentDetails,
		})
	}

	// Generate a unique condenseId for this summary
	const condenseId = crypto.randomUUID()

	// Use the last message's timestamp + 1 to ensure unique timestamp for summary.
	// The summary goes at the end of all messages.
	const lastMsgTs = messages[messages.length - 1]?.ts ?? Date.now()

	const summaryMessage: ApiMessage = {
		role: "user", // Fresh start model: summary is a user message
		content: summaryContent,
		ts: lastMsgTs + 1, // Unique timestamp after last message
		isSummary: true,
		condenseId, // Unique ID for this summary, used to track which messages it replaces
	}

	// NON-DESTRUCTIVE CONDENSE (with recent raw tail):
	// Tag the PREFIX (older messages) with condenseParent so they are filtered out
	// of the effective history, then place the summary, then keep the most-recent
	// messages RAW so the model retains its exact working set after the condense.
	//
	// Storage structure after condense:
	// [msg1(parent=X), ..., msgK(parent=X), summary(id=X), recentTail1, recentTail2, ...]
	//
	// Effective for API (getEffectiveApiHistory slices from the summary):
	// [summary, ...recentTail]  ← fresh start that still carries the recent turns
	//
	// On small histories computeCondenseKeepBoundary returns messages.length, so
	// the tail is empty and this reduces to the classic [..tagged, summary] shape.
	const newMessages: ApiMessage[] = []
	for (let i = 0; i < keepBoundary; i++) {
		const msg = messages[i]
		// Leave already-condensed messages as-is (nested condense is handled by filtering).
		newMessages.push(msg.condenseParent ? msg : { ...msg, condenseParent: condenseId })
	}
	newMessages.push(summaryMessage)
	for (const msg of recentTail) {
		newMessages.push(msg)
	}

	// Count the tokens in the context for the next API request
	// After condense, the context will contain: system prompt + summary + tool definitions
	const systemPromptMessage: ApiMessage = { role: "user", content: systemPrompt }

	// Count actual summaryMessage content directly instead of using outputTokens as a proxy
	// This ensures we account for wrapper text (## Conversation Summary, <system-reminder>, <environment_details>)
	const contextBlocks = [systemPromptMessage, summaryMessage].flatMap((message) =>
		typeof message.content === "string" ? [{ text: message.content, type: "text" as const }] : message.content,
	)

	const messageTokens = await apiHandler.countTokens(contextBlocks)

	// Count tool definition tokens if tools are provided
	let toolTokens = 0
	if (metadata?.tools && metadata.tools.length > 0) {
		const toolsText = JSON.stringify(metadata.tools)
		toolTokens = await apiHandler.countTokens([{ text: toolsText, type: "text" }])
	}

	// The recent raw tail is also part of the post-condense context, so its tokens
	// must be included. Tool blocks are converted to text first so countTokens can
	// measure them uniformly across providers.
	let tailTokens = 0
	if (recentTail.length > 0) {
		const tailBlocks = transformMessagesForCondensing(recentTail).flatMap((message) =>
			typeof message.content === "string" ? [{ text: message.content, type: "text" as const }] : message.content,
		)
		if (tailBlocks.length > 0) {
			tailTokens = await apiHandler.countTokens(tailBlocks)
		}
	}

	const newContextTokens = messageTokens + toolTokens + tailTokens
	return {
		messages: newMessages,
		summary,
		cost,
		newContextTokens,
		condenseId,
		factsChecked: factCheck.checked,
		factsRecovered: factCheck.missing.length,
	}
}

/**
 * Returns the list of all messages since the last summary message, including the summary.
 * Returns all messages if there is no summary.
 *
 * Note: Summary messages are always created with role: "user" (fresh-start model),
 * so the first message since the last summary is guaranteed to be a user message.
 */
export function getMessagesSinceLastSummary(messages: ApiMessage[]): ApiMessage[] {
	const lastSummaryIndexReverse = [...messages].reverse().findIndex((message) => message.isSummary)

	if (lastSummaryIndexReverse === -1) {
		return messages
	}

	const lastSummaryIndex = messages.length - lastSummaryIndexReverse - 1
	return messages.slice(lastSummaryIndex)
}

/**
 * True iff every `tool_result` block in `messages[boundary..]` has its matching
 * `tool_use` (same id) also within `messages[boundary..]`. Used to choose a
 * keep-boundary that does not split a tool pair (an orphaned tool_result in the
 * kept tail would be stripped by `getEffectiveApiHistory`).
 */
export function toolPairsSatisfiedFrom(messages: ApiMessage[], boundary: number): boolean {
	const toolUseIds = new Set<string>()
	for (let i = boundary; i < messages.length; i++) {
		const msg = messages[i]
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_use") {
					toolUseIds.add((block as Anthropic.Messages.ToolUseBlockParam).id)
				}
			}
		}
	}
	for (let i = boundary; i < messages.length; i++) {
		const msg = messages[i]
		if (msg.role === "user" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (
					block.type === "tool_result" &&
					!toolUseIds.has((block as Anthropic.Messages.ToolResultBlockParam).tool_use_id)
				) {
					return false
				}
			}
		}
	}
	return true
}

/**
 * Computes the index into `messages` at which the recent RAW tail should start
 * when condensing (i.e. `messages[boundary..]` are kept verbatim and only
 * `messages[0..boundary)` are summarized/tagged). Returns `messages.length` to
 * signal "no tail — classic fresh start".
 *
 * Guarantees:
 * - Only keeps a tail when the since-last-summary region is large enough that
 *   summarizing the prefix is still worthwhile (the gate).
 * - The tail never reaches back to include a prior summary, so the new summary
 *   stays the last `isSummary` in the array (which `getEffectiveApiHistory` and
 *   `getMessagesSinceLastSummary` anchor on).
 * - The boundary NEVER splits a `tool_use`/`tool_result` pair. Two-direction
 *   search: first pull BACKWARD from `messages.length - keepRecent` (prefer
 *   keeping more raw messages), capped at `keepRecent*2` and floored so a
 *   pathological unpaired chain can't swallow the prefix. If the backward pull
 *   exhausts the cap without satisfying `toolPairsSatisfiedFrom`, fall FORWARD
 *   from the original position upward — the forward search always terminates
 *   because `boundary === messages.length` trivially satisfies (empty tail =
 *   classic fresh start, the safe degradation).
 *
 * Pure and deterministic; exported for direct unit testing.
 */
export function computeCondenseKeepBoundary(
	messages: ApiMessage[],
	keepRecent: number = CONDENSE_KEEP_RECENT_MESSAGES,
): number {
	const sinceLast = getMessagesSinceLastSummary(messages)

	// Gate: too small to benefit → no tail.
	if (keepRecent <= 0 || sinceLast.length < keepRecent + CONDENSE_MIN_SUMMARIZED_MESSAGES) {
		return messages.length
	}

	// Floor just past any prior summary at the start of the region, so the tail
	// can never contain an earlier summary.
	const sinceLastStart = messages.length - sinceLast.length
	const floor = sinceLast.length > 0 && sinceLast[0].isSummary ? sinceLastStart + 1 : sinceLastStart

	const initialBoundary = messages.length - keepRecent

	// Pull backward to avoid splitting a tool pair, bounded so it can't run away.
	const minBoundary = Math.max(floor, messages.length - keepRecent * 2)
	let boundary = initialBoundary
	while (boundary > minBoundary && !toolPairsSatisfiedFrom(messages, boundary)) {
		boundary--
	}

	// If the backward pull exhausted the cap without satisfying toolPairsSatisfiedFrom,
	// the current boundary still splits a pair. Fall FORWARD from the original position:
	// search upward for the first satisfying boundary. This always terminates because
	// boundary === messages.length trivially satisfies (empty tail = fresh start).
	if (!toolPairsSatisfiedFrom(messages, boundary)) {
		boundary = initialBoundary
		while (boundary < messages.length && !toolPairsSatisfiedFrom(messages, boundary)) {
			boundary++
		}
	}

	return Math.max(boundary, floor)
}

/**
 * Filters the API conversation history to get the "effective" messages to send to the API.
 *
 * Fresh Start Model:
 * - When a summary exists, return only messages from the summary onwards (fresh start)
 * - Messages with a condenseParent pointing to an existing summary are filtered out
 *
 * Messages with a truncationParent that points to an existing truncation marker are also filtered out,
 * as they have been hidden by sliding window truncation.
 *
 * This allows non-destructive condensing and truncation where messages are tagged but not deleted,
 * enabling accurate rewind operations while still sending condensed/truncated history to the API.
 *
 * @param messages - The full API conversation history including tagged messages
 * @returns The filtered history that should be sent to the API
 */
export function getEffectiveApiHistory(messages: ApiMessage[]): ApiMessage[] {
	// Find the most recent summary message
	const lastSummary = findLast(messages, (msg) => msg.isSummary === true)

	if (lastSummary) {
		// Fresh start model: return only messages from the summary onwards
		const summaryIndex = messages.indexOf(lastSummary)
		let messagesFromSummary = messages.slice(summaryIndex)

		// Collect all tool_use IDs from assistant messages in the result
		// This is needed to filter out orphan tool_result blocks that reference
		// tool_use IDs from messages that were condensed away
		const toolUseIds = new Set<string>()
		for (const msg of messagesFromSummary) {
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "tool_use" && (block as Anthropic.Messages.ToolUseBlockParam).id) {
						toolUseIds.add((block as Anthropic.Messages.ToolUseBlockParam).id)
					}
				}
			}
		}

		// Filter out orphan tool_result blocks from user messages
		messagesFromSummary = messagesFromSummary
			.map((msg) => {
				if (msg.role === "user" && Array.isArray(msg.content)) {
					const filteredContent = msg.content.filter((block) => {
						if (block.type === "tool_result") {
							return toolUseIds.has((block as Anthropic.Messages.ToolResultBlockParam).tool_use_id)
						}
						return true
					})
					// If all content was filtered out, mark for removal
					if (filteredContent.length === 0) {
						return null
					}
					// If some content was filtered, return updated message
					if (filteredContent.length !== msg.content.length) {
						return { ...msg, content: filteredContent }
					}
				}
				return msg
			})
			.filter((msg): msg is ApiMessage => msg !== null)

		// Still need to filter out any truncated messages within this range
		const existingTruncationIds = new Set<string>()
		for (const msg of messagesFromSummary) {
			if (msg.isTruncationMarker && msg.truncationId) {
				existingTruncationIds.add(msg.truncationId)
			}
		}

		return messagesFromSummary.filter((msg) => {
			// Filter out truncated messages if their truncation marker exists
			if (msg.truncationParent && existingTruncationIds.has(msg.truncationParent)) {
				return false
			}
			return true
		})
	}

	// No summary - filter based on condenseParent and truncationParent as before
	// This handles the case of orphaned condenseParent tags (summary was deleted via rewind)

	// Collect all condenseIds of summaries that exist in the current history
	const existingSummaryIds = new Set<string>()
	// Collect all truncationIds of truncation markers that exist in the current history
	const existingTruncationIds = new Set<string>()

	for (const msg of messages) {
		if (msg.isSummary && msg.condenseId) {
			existingSummaryIds.add(msg.condenseId)
		}
		if (msg.isTruncationMarker && msg.truncationId) {
			existingTruncationIds.add(msg.truncationId)
		}
	}

	// Filter out messages whose condenseParent points to an existing summary
	// or whose truncationParent points to an existing truncation marker.
	// Messages with orphaned parents (summary/marker was deleted) are included.
	return messages.filter((msg) => {
		// Filter out condensed messages if their summary exists
		if (msg.condenseParent && existingSummaryIds.has(msg.condenseParent)) {
			return false
		}
		// Filter out truncated messages if their truncation marker exists
		if (msg.truncationParent && existingTruncationIds.has(msg.truncationParent)) {
			return false
		}
		return true
	})
}

/**
 * Cleans up orphaned condenseParent and truncationParent references after a truncation operation (rewind/delete).
 * When a summary message or truncation marker is deleted, messages that were tagged with its ID
 * should have their parent reference cleared so they become active again.
 *
 * This function should be called after any operation that truncates the API history
 * to ensure messages are properly restored when their summary or truncation marker is deleted.
 *
 * @param messages - The API conversation history after truncation
 * @returns The cleaned history with orphaned condenseParent and truncationParent fields cleared
 */
export function cleanupAfterTruncation(messages: ApiMessage[]): ApiMessage[] {
	// Collect all condenseIds of summaries that still exist
	const existingSummaryIds = new Set<string>()
	// Collect all truncationIds of truncation markers that still exist
	const existingTruncationIds = new Set<string>()

	for (const msg of messages) {
		if (msg.isSummary && msg.condenseId) {
			existingSummaryIds.add(msg.condenseId)
		}
		if (msg.isTruncationMarker && msg.truncationId) {
			existingTruncationIds.add(msg.truncationId)
		}
	}

	// Clear orphaned parent references for messages whose summary or truncation marker was deleted
	return messages.map((msg) => {
		let needsUpdate = false

		// Check for orphaned condenseParent
		if (msg.condenseParent && !existingSummaryIds.has(msg.condenseParent)) {
			needsUpdate = true
		}

		// Check for orphaned truncationParent
		if (msg.truncationParent && !existingTruncationIds.has(msg.truncationParent)) {
			needsUpdate = true
		}

		if (needsUpdate) {
			// Create a new object without orphaned parent references
			const { condenseParent, truncationParent, ...rest } = msg
			const result: ApiMessage = rest as ApiMessage

			// Keep condenseParent if its summary still exists
			if (condenseParent && existingSummaryIds.has(condenseParent)) {
				result.condenseParent = condenseParent
			}

			// Keep truncationParent if its truncation marker still exists
			if (truncationParent && existingTruncationIds.has(truncationParent)) {
				result.truncationParent = truncationParent
			}

			return result
		}
		return msg
	})
}
