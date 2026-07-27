import { Anthropic } from "@anthropic-ai/sdk"
import crypto from "crypto"

import { TelemetryService } from "@roo-code/telemetry"

import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import { MAX_CONDENSE_THRESHOLD, MIN_CONDENSE_THRESHOLD, summarizeConversation, SummarizeResponse } from "../condense"
import { ApiMessage } from "../task-persistence/apiMessages"
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "@roo-code/types"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { microcompactToolResults, microcompactTargetChars, MICROCOMPACT_PLACEHOLDER_TOKENS } from "./microcompact"
import { buildContextLedger, type ContextLedger } from "./ledger"

/**
 * Context Management
 *
 * This module provides Context Management for conversations, combining:
 * - Intelligent condensation of prior messages when approaching configured thresholds
 * - Sliding window truncation as a fallback when necessary
 *
 * Behavior and exports are preserved exactly from the previous sliding-window implementation.
 */

/**
 * Default percentage of the context window to use as a buffer when deciding when to truncate.
 * Used by Context Management to determine when to trigger condensation or (fallback) sliding window truncation.
 */
export const TOKEN_BUFFER_PERCENTAGE = 0.1

/**
 * Counts tokens for user content using the provider's token counting implementation.
 *
 * @param {Array<Anthropic.Messages.ContentBlockParam>} content - The content to count tokens for
 * @param {ApiHandler} apiHandler - The API handler to use for token counting
 * @returns {Promise<number>} A promise resolving to the token count
 */
export async function estimateTokenCount(
	content: Array<Anthropic.Messages.ContentBlockParam>,
	apiHandler: ApiHandler,
): Promise<number> {
	if (!content || content.length === 0) return 0
	return apiHandler.countTokens(content)
}

/**
 * Result of truncation operation, includes the truncation ID for UI events.
 */
export type TruncationResult = {
	messages: ApiMessage[]
	truncationId: string
	messagesRemoved: number
}

/**
 * Truncates a conversation by tagging messages as hidden instead of removing them.
 *
 * The first message is always retained, and a specified fraction (rounded to an even number)
 * of messages from the beginning (excluding the first) is tagged with truncationParent.
 * A truncation marker is inserted to track where truncation occurred.
 *
 * This implements non-destructive sliding window truncation, allowing messages to be
 * restored if the user rewinds past the truncation point.
 *
 * @param {ApiMessage[]} messages - The conversation messages.
 * @param {number} fracToRemove - The fraction (between 0 and 1) of messages (excluding the first) to hide.
 * @param {string} taskId - The task ID for the conversation, used for telemetry
 * @returns {TruncationResult} Object containing the tagged messages, truncation ID, and count of messages removed.
 */
export function truncateConversation(messages: ApiMessage[], fracToRemove: number, taskId: string): TruncationResult {
	TelemetryService.instance.captureSlidingWindowTruncation(taskId)

	const truncationId = crypto.randomUUID()

	// Filter to only visible messages (those not already truncated)
	// We need to track original indices to correctly tag messages in the full array
	const visibleIndices: number[] = []
	messages.forEach((msg, index) => {
		if (!msg.truncationParent && !msg.isTruncationMarker) {
			visibleIndices.push(index)
		}
	})

	// Calculate how many visible messages to truncate (excluding first visible message)
	const visibleCount = visibleIndices.length
	const rawMessagesToRemove = Math.floor((visibleCount - 1) * fracToRemove)
	const messagesToRemove = rawMessagesToRemove - (rawMessagesToRemove % 2)

	if (messagesToRemove <= 0) {
		// Nothing to truncate
		return {
			messages,
			truncationId,
			messagesRemoved: 0,
		}
	}

	// Get the indices of visible messages to truncate (skip first visible, take next N)
	const indicesToTruncate = new Set(visibleIndices.slice(1, messagesToRemove + 1))

	// Tag messages that are being "truncated" (hidden from API calls)
	const taggedMessages = messages.map((msg, index) => {
		if (indicesToTruncate.has(index)) {
			return { ...msg, truncationParent: truncationId }
		}
		return msg
	})

	// Find the actual boundary - the index right after the last truncated message
	const lastTruncatedVisibleIndex = visibleIndices[messagesToRemove] // Last visible message being truncated
	// If all visible messages except the first are truncated, insert marker at the end
	const firstKeptVisibleIndex = visibleIndices[messagesToRemove + 1] ?? taggedMessages.length

	// Insert truncation marker at the actual boundary (between last truncated and first kept)
	const firstKeptTs = messages[firstKeptVisibleIndex]?.ts ?? Date.now()
	const truncationMarker: ApiMessage = {
		role: "user",
		content: `[Sliding window truncation: ${messagesToRemove} messages hidden to reduce context]`,
		ts: firstKeptTs - 1,
		isTruncationMarker: true,
		truncationId,
	}

	// Insert marker at the boundary position
	// Find where to insert: right before the first kept visible message
	const insertPosition = firstKeptVisibleIndex
	const result = [
		...taggedMessages.slice(0, insertPosition),
		truncationMarker,
		...taggedMessages.slice(insertPosition),
	]

	return {
		messages: result,
		truncationId,
		messagesRemoved: messagesToRemove,
	}
}

