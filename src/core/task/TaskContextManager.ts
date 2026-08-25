import OpenAI from "openai"
import EventEmitter from "events"

import {
	type ProviderSettings,
	type TokenUsage,
	type ContextCondense,
	type ContextTruncation,
	type ContextPrune,
	RooCodeEventName,
	countEnabledMcpTools,
	isPruneBeforeCondenseEnabled,
	resolvePruneToolResultBudget,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { type ApiHandler, type ApiHandlerCreateMessageMetadata } from "../../api"
import { getModelMaxOutputTokens } from "../../shared/api"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { McpHub } from "../../services/mcp/McpHub"
import { manageContext, willManageContext } from "../context-management"
import { getEnvironmentDetails } from "../environment/getEnvironmentDetails"
import { getMessagesSinceLastSummary, summarizeConversation, getEffectiveApiHistory } from "../condense"
import { buildNativeToolsArrayWithRestrictions } from "./build-tools"
import { type TaskHistory } from "./TaskHistory"
import { type TaskAskSay } from "./TaskAskSay"
import { type ClineProvider } from "../webview/ClineProvider"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import type { ArtifactStore } from "../artifacts/ArtifactStore"

/**
 * Module-level constants for context management
 */
const FORCED_CONTEXT_REDUCTION_PERCENT = 75 // Keep 75% of context (remove 25%) on context window errors
const MAX_CONTEXT_WINDOW_RETRIES = 3 // Maximum retries for context window errors
// Auto-condense circuit breaker: after this many consecutive condense attempts
// that error or fail to reduce context, stop attempting condense for the task and
// fall back to microcompaction + truncation. Mirrors Claude Code's autocompact guard.
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

/**
 * Outcome fields from `manageContext` relevant to the auto-condense circuit breaker.
 * `summary`/`error` are set exclusively by the condense branch of `manageContext`,
 * so their presence is what tells us a condense was attempted in this pass.
 */
export interface CondenseOutcome {
	summary?: string
	error?: string
	prevContextTokens: number
	newContextTokens?: number
}

/**
 * Pure transition for the auto-condense circuit-breaker counter.
 *
 * - No condense attempted this pass (no `summary` and no `error`) → unchanged, so a
 *   tripped breaker stays latched and microcompaction-only / truncation-only / no-op
 *   passes never move the counter.
 * - Condense attempted and genuinely reduced context → reset to 0.
 * - Condense attempted but errored, or did not reduce context
 *   (`newContextTokens >= prevContextTokens`) → increment (a non-reducing summary is
 *   as futile as one that throws).
 *
 * The breaker is considered open once the returned count reaches
 * MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES.
 */
export function nextAutoCompactFailureCount(current: number, result: CondenseOutcome): number {
	const condenseAttempted = !!result.summary || !!result.error
	if (!condenseAttempted) {
		return current
	}
	const condenseReduced =
		!result.error && result.newContextTokens !== undefined && result.newContextTokens < result.prevContextTokens
	return condenseReduced ? 0 : current + 1
}

/**
 * Outcome fields from `manageContext` relevant to the microcompaction feedback loop.
 * `summary` marks a condense, `truncationId` a sliding-window truncation — both rewrite
 * the history structurally.
 */
export interface MicrocompactOutcome {
	summary?: string
	truncationId?: string
	microcompactTokensCleared?: number
}

/**
 * Pure rule for the microcompaction size correction carried into the NEXT request.
 *
 * The threshold check runs on the provider-reported context size of the PREVIOUS
 * request. When that request was microcompacted, the provider measured the STRIPPED
 * payload — but `apiConversationHistory` still holds the pristine content, because the
 * strip only ever touches the outgoing copy. Comparing a pristine history against a
 * stripped measurement is what makes the gate oscillate: strip → reported size drops
 * below the threshold → next turn skips the strip → the full history goes out → over
 * threshold → strip again. That two-cycle flip-flop changes the sent prefix every turn,
 * so prompt caching can never hit.
 *
 * Returning what we stripped lets the caller add it back and gate on the true pristine
 * size, which is monotone in the history.
 *
 * Returns 0 when:
 * - nothing was cleared (reported size already equals the pristine size), or
 * - the pass ALSO condensed or truncated: those rewrite the history structurally, the
 *   reported size reflects the new shape, and the cleared ids may no longer resolve.
 *   Under-correcting for one turn is the pre-fix behaviour — never worse.
 */
export function nextMicrocompactStrippedTokens(result: MicrocompactOutcome, clearedIdCount: number): number {
	const structurallyChanged = !!result.summary || !!result.truncationId
	if (structurallyChanged || clearedIdCount === 0) {
		return 0
	}
	return result.microcompactTokensCleared ?? 0
}

/**
 * Interface for Task access needed by TaskContextManager.
 * This is a narrow interface to minimize coupling between modules.
 */
export interface TaskContextManagerAccess {
	// Core identifiers
	taskId: string

	// API configuration and handler
	apiConfiguration: ProviderSettings
	api: ApiHandler
	/**
	 * Async-resolve and cache the condense (context-compaction) handler: the
	 * background model wrapped with a fallback to `api`. Loads the configured
	 * profile on first call. The sync `condenseApiHandler` getter is intentionally
	 * NOT exposed here — external callers must use the async resolver so the
	 * configured background model is never silently bypassed.
	 */
	getCondenseApiHandler(): Promise<ApiHandler>

	// Conversation history
	apiConversationHistory: ApiMessage[]

	// Auto-condense circuit breaker counter (read AND written by the manager).
	consecutiveAutoCompactFailures: number

	// Non-destructive microcompaction: transient set of tool_use_ids to clear at
	// send time. Written by the manager each request; read by buildCleanConversationHistory.
	microcompactedToolUseIds: Set<string>

	// Estimated tokens the send-time strip removed from the last request. Written by
	// the manager each request; read by the API loop to un-deflate the reported
	// context size before the next threshold check. See Task#microcompactStrippedTokens.
	microcompactStrippedTokens: number

	// Workspace path
	cwd: string

	// Controllers
	rooIgnoreController?: RooIgnoreController
	fileContextTracker: FileContextTracker

	// Provider reference
	providerRef: WeakRef<ClineProvider>

	// Delegated modules
	history: TaskHistory
	askSay: TaskAskSay

	/**
	 * Resolves the task's artifact store, where the deterministic pruner parks
	 * the originals of the tool results it shrinks. Resolves to `undefined` when
	 * the store cannot be created, which simply disables the prune pass.
	 */
	getArtifactStore(): Promise<ArtifactStore | undefined>

	// Methods needed
	getTokenUsage(): TokenUsage
	getSystemPrompt(): Promise<string>
	emit: EventEmitter["emit"]
	processQueuedMessages(): void
}

/**
 * Parameters for manageContextIfNeeded
 */
export interface ManageContextParams {
	state: any
	systemPrompt: string
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	profileThresholds: Record<string, any>
	currentProfileId: string
	contextTokens: number
	maxTokens: number | undefined
	contextWindow: number
	lastMessageTokens: number
	customCondensingPrompt?: string
}

/**
 * Result from manageContextIfNeeded
 */
export interface ManageContextResult {
	messagesReplaced: boolean
	summary?: string
	cost?: number
	prevContextTokens?: number
	newContextTokens?: number
	error?: string
	truncationId?: string
	messagesRemoved?: number
	condenseId?: string
	/** Tool results the deterministic prune pass moved to `prune` artifacts. */
	prunedCount?: number
	/** Bytes the prune pass removed from the conversation, net of the previews. */
	prunedBytesSaved?: number
	/** True when pruning alone relieved the pressure and no LLM summary ran. */
	summarySkipped?: boolean
}

/**
 * Type for messages used in API conversation history
 */
export interface ApiMessage {
	role: "user" | "assistant"
	content: any
}

/**
 * TaskContextManager handles context condensing and context window management.
 * Extracted from Task.ts as part of the modularization refactoring.
 *
 * ## Responsibilities
 * - Manual context condensing (user-triggered via `condenseContext`)
 * - Automatic context management when context limits are approached
 * - Force truncation on context window exceeded errors
 * - MCP tools counting for warnings
 *
 * ## Usage
 * This module is instantiated by Task and accessed via delegation:
 * ```typescript
 * // In Task
 * this.contextManager = new TaskContextManager(this)
 * await this.contextManager.condenseContext()
 * ```
 */
export class TaskContextManager {
	constructor(private readonly access: TaskContextManagerAccess) {}

	/**
	 * Get files read by Roo, with error handling.
	 * Used when context management needs to know which files have been read.
	 *
	 * @param context - Context string for error logging (e.g., "condenseContext", "attemptApiRequest")
	 * @returns Array of file paths or undefined on error
	 */
	public async getFilesReadByRooSafely(context: string): Promise<string[] | undefined> {
		try {
			return await this.access.fileContextTracker.getFilesReadByRoo()
		} catch (error) {
			console.error(`[TaskContextManager#${context}] Failed to get files read by Roo:`, error)
			return undefined
		}
	}

	/**
	 * Manual context condensing triggered by user.
	 * This flushes pending tool results, builds condensing metadata, and calls summarizeConversation.
	 */
	public async condenseContext(): Promise<void> {
		// CRITICAL: Flush any pending tool results before condensing
		// to ensure tool_use/tool_result pairs are complete in history
		await this.access.history.flushPendingToolResultsToHistory()

		const systemPrompt = await this.access.getSystemPrompt()

		// Get condensing configuration
		const state = await this.access.providerRef.deref()?.getState()
		const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE
		const { mode, apiConfiguration } = state ?? {}

		const { contextTokens: prevContextTokens } = this.access.getTokenUsage()

		// Build tools for condensing metadata (same tools used for normal API calls)
		const metadata = await this.buildCondensingMetadata(
			mode,
			state?.customModes,
			state?.experiments,
			apiConfiguration,
			state?.disabledTools,
			state?.webToolsEnabled,
		)

		// Generate environment details to include in the condensed summary
		const environmentDetails = await getEnvironmentDetails(this.access as any, true)

		const filesReadByRoo = await this.getFilesReadByRooSafely("condenseContext")

		// Resolve the condense handler (background model with fallback to the
		// foreground model) so a configured `autoCondenseContextApiConfigId`
		// routes the condense LLM call to the chosen profile.
		const condenseApiHandler = await this.access.getCondenseApiHandler()

		const {
			messages,
			summary,
			cost,
			newContextTokens = 0,
			error,
			condenseId,
		} = await summarizeConversation({
			messages: this.access.apiConversationHistory,
			apiHandler: condenseApiHandler,
			systemPrompt,
			taskId: this.access.taskId,
			isAutomaticTrigger: false,
			customCondensingPrompt,
			metadata,
			environmentDetails,
			filesReadByRoo,
			cwd: this.access.cwd,
			rooIgnoreController: this.access.rooIgnoreController,
		})

		if (error) {
			await this.access.askSay.say(
				"condense_context_error",
				error,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
			)
			return
		}

		await this.access.history.overwriteApiConversationHistory(messages)

		const contextCondense: ContextCondense = {
			summary,
			cost,
			newContextTokens,
			prevContextTokens,
			condenseId: condenseId!,
		}
		await this.access.askSay.say(
			"condense_context",
			undefined /* text */,
			undefined /* images */,
			false /* partial */,
			undefined /* checkpoint */,
			undefined /* progressStatus */,
			{ isNonInteractive: true } /* options */,
			contextCondense,
		)

		// Process any queued messages after condensing completes
		this.access.processQueuedMessages()
	}

	/**
	 * Get enabled MCP tools count for this task.
	 * Returns the count along with the number of servers contributing.
	 *
	 * @returns Object with enabledToolCount and enabledServerCount
	 */
	public async getEnabledMcpToolsCount(): Promise<{ enabledToolCount: number; enabledServerCount: number }> {
		try {
			const provider = this.access.providerRef.deref()
			if (!provider) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			const { mcpEnabled } = (await provider.getState()) ?? {}
			if (!(mcpEnabled ?? true)) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			const mcpHub = await McpServerManager.getInstance(provider.context, provider)
			if (!mcpHub) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			const servers = mcpHub.getServers()
			return countEnabledMcpTools(servers)
		} catch (error) {
			console.error("[TaskContextManager#getEnabledMcpToolsCount] Error counting MCP tools:", error)
			return { enabledToolCount: 0, enabledServerCount: 0 }
		}
	}

	/**
	 * Force-truncate context when context window is exceeded.
	 * Called when the API returns a context_window_exceeded error.
	 *
	 * This method:
	 * 1. Sends condenseTaskContextStarted to show in-progress indicator
	 * 2. Aggressively truncates to 75% of current context
	 * 3. Handles both condensation and sliding window truncation results
	 * 4. Always sends condenseTaskContextResponse to dismiss spinner
	 */
	public async handleContextWindowExceededError(): Promise<void> {
		const state = await this.access.providerRef.deref()?.getState()
		const { profileThresholds = {}, mode, apiConfiguration } = state ?? {}

		const { contextTokens } = this.access.getTokenUsage()
		const modelInfo = this.access.api.getModel().info

		const maxTokens = getModelMaxOutputTokens({
			modelId: this.access.api.getModel().id,
			model: modelInfo,
			settings: this.access.apiConfiguration,
		})

		const contextWindow = modelInfo.contextWindow

		// Get the current profile ID using helper
		const currentProfileId = this.getCurrentProfileId(state)

		// Log the context window error for debugging
		console.warn(
			`[TaskContextManager#${this.access.taskId}] Context window exceeded for model ${this.access.api.getModel().id}. ` +
				`Current tokens: ${contextTokens}, Context window: ${contextWindow}. ` +
				`Forcing truncation to ${FORCED_CONTEXT_REDUCTION_PERCENT}% of current context.`,
		)

		// Send condenseTaskContextStarted to show in-progress indicator
		await this.access.providerRef
			.deref()
			?.postMessageToWebview({ type: "condenseTaskContextStarted", text: this.access.taskId })

		// Build tools for condensing metadata
		const metadata = await this.buildCondensingMetadata(
			mode,
			state?.customModes,
			state?.experiments,
			apiConfiguration,
			state?.disabledTools,
			state?.webToolsEnabled,
		)

		try {
			// Generate environment details to include in the condensed summary
			const environmentDetails = await getEnvironmentDetails(this.access as any, true)

			// Resolve the condense handler (background model with fallback to the
			// foreground model) so a configured `autoCondenseContextApiConfigId`
			// routes the forced-truncation condense to the chosen profile.
			const condenseApiHandler = await this.access.getCondenseApiHandler()

			// The context window is already exceeded, so the prune pass is
			// certain to be reached: resolve the store unconditionally here.
			const pruneOptions = await this.resolvePruneOptions(state, true)

			// Force aggressive truncation by keeping only 75% of the conversation history
			const truncateResult = await manageContext({
				messages: this.access.apiConversationHistory,
				totalTokens: contextTokens || 0,
				maxTokens,
				contextWindow,
				apiHandler: condenseApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: FORCED_CONTEXT_REDUCTION_PERCENT,
				systemPrompt: await this.access.getSystemPrompt(),
				taskId: this.access.taskId,
				profileThresholds,
				currentProfileId,
				metadata,
				environmentDetails,
				...pruneOptions,
			})

			if (truncateResult.messages !== this.access.apiConversationHistory) {
				await this.access.history.overwriteApiConversationHistory(truncateResult.messages)
			}

			if (truncateResult.summary) {
				const { summary, cost, prevContextTokens, newContextTokens = 0 } = truncateResult
				const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
				await this.access.askSay.say(
					"condense_context",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					contextCondense,
				)
			} else if (truncateResult.truncationId) {
				// Sliding window truncation occurred (fallback when condensing fails or is disabled)
				const contextTruncation: ContextTruncation = {
					truncationId: truncateResult.truncationId,
					messagesRemoved: truncateResult.messagesRemoved ?? 0,
					prevContextTokens: truncateResult.prevContextTokens,
					newContextTokens: truncateResult.newContextTokensAfterTruncation ?? 0,
				}
				await this.access.askSay.say(
					"sliding_window_truncation",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					undefined /* contextCondense */,
					contextTruncation,
				)
			} else if (truncateResult.summarySkipped && truncateResult.prunedCount) {
				// A prune-only round, same as the third branch of manageContextIfNeeded.
				// The forced path persists the rewritten history a few lines above, so
				// staying silent here would mean tool output vanishing from the stored
				// transcript with no explanation and no hint that read_artifact can
				// bring it back. A destructive rewrite must never be silent, and this
				// path (the context window is ALREADY exceeded) is the likeliest place
				// for a real prune-only round to happen.
				const contextPrune: ContextPrune = {
					prunedCount: truncateResult.prunedCount,
					bytesSaved: truncateResult.prunedBytesSaved ?? 0,
					prevContextTokens: truncateResult.prevContextTokens,
					newContextTokens: truncateResult.newContextTokens ?? 0,
				}
				await this.access.askSay.say(
					"context_pruned",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					undefined /* contextCondense */,
					undefined /* contextTruncation */,
					contextPrune,
				)
			}
		} finally {
			// Notify webview that context management is complete (removes in-progress spinner)
			// IMPORTANT: Must always be sent to dismiss the spinner, even on error
			await this.access.providerRef
				.deref()
				?.postMessageToWebview({ type: "condenseTaskContextResponse", text: this.access.taskId })
		}
	}

	/**
	 * Check if context management will run and perform it if needed.
	 * This is extracted from the attemptApiRequest method.
	 *
	 * @param params - Parameters for context management
	 * @returns Result of context management, or undefined if it didn't run
	 */
	public async manageContextIfNeeded(params: ManageContextParams): Promise<ManageContextResult | undefined> {
		const {
			state,
			systemPrompt,
			autoCondenseContext,
			autoCondenseContextPercent,
			profileThresholds,
			currentProfileId,
			contextTokens,
			maxTokens,
			contextWindow,
			lastMessageTokens,
			customCondensingPrompt,
		} = params

		// Auto-condense circuit breaker: when too many consecutive condense attempts
		// have failed to reduce context, skip condense entirely (manageContext falls
		// back to microcompaction + truncation). When open we also skip the condense-
		// only prep work (folded files, environment details) and the condense spinner.
		const condenseCircuitOpen = this.access.consecutiveAutoCompactFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES

		// Check if context management will likely run (threshold check)
		// This allows us to show an in-progress indicator to the user
		const contextManagementWillRun = willManageContext({
			totalTokens: contextTokens,
			contextWindow,
			maxTokens,
			autoCondenseContext,
			autoCondenseContextPercent,
			profileThresholds,
			currentProfileId,
			lastMessageTokens,
		})

		// Send condenseTaskContextStarted BEFORE manageContext to show in-progress indicator.
		// Skip when the breaker is open: condense will not run, so a condense spinner would mislead.
		const willShowCondenseSpinner = contextManagementWillRun && autoCondenseContext && !condenseCircuitOpen
		if (willShowCondenseSpinner) {
			await this.access.providerRef
				.deref()
				?.postMessageToWebview({ type: "condenseTaskContextStarted", text: this.access.taskId })
		}

		// Build tools for condensing metadata
		const { mode, apiConfiguration } = state ?? {}
		const metadata = await this.buildCondensingMetadata(
			mode,
			state?.customModes,
			state?.experiments,
			apiConfiguration,
			state?.disabledTools,
			state?.webToolsEnabled,
		)

		// Only generate environment details / folded files when a condense could
		// actually run — both are condense-only inputs, wasted when the breaker is open.
		const environmentDetails =
			contextManagementWillRun && !condenseCircuitOpen
				? await getEnvironmentDetails(this.access as any, true)
				: undefined

		// Get files read by Roo for code folding - only when condense could run
		const filesReadByRoo =
			contextManagementWillRun && autoCondenseContext && !condenseCircuitOpen
				? await this.getFilesReadByRooSafely("attemptApiRequest")
				: undefined

		// Track whether a condense was attempted this pass so a thrown
		// summarizeConversation still increments the circuit breaker (Claim 1:
		// the old code only updated the breaker on the success path, so a
		// chronically-throwing background model kept retrying instead of
		// latching the breaker open after MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES).
		let condenseAttemptedThisPass = false
		// manageContext returns a rich result (messages/cost/summary/truncationId/
		// microcompact fields); CondenseOutcome is the narrow breaker-relevant
		// subset. Type as the full return so the post-call code compiles.
		let truncateResult: Awaited<ReturnType<typeof manageContext>> | undefined
		try {
			// A condense is attempted iff manageContext will reach its condense
			// branch: context management will run, auto-condense is on, and the
			// breaker is not already open. Mirror the gate in manageContext
			// (context-management/index.ts) so the breaker update below matches
			// what actually happened.
			condenseAttemptedThisPass = contextManagementWillRun && autoCondenseContext && !condenseCircuitOpen

			// Resolve the condense handler (background model with fallback to the
			// foreground model) only when a condense can actually run — this is
			// the every-request path, and the first resolve per task costs a
			// profile load from secret storage plus an SDK client build. When no
			// condense will run, manageContext only uses the handler for token
			// counting (truncation math), where the foreground `api` is correct.
			const condenseApiHandler = condenseAttemptedThisPass
				? await this.access.getCondenseApiHandler()
				: this.access.api

			// The deterministic prune pass runs inside manageContext, between the
			// microcompaction pre-pass and the LLM summary. It is gated on
			// `contextManagementWillRun` for the same reason the environment
			// details are: below the thresholds nothing in manageContext reaches
			// the pruner, so resolving its store would be wasted I/O.
			const pruneOptions = await this.resolvePruneOptions(state, contextManagementWillRun)

			truncateResult = await manageContext({
				messages: this.access.apiConversationHistory,
				totalTokens: contextTokens,
				maxTokens,
				contextWindow,
				apiHandler: condenseApiHandler,
				autoCondenseContext,
				autoCondenseContextPercent,
				systemPrompt,
				taskId: this.access.taskId,
				customCondensingPrompt,
				profileThresholds,
				currentProfileId,
				metadata,
				environmentDetails,
				filesReadByRoo,
				cwd: this.access.cwd,
				rooIgnoreController: this.access.rooIgnoreController,
				condenseCircuitOpen,
				// Everything the previous pass cleared, so the need-adaptive selector can
				// carry those decisions forward unconditionally. A smaller reclaim target
				// this turn must never RE-inflate a result: that would move the first
				// differing byte backwards and void the provider's prompt cache. Safe to
				// pass the live set — manageContext only reads it, and it is rewritten
				// from the result below.
				previouslyClearedToolUseIds: this.access.microcompactedToolUseIds,
				...pruneOptions,
			})

			// Update the auto-condense circuit breaker from the condense outcome
			// (see nextAutoCompactFailureCount for the success/failure/latch rules).
			this.access.consecutiveAutoCompactFailures = nextAutoCompactFailureCount(
				this.access.consecutiveAutoCompactFailures,
				truncateResult,
			)

			// Stash the non-destructive microcompaction decision as transient state.
			// Mutate the EXISTING set in place (rather than reassigning) so the
			// reference captured by ApiRequestBuilder at construction stays live.
			// Always overwrite (empty when nothing to clear) so a stale set from a
			// prior request — or a prior mode with a narrower context window — never
			// lingers. The send-time chokepoint applies it to the outgoing copy only.
			this.access.microcompactedToolUseIds.clear()
			for (const id of truncateResult.microcompactClearedToolUseIds ?? []) {
				this.access.microcompactedToolUseIds.add(id)
			}

			// Record how much the strip will remove from the outgoing request, so the
			// NEXT request can un-deflate the provider-reported context size before
			// re-running the threshold check (see nextMicrocompactStrippedTokens).
			// Without this the gate compares a pristine history against a stripped
			// measurement and flip-flops every other turn (measured: 31% of tasks,
			// 77M excess input tokens).
			this.access.microcompactStrippedTokens = nextMicrocompactStrippedTokens(
				truncateResult,
				this.access.microcompactedToolUseIds.size,
			)

			if (truncateResult.messages !== this.access.apiConversationHistory) {
				await this.access.history.overwriteApiConversationHistory(truncateResult.messages)
			}

			if (truncateResult.error) {
				await this.access.askSay.say("condense_context_error", truncateResult.error)
			}

			if (truncateResult.summary) {
				const { summary, cost, prevContextTokens, newContextTokens = 0, condenseId } = truncateResult
				const contextCondense: ContextCondense = {
					summary,
					cost,
					newContextTokens,
					prevContextTokens,
					condenseId,
				}
				await this.access.askSay.say(
					"condense_context",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					contextCondense,
				)
			} else if (truncateResult.truncationId) {
				// Sliding window truncation occurred (fallback when condensing fails or is disabled)
				const contextTruncation: ContextTruncation = {
					truncationId: truncateResult.truncationId,
					messagesRemoved: truncateResult.messagesRemoved ?? 0,
					prevContextTokens: truncateResult.prevContextTokens,
					newContextTokens: truncateResult.newContextTokensAfterTruncation ?? 0,
				}
				await this.access.askSay.say(
					"sliding_window_truncation",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					undefined /* contextCondense */,
					contextTruncation,
				)
			} else if (truncateResult.summarySkipped && truncateResult.prunedCount) {
				// A prune-only round. It gets its own row because pruning is the one
				// context pass that REWRITES what the user can scroll back through:
				// old tool output the transcript used to hold in full now lives in a
				// task artifact. Microcompaction stays silent because it changes
				// nothing on disk; this does, so saying nothing would mean text
				// quietly vanishing from the conversation with no explanation and no
				// hint that read_artifact can bring it back.
				const contextPrune: ContextPrune = {
					prunedCount: truncateResult.prunedCount,
					bytesSaved: truncateResult.prunedBytesSaved ?? 0,
					prevContextTokens: truncateResult.prevContextTokens,
					newContextTokens: truncateResult.newContextTokens ?? 0,
				}
				await this.access.askSay.say(
					"context_pruned",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					undefined /* contextCondense */,
					undefined /* contextTruncation */,
					contextPrune,
				)
			}

			return {
				messagesReplaced: truncateResult.messages !== this.access.apiConversationHistory,
				summary: truncateResult.summary,
				cost: truncateResult.cost,
				prevContextTokens: truncateResult.prevContextTokens,
				newContextTokens: truncateResult.newContextTokens,
				error: truncateResult.error,
				truncationId: truncateResult.truncationId,
				messagesRemoved: truncateResult.messagesRemoved,
				prunedCount: truncateResult.prunedCount,
				prunedBytesSaved: truncateResult.prunedBytesSaved,
				summarySkipped: truncateResult.summarySkipped,
			}
		} catch (error) {
			// Claim 1: a thrown condense (e.g. summarizeConversation threw after
			// the wrapper exhausted both background and foreground) must still
			// count against the circuit breaker. Synthesize a failure outcome
			// so nextAutoCompactFailureCount increments; without this, a
			// chronically-throwing background model retries forever instead of
			// latching the breaker open and falling back to microcompaction.
			if (condenseAttemptedThisPass) {
				this.access.consecutiveAutoCompactFailures = nextAutoCompactFailureCount(
					this.access.consecutiveAutoCompactFailures,
					{ error: "condense threw", prevContextTokens: contextTokens },
				)
			}
			// Re-throw so the caller (attemptApiRequest) sees the failure; the
			// finally below still dismisses the spinner.
			throw error
		} finally {
			// Notify webview that context management is complete (sets isCondensing = false)
			// IMPORTANT: Must always be sent to dismiss the spinner, even on error.
			// Mirror the start condition so we only dismiss a spinner we actually showed.
			if (willShowCondenseSpinner) {
				await this.access.providerRef
					.deref()
					?.postMessageToWebview({ type: "condenseTaskContextResponse", text: this.access.taskId })
			}
		}
	}

	/**
	 * Resolves the deterministic prune pass options for a `manageContext` call.
	 *
	 * The artifact store is only resolved when the pass can actually run, because
	 * resolving it creates the task directory: doing that on every request, for
	 * users who turned the pass off, would be pure I/O for nothing.
	 *
	 * @param state - Provider state (carries `pruneBeforeCondense` / `pruneToolResultBudget`).
	 * @param willRun - Whether context management is expected to run this pass.
	 */
	private async resolvePruneOptions(
		state: any,
		willRun: boolean,
	): Promise<{ pruneBeforeCondense: boolean; pruneToolResultBudget: number; artifactStore?: ArtifactStore }> {
		const pruneBeforeCondense = isPruneBeforeCondenseEnabled(state)
		const pruneToolResultBudget = resolvePruneToolResultBudget(state)

		if (!willRun || !pruneBeforeCondense) {
			return { pruneBeforeCondense, pruneToolResultBudget }
		}

		let artifactStore: ArtifactStore | undefined
		try {
			artifactStore = await this.access.getArtifactStore()
		} catch (error) {
			// Never fatal: without a store the prune pass is skipped and the
			// existing microcompact/condense/truncate chain handles the pressure.
			console.warn("[TaskContextManager#resolvePruneOptions] Artifact store unavailable, prune disabled:", error)
		}

		return { pruneBeforeCondense, pruneToolResultBudget, artifactStore }
	}

	/**
	 * Get the current profile ID from state.
	 * Helper method extracted from Task for use in context management.
	 */
	private getCurrentProfileId(state: any): string {
		return (
			state?.listApiConfigMeta?.find((profile: any) => profile.name === state?.currentApiConfigName)?.id ??
			"default"
		)
	}

	/**
	 * Build metadata for condensing API calls.
	 * This consolidates the duplicated tool-building logic across multiple methods.
	 */
	private async buildCondensingMetadata(
		mode: string | undefined,
		customModes: any,
		experiments: Record<string, boolean> | undefined,
		apiConfiguration: ProviderSettings | undefined,
		disabledTools: string[] | undefined,
		webToolsEnabled: boolean | undefined,
	): Promise<ApiHandlerCreateMessageMetadata> {
		const provider = this.access.providerRef.deref()
		const modelInfo = this.access.api.getModel().info

		let allTools: OpenAI.Chat.ChatCompletionTool[] = []
		if (provider) {
			const toolsResult = await buildNativeToolsArrayWithRestrictions({
				provider,
				cwd: this.access.cwd,
				mode,
				customModes,
				experiments,
				apiConfiguration,
				disabledTools,
				modelInfo,
				webToolsEnabled,
				includeAllToolsWithRestrictions: false,
			})
			allTools = toolsResult.tools
		}

		return {
			mode,
			taskId: this.access.taskId,
			...(allTools.length > 0
				? {
						tools: allTools,
						tool_choice: "auto",
						parallelToolCalls: true,
					}
				: {}),
		}
	}
}

// Export constants for use in Task.ts
export { FORCED_CONTEXT_REDUCTION_PERCENT, MAX_CONTEXT_WINDOW_RETRIES }