/**
 * Options for checking if context management will likely run.
 * A subset of ContextManagementOptions with only the fields needed for threshold calculation.
 */
export type WillManageContextOptions = {
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	profileThresholds: Record<string, number>
	currentProfileId: string
	lastMessageTokens: number
}

/**
 * Checks whether context management (condensation or truncation) will likely run based on current token usage.
 *
 * This is useful for showing UI indicators before `manageContext` is actually called,
 * without duplicating the threshold calculation logic.
 *
 * @param {WillManageContextOptions} options - The options for threshold calculation
 * @returns {boolean} True if context management will likely run, false otherwise
 */
export function willManageContext({
	totalTokens,
	contextWindow,
	maxTokens,
	autoCondenseContext,
	autoCondenseContextPercent,
	profileThresholds,
	currentProfileId,
	lastMessageTokens,
}: WillManageContextOptions): boolean {
	if (!autoCondenseContext) {
		// When auto-condense is disabled, only truncation can occur
		const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS
		const prevContextTokens = totalTokens + lastMessageTokens
		const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens
		return prevContextTokens > allowedTokens
	}

	const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS
	const prevContextTokens = totalTokens + lastMessageTokens
	const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens

	// Determine the effective threshold to use
	let effectiveThreshold = autoCondenseContextPercent
	const profileThreshold = profileThresholds[currentProfileId]
	if (profileThreshold !== undefined) {
		if (profileThreshold === -1) {
			effectiveThreshold = autoCondenseContextPercent
		} else if (profileThreshold >= MIN_CONDENSE_THRESHOLD && profileThreshold <= MAX_CONDENSE_THRESHOLD) {
			effectiveThreshold = profileThreshold
		}
		// Invalid values fall back to global setting (effectiveThreshold already set)
	}

	const contextPercent = (100 * prevContextTokens) / contextWindow
	return contextPercent >= effectiveThreshold || prevContextTokens > allowedTokens
}

/**
 * Context Management: Conditionally manages the conversation context when approaching limits.
 *
 * Attempts intelligent condensation of prior messages when thresholds are reached.
 * Falls back to sliding window truncation if condensation is unavailable or fails.
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */

export type ContextManagementOptions = {
	messages: ApiMessage[]
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	apiHandler: ApiHandler
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	systemPrompt: string
	taskId: string
	customCondensingPrompt?: string
	profileThresholds: Record<string, number>
	currentProfileId: string
	/** Optional metadata to pass through to the condensing API call (tools, taskId, etc.) */
	metadata?: ApiHandlerCreateMessageMetadata
	/** Optional environment details string to include in the condensed summary */
	environmentDetails?: string
	/** Optional array of file paths read by Roo during the task (will be folded via tree-sitter) */
	filesReadByRoo?: string[]
	/** Optional current working directory for resolving file paths (required if filesReadByRoo is provided) */
	cwd?: string
	/** Optional controller for file access validation */
	rooIgnoreController?: RooIgnoreController
	/**
	 * When true, the auto-condense circuit breaker is tripped (too many
	 * consecutive futile condense attempts): skip the expensive condense step and
	 * fall through to the cheap microcompaction pre-pass and the reliable
	 * sliding-window truncation fallback. Microcompaction and truncation are never
	 * gated by this — only the LLM summary is.
	 */
	condenseCircuitOpen?: boolean
	/**
	 * `tool_use_id`s the PREVIOUS request's microcompaction stripped at send time.
	 * Carried forward so the selection can only grow: a set that shrank between turns
	 * would move the first byte differing from the last request backwards and throw away
	 * the provider's prompt cache from that point on.
	 */
	previouslyClearedToolUseIds?: ReadonlySet<string>
}

export type ContextManagementResult = SummarizeResponse & {
	prevContextTokens: number
	truncationId?: string
	messagesRemoved?: number
	newContextTokensAfterTruncation?: number
	/** True when the cheap tool-result microcompaction pre-pass ran. */
	microcompacted?: boolean
	/** Number of tool results whose content was cleared by microcompaction. */
	microcompactClearedCount?: number
	/** Estimated tokens reclaimed by microcompaction. */
	microcompactTokensCleared?: number
	/**
	 * The `tool_use_id`s whose results microcompaction selected for clearing.
	 * Microcompaction is NON-DESTRUCTIVE: the stored content is left intact and
	 * these ids are applied as a send-time strip (see `applyMicrocompactCleared` /
	 * `buildCleanConversationHistory`). The caller stashes them as transient,
	 * recomputed-per-request state so they stay correct across mode switches.
	 */
	microcompactClearedToolUseIds?: string[]
}

/**
 * Conditionally manages conversation context (condense and fallback truncation).
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */
export async function manageContext({
	messages,
	totalTokens,
	contextWindow,
	maxTokens,
	apiHandler,
	autoCondenseContext,
	autoCondenseContextPercent,
	systemPrompt,
	taskId,
	customCondensingPrompt,
	profileThresholds,
	currentProfileId,
	metadata,
	environmentDetails,
	filesReadByRoo,
	cwd,
	rooIgnoreController,
	condenseCircuitOpen,
	previouslyClearedToolUseIds,
}: ContextManagementOptions): Promise<ContextManagementResult> {
	let error: string | undefined
	let errorDetails: string | undefined
	let cost = 0
	// Calculate the maximum tokens reserved for response
	const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS

	// Estimate tokens for the last message (which is always a user message)
	const lastMessage = messages[messages.length - 1]
	const lastMessageContent = lastMessage.content
	const lastMessageTokens = Array.isArray(lastMessageContent)
		? await estimateTokenCount(lastMessageContent, apiHandler)
		: await estimateTokenCount([{ type: "text", text: lastMessageContent as string }], apiHandler)

	// Calculate total effective tokens (totalTokens never includes the last message)
	const prevContextTokens = totalTokens + lastMessageTokens

	// Calculate available tokens for conversation history
	// Truncate if we're within TOKEN_BUFFER_PERCENTAGE of the context window
	const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens

	// Determine the effective threshold to use
	let effectiveThreshold = autoCondenseContextPercent
	const profileThreshold = profileThresholds[currentProfileId]
	if (profileThreshold !== undefined) {
		if (profileThreshold === -1) {
			// Special case: -1 means inherit from global setting
			effectiveThreshold = autoCondenseContextPercent
		} else if (profileThreshold >= MIN_CONDENSE_THRESHOLD && profileThreshold <= MAX_CONDENSE_THRESHOLD) {
			// Valid custom threshold
			effectiveThreshold = profileThreshold
		} else {
			// Invalid threshold value, fall back to global setting
			console.warn(
				`Invalid profile threshold ${profileThreshold} for profile "${currentProfileId}". Using global default of ${autoCondenseContextPercent}%`,
			)
			effectiveThreshold = autoCondenseContextPercent
		}
	}
	// If no specific threshold is found for the profile, fall back to global setting

	const contextPercent = (100 * prevContextTokens) / contextWindow
	const overCondenseThreshold = autoCondenseContext && contextPercent >= effectiveThreshold
	const overAllowedTokens = prevContextTokens > allowedTokens

	// --- Microcompaction pre-pass (cheap, no-LLM, lossless to the dialogue) ---
	// Before resorting to the expensive, lossy full summarization, identify OLD
	// tool results to clear. Old tool output is the dominant, lowest-signal token
	// sink in a coding session, and clearing it often frees enough to avoid
	// summarizing entirely. This mirrors Claude Code's `microcompact → autocompact`
	// ordering: the expensive summary is the last resort, not the first response to
	// any overflow.
	//
	// Selection is need-adaptive: we compute how far over the binding ceiling we are
	// and clear the oldest results until that much is reclaimed, sparing the ones the
	// context ledger marks critical (unresolved errors, validation outcomes, file
	// writes). Reclaiming only what is needed keeps the small, high-signal results
	// the old count-based rule discarded wholesale.
	//
	// NON-DESTRUCTIVE: we only SELECT the ids here (for the freed-token estimate and
	// for the send-time strip). The stored `tool_result` content is left pristine;
	// the actual clearing is applied to the outgoing request copy by
	// `buildCleanConversationHistory`. The caller stashes the returned ids as
	// transient, recomputed-per-request state so a wider-context mode (after a mode
	// switch) simply clears nothing. condense/truncate below run on pristine
	// `messages`, so branch 2's kept raw tail stays pristine too.
	let microcompacted = false
	let microcompactClearedCount = 0
	let microcompactTokensCleared = 0
	let microcompactClearedToolUseIds: string[] = []

	// Built at most once per pass and shared by both consumers: microcompaction reads it as a
	// protection list, condense reads it as a critical-fact checklist. One linear pass over the
	// history, no model call — so it cannot fail or hallucinate on a weak local model.
	let ledgerMemo: ContextLedger | undefined
	const getLedger = () => (ledgerMemo ??= buildContextLedger(messages))

	if (overCondenseThreshold || overAllowedTokens) {
		// The binding ceiling is whichever limit we are actually being pushed against.
		// When auto-condense is off, only the hard allowance applies.
		const condenseCeilingTokens = autoCondenseContext
			? (contextWindow * effectiveThreshold) / 100
			: Number.POSITIVE_INFINITY
		const ceilingTokens = Math.min(condenseCeilingTokens, allowedTokens)
		const targetChars = microcompactTargetChars(prevContextTokens - ceilingTokens)

		const mc = microcompactToolResults(messages, {
			targetChars,
			// Marks which results carry facts the model cannot cheaply re-derive.
			criticalToolUseIds: getLedger().criticalToolUseIds,
			alreadyClearedToolUseIds: previouslyClearedToolUseIds,
		})
		if (mc.clearedCount > 0) {
			microcompacted = true
			microcompactClearedCount = mc.clearedCount
			microcompactClearedToolUseIds = mc.clearedToolUseIds
			const grossTokensCleared = mc.clearedText
				? await estimateTokenCount([{ type: "text", text: mc.clearedText }], apiHandler)
				: 0
			// Net of the placeholder written back into each cleared result: that is what the
			// strip actually removes from the payload, and therefore what the next request has
			// to add back to recover the pristine size (see nextMicrocompactStrippedTokens).
			microcompactTokensCleared = Math.max(
				0,
				grossTokensCleared - MICROCOMPACT_PLACEHOLDER_TOKENS * mc.clearedCount,
			)

			TelemetryService.instance.captureContextMicrocompacted(taskId, {
				candidates: mc.candidateCount,
				cleared: mc.clearedCount,
				protectedResults: mc.protectedCount,
				releasedProtected: mc.releasedProtectedCount,
				tokensCleared: microcompactTokensCleared,
				prevContextTokens,
				// The review's `reclaim ratio`: share of the pre-pass context this cost-free
				// pass gave back.
				reclaimRatio: prevContextTokens > 0 ? microcompactTokensCleared / prevContextTokens : 0,
			})

			// Estimate the post-strip context size. If clearing old tool output at
			// send time will bring us back under both thresholds, we are done — skip
			// the expensive summarization (and truncation) entirely. This is the
			// "quiet" path that keeps the conversation fully intact.
			const newContextTokens = Math.max(0, prevContextTokens - microcompactTokensCleared)
			const newContextPercent = (100 * newContextTokens) / contextWindow
			const stillOverCondense = autoCondenseContext && newContextPercent >= effectiveThreshold
			const stillOverAllowed = newContextTokens > allowedTokens
			if (!stillOverCondense && !stillOverAllowed) {
				return {
					messages, // pristine — clearing is applied at send time, not persisted
					summary: "",
					cost: 0,
					prevContextTokens,
					newContextTokens,
					microcompacted: true,
					microcompactClearedCount,
					microcompactTokensCleared,
					microcompactClearedToolUseIds,
				}
			}
		}
	}

	// Only surface microcompaction fields when the pre-pass actually ran, so the
	// no-op result shape stays backward-compatible with existing callers/tests.
	const microcompactFields = microcompacted
		? { microcompacted, microcompactClearedCount, microcompactTokensCleared, microcompactClearedToolUseIds }
		: undefined

	// Skip the expensive condense step when the circuit breaker is tripped: too
	// many consecutive condense attempts have failed to reduce the context, so
	// retrying the lossy summary is futile. Microcompaction (above) and truncation
	// (below) still run — they always reduce and cannot "fail" like an LLM summary.
	if (autoCondenseContext && !condenseCircuitOpen) {
		if (contextPercent >= effectiveThreshold || prevContextTokens > allowedTokens) {
			// Attempt to intelligently condense the PRISTINE context (the send-time
			// strip handles old tool output; condensing pristine keeps the kept raw
			// tail pristine and the stored transcript intact).
			const result = await summarizeConversation({
				messages,
				apiHandler,
				systemPrompt,
				taskId,
				isAutomaticTrigger: true,
				customCondensingPrompt,
				metadata,
				environmentDetails,
				filesReadByRoo,
				cwd,
				rooIgnoreController,
				// The summary is written by an LLM (often a small background model); this is the
				// checklist it is validated against, so dropped critical facts are restored
				// deterministically instead of silently lost.
				ledger: getLedger(),
			})
			if (result.error) {
				error = result.error
				errorDetails = result.errorDetails
				cost = result.cost
			} else {
				return { ...result, prevContextTokens, ...microcompactFields }
			}
		}
	}

	// Fall back to sliding window truncation if needed
	if (prevContextTokens > allowedTokens) {
		const truncationResult = truncateConversation(messages, 0.5, taskId)

		// Calculate new context tokens after truncation by counting non-truncated messages
		// Messages with truncationParent are hidden, so we count only those without it
		const effectiveMessages = truncationResult.messages.filter(
			(msg) => !msg.truncationParent && !msg.isTruncationMarker,
		)

		// Include system prompt tokens so this value matches what we send to the API.
		// Note: `prevContextTokens` is computed locally here (totalTokens + lastMessageTokens).
		let newContextTokensAfterTruncation = await estimateTokenCount(
			[{ type: "text", text: systemPrompt }],
			apiHandler,
		)

		for (const msg of effectiveMessages) {
			const content = msg.content
			if (Array.isArray(content)) {
				newContextTokensAfterTruncation += await estimateTokenCount(content, apiHandler)
			} else if (typeof content === "string") {
				newContextTokensAfterTruncation += await estimateTokenCount(
					[{ type: "text", text: content }],
					apiHandler,
				)
			}
		}

		return {
			messages: truncationResult.messages,
			prevContextTokens,
			summary: "",
			cost,
			error,
			errorDetails,
			truncationId: truncationResult.truncationId,
			messagesRemoved: truncationResult.messagesRemoved,
			newContextTokensAfterTruncation,
			...microcompactFields,
		}
	}
	// No truncation or condensation needed. Return the PRISTINE messages — any
	// microcompaction is carried as `microcompactClearedToolUseIds` (in
	// `microcompactFields`) and applied at send time, never persisted here.
	return {
		messages,
		summary: "",
		cost,
		prevContextTokens,
		error,
		errorDetails,
		...microcompactFields,
	}
}
