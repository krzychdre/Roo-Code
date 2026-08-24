import * as path from "path"
import * as vscode from "vscode"
import os from "os"
import crypto from "crypto"
import { v7 as uuidv7 } from "uuid"
import EventEmitter from "events"

import { AskIgnoredError } from "./AskIgnoredError"

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import debounce from "lodash.debounce"
import delay from "delay"
import pWaitFor from "p-wait-for"
import { serializeError } from "serialize-error"
import { Package } from "../../shared/package"
import { formatToolInvocation } from "../tools/helpers/toolResultFormatting"

import {
	type TaskLike,
	type TaskMetadata,
	type TaskEvents,
	type ProviderSettings,
	type TokenUsage,
	type ToolUsage,
	type ToolName,
	type ContextCondense,
	type ContextTruncation,
	type ClineMessage,
	type ClineSay,
	type ClineAsk,
	type ToolProgressStatus,
	type HistoryItem,
	type CreateTaskOptions,
	type ModelInfo,
	type ClineApiReqCancelReason,
	type ClineApiReqInfo,
	RooCodeEventName,
	TelemetryEventName,
	TaskStatus,
	TodoItem,
	getApiProtocol,
	getModelId,
	isRetiredProvider,
	isIdleAsk,
	isInteractiveAsk,
	isResumableAsk,
	QueuedMessage,
	DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	MAX_CHECKPOINT_TIMEOUT_SECONDS,
	MIN_CHECKPOINT_TIMEOUT_SECONDS,
	ConsecutiveMistakeError,
	MAX_MCP_TOOLS_THRESHOLD,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { CloudService } from "@roo-code/cloud"

// api
import { ApiHandler, ApiHandlerCreateMessageMetadata, buildApiHandler } from "../../api"
import { BackgroundModelHandler } from "../../api/BackgroundModelHandler"
import { MemoryCoordinator } from "../memory/memoryTaskIntegration"
import { isAutoMemoryEnabled } from "../memory/paths"
import { ApiStream, GroundingSource } from "../../api/transform/stream"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"

// shared
import { findLastIndex } from "../../shared/array"
import { combineApiRequests } from "../../shared/combineApiRequests"
import { combineCommandSequences } from "../../shared/combineCommandSequences"
import { t } from "../../i18n"
import { getApiMetrics, hasTokenUsageChanged, hasToolUsageChanged } from "../../shared/getApiMetrics"
import { ClineAskResponse } from "../../shared/WebviewMessage"
import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { DiffStrategy, type ToolUse, type ToolParamName, toolParamNames } from "../../shared/tools"
import { getModelMaxOutputTokens } from "../../shared/api"

// services
import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { RepoPerTaskCheckpointService } from "../../services/checkpoints"

// integrations
import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider"
import { findToolName } from "../../integrations/misc/export-markdown"
import { RooTerminalProcess } from "../../integrations/terminal/types"

// utils
import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "../../shared/cost"
import { getWorkspacePath } from "../../utils/path"
import { sanitizeToolUseId } from "../../utils/tool-id"

// prompts
import { formatResponse } from "../prompts/responses"
import { SYSTEM_PROMPT } from "../prompts/system"
import { buildNativeToolsArrayWithRestrictions } from "./build-tools"

// core modules
import { ArtifactStore } from "../artifacts/ArtifactStore"
import { applyToolResultSpill, type ToolResultSpillContext } from "../artifacts/spillPolicy"
import { ToolRepetitionDetector } from "../tools/ToolRepetitionDetector"
import { restoreTodoListForTask } from "../tools/UpdateTodoListTool"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { RooProtectedController } from "../protect/RooProtectedController"
import { type AssistantMessageContent, presentAssistantMessage } from "../assistant-message"
import { NativeToolCallParser } from "../assistant-message/NativeToolCallParser"
import { ClineProvider } from "../webview/ClineProvider"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import {
	type ApiMessage,
	readApiMessages,
	saveApiMessages,
	readTaskMessages,
	saveTaskMessages,
	taskMetadata,
} from "../task-persistence"
import { getEnvironmentDetails } from "../environment/getEnvironmentDetails"
import { checkContextWindowExceededError } from "../context/context-management/context-error-handling"
import {
	type CheckpointDiffOptions,
	type CheckpointRestoreOptions,
	getCheckpointService,
	checkpointSave,
	checkpointRestore,
	checkpointDiff,
} from "../checkpoints"
import { processUserContentMentions } from "../mentions/processUserContentMentions"
import { getMessagesSinceLastSummary, getEffectiveApiHistory } from "../condense"
import { MessageQueueService } from "../message-queue/MessageQueueService"
import { AutoApprovalHandler, checkAutoApproval } from "../auto-approval"
import { MessageManager } from "../message-manager"
import { validateAndFixToolResultIds } from "./validateToolResultIds"
import { mergeConsecutiveApiMessages } from "./mergeConsecutiveApiMessages"
import { TaskHistory } from "./TaskHistory"
import { TaskAskSay } from "./TaskAskSay"
import { TaskStreamProcessor } from "./TaskStreamProcessor"
import { TaskTokenTracking } from "./TaskTokenTracking"
import { TaskContextManager, FORCED_CONTEXT_REDUCTION_PERCENT, MAX_CONTEXT_WINDOW_RETRIES } from "./TaskContextManager"
import { TaskLifecycle } from "./TaskLifecycle"
import { TaskSubtasks } from "./TaskSubtasks"
import {
	TaskApiLoop,
	resetGlobalApiRequestTime,
	getLastGlobalApiRequestTime,
	setLastGlobalApiRequestTime,
} from "./TaskApiLoop"
import { type UpdateApiReqMsgFn, type AbortStreamFn, type TokenSnapshot } from "./StreamProcessorTypes"

const MAX_EXPONENTIAL_BACKOFF_SECONDS = 600 // 10 minutes
const DEFAULT_USAGE_COLLECTION_TIMEOUT_MS = 5000 // 5 seconds

export interface TaskOptions extends CreateTaskOptions {
	provider: ClineProvider
	apiConfiguration: ProviderSettings
	enableCheckpoints?: boolean
	checkpointTimeout?: number
	consecutiveMistakeLimit?: number
	task?: string
	images?: string[]
	historyItem?: HistoryItem
	experiments?: Record<string, boolean>
	startTask?: boolean
	rootTask?: Task
	parentTask?: Task
	taskNumber?: number
	onCreated?: (task: Task) => void
	initialTodos?: TodoItem[]
	workspacePath?: string
	/** Initial status for the task's history item (e.g., "active" for child tasks) */
	initialStatus?: "active" | "delegated" | "completed"
	/**
	 * Explicit mode slug for this task, bypassing the global current mode. Used by
	 * headless background tasks (e.g. the `memory-writer` sandbox mode) and
	 * parallel subagents so they don't inherit / mutate the foreground mode.
	 */
	taskMode?: string
	/**
	 * Marks this task as a headless background task (memory writer / parallel
	 * subagent). Background tasks are not pushed onto the provider's `clineStack`,
	 * do not drive the webview, and skip their own memory background-writers.
	 */
	isBackground?: boolean
	/**
	 * Hard cap on assistant turns for a background task. When the loop reaches
	 * this many assistant turns the task aborts cleanly. `undefined` = no cap
	 * (normal foreground behavior).
	 */
	maxAgentTurns?: number
	/**
	 * Per-task auto-approval override, checked before the global auto-approval
	 * state. Returns `"approve"` / `"deny"` to resolve an ask without user
	 * interaction, or `undefined` to fall through to normal handling. Lets a
	 * headless task run autonomously without mutating global approval settings.
	 */
	autoApprovalOverride?: AutoApprovalOverride
	/**
	 * When true, file writes bypass the diff-view editor UI (no editor tabs) and
	 * are saved straight to disk. Used by background tasks so memory writes are
	 * invisible.
	 */
	silentWrites?: boolean
}

/**
 * A per-task auto-approval decision function. Given the ask type, its text, and
 * whether the target is a protected file, returns `"approve"` / `"deny"` to
 * short-circuit, or `undefined` to defer to the normal (global) auto-approval
 * flow. The function may be async; `undefined` falls through to the global flow.
 */
export type AutoApprovalOverride = (
	ask: ClineAsk,
	text?: string,
	isProtected?: boolean,
) => "approve" | "deny" | undefined | Promise<"approve" | "deny" | undefined>

export class Task extends EventEmitter<TaskEvents> implements TaskLike {
	readonly taskId: string
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	childTaskId?: string
	pendingNewTaskToolCallId?: string

	readonly instanceId: string
	readonly metadata: TaskMetadata

	todoList?: TodoItem[]

	readonly rootTask: Task | undefined = undefined
	readonly parentTask: Task | undefined = undefined
	readonly taskNumber: number
	readonly workspacePath: string

	/**
	 * The mode associated with this task. Persisted across sessions
	 * to maintain user context when reopening tasks from history.
	 *
	 * ## Lifecycle
	 *
	 * ### For new tasks:
	 * 1. Initially `undefined` during construction
	 * 2. Asynchronously initialized from provider state via `initializeTaskMode()`
	 * 3. Falls back to `defaultModeSlug` if provider state is unavailable
	 *
	 * ### For history items:
	 * 1. Immediately set from `historyItem.mode` during construction
	 * 2. Falls back to `defaultModeSlug` if mode is not stored in history
	 *
	 * ## Important
	 * This property should NOT be accessed directly until `taskModeReady` promise resolves.
	 * Use `getTaskMode()` for async access or `taskMode` getter for sync access after initialization.
	 *
	 * @private
	 * @see {@link getTaskMode} - For safe async access
	 * @see {@link taskMode} - For sync access after initialization
	 * @see {@link waitForModeInitialization} - To ensure initialization is complete
	 */
	private _taskMode: string | undefined

	/**
	 * Promise that resolves when the task mode has been initialized.
	 * This ensures async mode initialization completes before the task is used.
	 *
	 * ## Purpose
	 * - Prevents race conditions when accessing task mode
	 * - Ensures provider state is properly loaded before mode-dependent operations
	 * - Provides a synchronization point for async initialization
	 *
	 * ## Resolution timing
	 * - For history items: Resolves immediately (sync initialization)
	 * - For new tasks: Resolves after provider state is fetched (async initialization)
	 *
	 * @private
	 * @see {@link waitForModeInitialization} - Public method to await this promise
	 */
	private taskModeReady: Promise<void>

	/**
	 * The API configuration name (provider profile) associated with this task.
	 * Persisted across sessions to maintain the provider profile when reopening tasks from history.
	 *
	 * ## Lifecycle
	 *
	 * ### For new tasks:
	 * 1. Initially `undefined` during construction
	 * 2. Asynchronously initialized from provider state via `initializeTaskApiConfigName()`
	 * 3. Falls back to "default" if provider state is unavailable
	 *
	 * ### For history items:
	 * 1. Immediately set from `historyItem.apiConfigName` during construction
	 * 2. Falls back to undefined if not stored in history (for backward compatibility)
	 *
	 * ## Important
	 * If you need a non-`undefined` provider profile (e.g., for profile-dependent operations),
	 * wait for `taskApiConfigReady` first (or use `getTaskApiConfigName()`).
	 * The sync `taskApiConfigName` getter may return `undefined` for backward compatibility.
	 *
	 * @private
	 * @see {@link getTaskApiConfigName} - For safe async access
	 * @see {@link taskApiConfigName} - For sync access after initialization
	 */
	private _taskApiConfigName: string | undefined

	/**
	 * Promise that resolves when the task API config name has been initialized.
	 * This ensures async API config name initialization completes before the task is used.
	 *
	 * ## Purpose
	 * - Prevents race conditions when accessing task API config name
	 * - Ensures provider state is properly loaded before profile-dependent operations
	 * - Provides a synchronization point for async initialization
	 *
	 * ## Resolution timing
	 * - For history items: Resolves immediately (sync initialization)
	 * - For new tasks: Resolves after provider state is fetched (async initialization)
	 *
	 * @private
	 */
	private taskApiConfigReady: Promise<void>

	providerRef: WeakRef<ClineProvider>
	private readonly globalStoragePath: string
	abort: boolean = false
	currentRequestAbortController?: AbortController
	skipPrevResponseIdOnce: boolean = false

	// TaskStatus
	idleAsk?: ClineMessage
	resumableAsk?: ClineMessage
	interactiveAsk?: ClineMessage

	didFinishAbortingStream = false
	abandoned = false
	abortReason?: ClineApiReqCancelReason
	isInitialized = false
	isPaused: boolean = false

	/**
	 * True once a terminal lifecycle event (`TaskCompleted` or `TaskAborted`)
	 * has been emitted. Prevents double-emission and lets `dispose()` emit a
	 * final `TaskAborted` when the task is being torn down without a terminal
	 * signal — so waiters like `awaitTaskCompletion` resolve instead of hanging.
	 */
	private terminalEventEmitted = false

	// API
	apiConfiguration: ProviderSettings
	api: ApiHandler
	private autoApprovalHandler: AutoApprovalHandler

	/**
	 * Reset the global API request timestamp. This should only be used for testing.
	 * Delegates to TaskApiLoop module.
	 * @internal
	 */
	static resetGlobalApiRequestTime(): void {
		resetGlobalApiRequestTime()
	}

	/**
	 * Get the last global API request timestamp. Used for testing.
	 * Delegates to TaskApiLoop module.
	 * @internal
	 */
	static get lastGlobalApiRequestTime(): number | undefined {
		return getLastGlobalApiRequestTime()
	}

	toolRepetitionDetector: ToolRepetitionDetector
	rooIgnoreController?: RooIgnoreController
	rooProtectedController?: RooProtectedController
	fileContextTracker: FileContextTracker
	terminalProcess?: RooTerminalProcess

	// Editing
	diffViewProvider: DiffViewProvider
	diffStrategy?: DiffStrategy
	didEditFile: boolean = false

	// LLM Messages & Chat Messages
	apiConversationHistory: ApiMessage[] = []
	clineMessages: ClineMessage[] = []

	// Ask
	private askResponse?: ClineAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	public lastMessageTs?: number
	private autoApprovalTimeoutRef?: NodeJS.Timeout

	// Tool Use
	consecutiveMistakeCount: number = 0
	consecutiveMistakeLimit: number
	consecutiveMistakeCountForApplyDiff: Map<string, number> = new Map()
	consecutiveMistakeCountForEditFile: Map<string, number> = new Map()
	consecutiveNoToolUseCount: number = 0
	consecutiveNoAssistantMessagesCount: number = 0
	// Auto-condense circuit breaker: consecutive futile (errored or non-reducing)
	// condense attempts. Once it reaches MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES the
	// condense step is skipped for the rest of the task; a genuine reduction resets it.
	consecutiveAutoCompactFailures: number = 0
	// Non-destructive microcompaction: tool_use_ids whose results should be cleared
	// at SEND time (content replaced on the outgoing copy only; stored history stays
	// pristine). Transient — recomputed by the context manager on every request that
	// runs context management, so it stays correct across mid-task mode switches.
	microcompactedToolUseIds: Set<string> = new Set()
	// Estimated tokens the send-time microcompaction strip removed from the LAST
	// request. The provider then reports that DEFLATED size back to us, but the
	// stored history is still pristine — so the next request's threshold check must
	// add this back or it compares a full history against a stripped measurement and
	// oscillates (compact → looks small → don't compact → looks big → compact ...).
	// Transient, like `microcompactedToolUseIds`: recomputed every request that runs
	// context management, so a mid-task switch to a wider-context mode simply lands
	// on 0 instead of carrying a stale correction.
	microcompactStrippedTokens: number = 0
	toolUsage: ToolUsage = {}

	// Checkpoints
	enableCheckpoints: boolean
	checkpointTimeout: number
	checkpointService?: RepoPerTaskCheckpointService
	checkpointServiceInitializing = false

	// Memory recall coordinator. Lazily constructed on first access so it
	// picks up the live `api` handler (which may be rebuilt on profile switch)
	// and the current `memoryRecallEnabled` setting. `undefined` when memory or
	// recall is disabled, or when no `completePrompt`-capable handler is present.
	private _memoryCoordinator: MemoryCoordinator | undefined
	public get memoryCoordinator(): MemoryCoordinator | undefined {
		if (this._memoryCoordinator) return this._memoryCoordinator
		// `paths.ts` is the source of truth for the memory enable gate; if
		// memory is off (env or setting), skip constructing the coordinator.
		if (!isAutoMemoryEnabled()) return undefined
		const recallEnabled = this.providerRef.deref()?.getValue("memoryRecallEnabled") ?? true
		this._memoryCoordinator = new MemoryCoordinator({
			cwd: this.cwd,
			recallEnabled,
			readFileState: this._memoryReadFileState,
			apiHandler: this.api,
			taskId: this.taskId,
			// Surface "recalling memory…" in the UI while a prefetch runs.
			onActivity: (active) => this.providerRef.deref()?.setMemoryActivity("recall", active),
		})
		return this._memoryCoordinator
	}

	// Condense (context-compaction) API handler: the background model wrapped
	// with a fallback to the foreground `this.api`. Lazily resolved on first
	// access via `getCondenseApiHandler()` (async, because profile loading goes
	// through `providerSettingsManager.getProfile`). Invalidated on
	// `updateApiConfiguration` (foreground config changed) and re-keyed by the
	// `autoCondenseContextApiConfigId` value it was built for, so a mid-task
	// change of the setting takes effect on the next resolve even for tasks
	// that never receive `updateApiConfiguration` (paused parents, background
	// subagents). When no `autoCondenseContextApiConfigId` is configured, or the
	// id is stale, or `buildApiHandler` throws, the wrapper is a passthrough to
	// `this.api` — identical to today's behavior.
	private _condenseApiHandler: BackgroundModelHandler | undefined
	// The setting value `_condenseApiHandler` was built for; compared against
	// the live setting on each resolve (cheap sync read from contextProxy).
	private _condenseApiHandlerConfigId: string | undefined
	/**
	 * Sync accessor for the cached condense handler. Returns a passthrough
	 * wrapper (background === undefined) until {@linkcode getCondenseApiHandler}
	 * has resolved the configured profile. Private to force external callers
	 * through the async {@linkcode getCondenseApiHandler} resolver, so a future
	 * sync caller can never silently bypass the configured background model.
	 * Internal (same-class) synchronous references are allowed.
	 */
	private get condenseApiHandler(): ApiHandler {
		if (this._condenseApiHandler) return this._condenseApiHandler
		// Passthrough wrapper — no background configured (yet).
		if (!this._condensePassthrough) {
			this._condensePassthrough = new BackgroundModelHandler({ fallback: this.api })
		}
		return this._condensePassthrough
	}
	private _condensePassthrough: ApiHandler | undefined

	/**
	 * Resolve and cache the condense handler. Reads
	 * `autoCondenseContextApiConfigId` from the provider, loads the profile via
	 * `providerSettingsManager.getProfile`, and builds a background handler with
	 * `buildApiHandler`. Returns a passthrough wrapper (background === undefined)
	 * if no id is configured, the id is stale, or construction throws — never
	 * throws. Subsequent calls return the cached wrapper until
	 * `updateApiConfiguration` invalidates it or the setting's value changes
	 * (the cache is keyed by the config id it was built for, so tasks that
	 * never see `updateApiConfiguration` — paused parents, background
	 * subagents — still pick up a changed setting on their next condense).
	 */
	public async getCondenseApiHandler(): Promise<ApiHandler> {
		const configId = this.providerRef.deref()?.getValue("autoCondenseContextApiConfigId")
		if (this._condenseApiHandler && this._condenseApiHandlerConfigId === configId) {
			return this._condenseApiHandler
		}
		const background = await this.resolveBackgroundCondenseHandler(configId)
		this._condenseApiHandler = new BackgroundModelHandler({
			background,
			fallback: this.api,
			onFallback: ({ error }) => {
				const message = error instanceof Error ? error.message : String(error)
				this.providerRef.deref()?.log(`[condense] background model failed, falling back to main: ${message}`)
			},
		})
		this._condenseApiHandlerConfigId = configId
		this._condensePassthrough = undefined
		return this._condenseApiHandler
	}

	/**
	 * Sever an in-flight condense request. Called from
	 * `TaskLifecycle.cancelCurrentRequest` (Stop button / abort): the condense
	 * handler's background model is a separate ApiHandler from `this.api`, so
	 * cancelling `this.api` alone leaves a background condense stream running.
	 * Only the background handler needs severing here — the wrapper's fallback
	 * IS `this.api`, which the caller cancels itself.
	 */
	public cancelCondenseRequest(destroyClient = false): void {
		this._condenseApiHandler?.background?.cancelRequest?.(destroyClient)
	}

	/**
	 * Resolve the configured condense background profile into an `ApiHandler`.
	 * Returns `undefined` when no profile is configured, the id is stale, or
	 * `buildApiHandler` throws — never throws. Mirrors
	 * `ClineProvider.resolveMemoryWriterApiConfiguration` but returns a handler
	 * (condense is a direct LLM call, not a sub-task).
	 *
	 * Claim 2B defense-in-depth: after building the handler, warn (not block)
	 * when the background model's context window is much smaller than the
	 * foreground's. With the wrapper now reporting the background model for
	 * payload sizing (Claim 2A), a small background window sizes the payload
	 * down correctly — but condense only fires near the foreground window, so
	 * a tiny background model (e.g. 8k) will routinely reject the payload and
	 * fall back to foreground anyway, defeating the cost optimization. The
	 * 400-as-trigger fallback (Claim 2B/5) ensures correctness; this warning
	 * helps the user pick a sensibly-sized background model. Never throws — a
	 * capability read failure just skips the warning.
	 */
	private async resolveBackgroundCondenseHandler(id: string | undefined): Promise<ApiHandler | undefined> {
		const provider = this.providerRef.deref()
		if (!id || !provider) return undefined
		try {
			const { name: _name, ...profile } = await provider.providerSettingsManager.getProfile({ id })
			const handler = buildApiHandler(profile as ProviderSettings)
			// Defense-in-depth capability check (never throws). A background
			// window < 25% of the foreground window will routinely trigger 400
			// context_length_exceeded and fall back — the user should pick a
			// larger background model to actually realize the savings.
			try {
				const bgWindow = handler.getModel().info.contextWindow
				const fgWindow = this.api.getModel().info.contextWindow
				if (typeof bgWindow === "number" && typeof fgWindow === "number" && bgWindow > 0 && fgWindow > 0) {
					if (bgWindow < fgWindow * 0.25) {
						provider?.log(
							`[condense] background profile "${_name ?? id}" has a context window of ${bgWindow} ` +
								`tokens vs the foreground model's ${fgWindow}. Condense fires near the ` +
								`foreground window, so this background model will routinely reject the ` +
								`payload (400) and fall back to the foreground — defeating the cost ` +
								`savings. Consider a background model with a larger context window.`,
						)
					}
				}
			} catch {
				// Capability read failed (e.g. handler doesn't expose getModel
				// cleanly) — skip the warning, the 400-as-trigger fallback
				// still ensures correctness.
			}
			return handler
		} catch (error) {
			provider?.log(
				`[condense] failed to load background profile ${id}, falling back to foreground: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			return undefined
		}
	}
	// Memory dedup cache (Roo has no readFileState primitive; the coordinator
	// owns one purely for surfacing dedup against prior turns).
	private _memoryReadFileState = new Map<
		string,
		{ content: string; timestamp: number; offset?: number; limit?: number }
	>()
	// Monotonic API-loop iteration counter, shared with the lifecycle for the
	// recall consume-once guard.
	public apiLoopIteration = 0

	// Message Queue Service
	public readonly messageQueueService: MessageQueueService
	private messageQueueStateChangedHandler: (() => void) | undefined

	// Streaming
	isWaitingForFirstChunk = false
	isStreaming = false
	currentStreamingContentIndex = 0
	currentStreamingDidCheckpoint = false
	// Pre-edit checkpoint started eagerly while a write tool's arguments are
	// still streaming; awaited by checkpointSaveAndMark before the edit lands.
	pendingCheckpointSave: Promise<void> | undefined = undefined
	assistantMessageContent: AssistantMessageContent[] = []
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false
	userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam)[] = []
	userMessageContentReady = false

	/**
	 * Tool names that the model has materialized via `tools_load` during this
	 * Task's lifetime. They are re-promoted into the active tools array on
	 * subsequent turns. Used only when the `deferredTools` experiment is on.
	 */
	materializedDeferredTools: Set<string> = new Set<string>()

	/**
	 * Snapshot of the deferred tools' full schemas, keyed by canonical name.
	 * Refreshed at the start of each request by `ApiRequestBuilder` so that
	 * `tools_load` can resolve names without re-querying the MCP hub.
	 */
	deferredToolDirectory: Map<string, import("openai").default.Chat.ChatCompletionTool> = new Map()

	/**
	 * Flag indicating whether the assistant message for the current streaming session
	 * has been saved to API conversation history.
	 *
	 * This is critical for parallel tool calling: tools should NOT execute until
	 * the assistant message is saved. Otherwise, if a tool like `new_task` triggers
	 * `flushPendingToolResultsToHistory()`, the user message with tool_results would
	 * appear BEFORE the assistant message with tool_uses, causing API errors.
	 *
	 * Reset to `false` at the start of each API request.
	 * Set to `true` after the assistant message is saved in `recursivelyMakeClineRequests`.
	 */
	assistantMessageSavedToHistory = false

	/**
	 * Context for the tool-result spill policy: the artifact store plus the
	 * inline byte budget. Built lazily by `ensureToolResultSpill` because the
	 * task directory is resolved asynchronously, while the push below (the
	 * point where a tool result becomes conversation content) is synchronous.
	 */
	private toolResultSpill?: ToolResultSpillContext

	/** The task's artifact store; see `getArtifactStore`. */
	private artifactStore?: ArtifactStore

	/** In-flight store construction, so concurrent callers share one resolve. */
	private artifactStoreInit?: Promise<void>

	/**
	 * Resolves (once) the artifact store for this task.
	 *
	 * Shared by every feature that persists oversized text: the push-time spill
	 * policy and the deterministic pruner that runs under context pressure.
	 * Failure is not fatal and is not retried per call: the callers degrade to
	 * "keep everything inline", which is exactly the pre-artifact behavior.
	 */
	public async getArtifactStore(): Promise<ArtifactStore | undefined> {
		if (this.artifactStore) {
			return this.artifactStore
		}

		if (!this.artifactStoreInit) {
			this.artifactStoreInit = (async () => {
				try {
					this.artifactStore = await ArtifactStore.forTask(this.globalStoragePath, this.taskId)
				} catch (error) {
					console.warn("[Task#getArtifactStore] Artifact store unavailable:", error)
				} finally {
					this.artifactStoreInit = undefined
				}
			})()
		}

		await this.artifactStoreInit
		return this.artifactStore
	}

	/**
	 * Prepares (or refreshes) the tool-result spill policy for this task.
	 *
	 * Called from the tool-dispatch path before any result is pushed. Failure is
	 * not fatal: without a store the policy degrades to "keep everything
	 * inline", which is exactly today's behavior.
	 *
	 * @param maxInlineBytes - Byte budget a single tool result may occupy inline.
	 */
	public async ensureToolResultSpill(maxInlineBytes: number): Promise<void> {
		if (this.toolResultSpill) {
			// The setting can change mid-task; the store never does.
			this.toolResultSpill.maxInlineBytes = maxInlineBytes
			return
		}

		const store = await this.getArtifactStore()

		if (store) {
			this.toolResultSpill = { store, maxInlineBytes }
		}
	}

	/**
	 * Push a tool_result block to userMessageContent, preventing duplicates.
	 * Duplicate tool_use_ids cause API errors.
	 *
	 * This is the single choke point where a tool result becomes conversation
	 * content, so it is also where the spill policy runs: an oversized result is
	 * persisted as an artifact and replaced by a head/tail preview that cites
	 * the artifact id.
	 *
	 * @param toolResult - The tool_result block to add
	 * @param options.toolName - Canonical tool name, used for the spill bypass list
	 * @returns true if added, false if duplicate was skipped
	 */
	public pushToolResultToUserContent(
		toolResult: Anthropic.ToolResultBlockParam,
		options?: { toolName?: string },
	): boolean {
		const existingResult = this.userMessageContent.find(
			(block): block is Anthropic.ToolResultBlockParam =>
				block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
		)
		if (existingResult) {
			console.warn(
				`[Task#pushToolResultToUserContent] Skipping duplicate tool_result for tool_use_id: ${toolResult.tool_use_id}`,
			)
			return false
		}

		let blockToPush = toolResult

		if (typeof toolResult.content === "string") {
			const spilled = applyToolResultSpill(toolResult.content, options?.toolName, this.toolResultSpill)
			if (spilled.artifactId) {
				blockToPush = { ...toolResult, content: spilled.text }
			}
		}

		this.userMessageContent.push(blockToPush)
		return true
	}
	didRejectTool = false
	didAlreadyUseTool = false
	didToolFailInCurrentTurn = false
	didCompleteReadingStream = false
	private _started = false
	// No streaming parser is required.
	assistantMessageParser?: undefined
	private providerProfileChangeListener?: (config: { name: string; provider?: string }) => void

	// Native tool call streaming state (track which index each tool is at)
	private streamingToolCallIndices: Map<string, number> = new Map()

	// Cached model info for current streaming session (set at start of each API request)
	// This prevents excessive getModel() calls during tool execution
	cachedStreamingModel?: { id: string; info: ModelInfo }

	// Token Tracking module
	public readonly tokenTracking: TaskTokenTracking

	// Cloud Sync Tracking
	private cloudSyncedMessageTimestamps: Set<number> = new Set()

	// Initial status for the task's history item (set at creation time to avoid race conditions)
	private readonly initialStatus?: "active" | "delegated" | "completed"

	// Callback for TaskHistory to restore todo list (wraps module-level function)
	readonly restoreTodoListForTask: () => void

	// Task history management (extracted from Task)
	readonly history: TaskHistory

	// Ask/Say communication protocol (extracted from Task)
	readonly askSay: TaskAskSay

	// Stream processing (extracted from Task)
	readonly streamProcessor: TaskStreamProcessor

	// Context management (extracted from Task)
	readonly contextManager: TaskContextManager

	// Lifecycle management (extracted from Task)
	readonly lifecycle: TaskLifecycle

	// Subtask delegation and resumption (extracted from Task)
	readonly subtasks: TaskSubtasks

	// API loop orchestration (extracted from Task)
	readonly apiLoop: TaskApiLoop

	// Headless background task controls (memory writer / parallel subagents).
	// All default to the inert foreground values so normal tasks are unaffected.
	readonly isBackground: boolean
	readonly maxAgentTurns?: number
	autoApprovalOverride?: AutoApprovalOverride
	readonly silentWrites: boolean
	/** Assistant-turn counter used to enforce `maxAgentTurns`. */
	agentTurnCount = 0

	// MessageManager for high-level message operations (lazy initialized)
	private _messageManager?: MessageManager

	constructor({
		provider,
		apiConfiguration,
		enableCheckpoints = true,
		checkpointTimeout = DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
		consecutiveMistakeLimit = DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
		taskId,
		task,
		images,
		historyItem,
		experiments: experimentsConfig,
		startTask = true,
		rootTask,
		parentTask,
		taskNumber = -1,
		onCreated,
		initialTodos,
		workspacePath,
		initialStatus,
		taskMode,
		isBackground = false,
		maxAgentTurns,
		autoApprovalOverride,
		silentWrites = false,
	}: TaskOptions) {
		super()

		if (startTask && !task && !images && !historyItem) {
			throw new Error("Either historyItem or task/images must be provided")
		}

		if (
			!checkpointTimeout ||
			checkpointTimeout > MAX_CHECKPOINT_TIMEOUT_SECONDS ||
			checkpointTimeout < MIN_CHECKPOINT_TIMEOUT_SECONDS
		) {
			throw new Error(
				"checkpointTimeout must be between " +
					MIN_CHECKPOINT_TIMEOUT_SECONDS +
					" and " +
					MAX_CHECKPOINT_TIMEOUT_SECONDS +
					" seconds",
			)
		}

		this.taskId = historyItem ? historyItem.id : (taskId ?? uuidv7())
		this.rootTaskId = historyItem ? historyItem.rootTaskId : rootTask?.taskId
		this.parentTaskId = historyItem ? historyItem.parentTaskId : parentTask?.taskId
		this.childTaskId = undefined

		this.metadata = {
			task: historyItem ? historyItem.task : task,
			images: historyItem ? [] : images,
		}

		// Normal use-case is usually retry similar history task with new workspace.
		this.workspacePath = parentTask
			? parentTask.workspacePath
			: (workspacePath ?? getWorkspacePath(path.join(os.homedir(), "Desktop")))

		this.instanceId = crypto.randomUUID().slice(0, 8)
		this.taskNumber = -1

		this.rooIgnoreController = new RooIgnoreController(this.cwd)
		this.rooProtectedController = new RooProtectedController(this.cwd)
		this.fileContextTracker = new FileContextTracker(provider, this.taskId)

		this.rooIgnoreController.initialize().catch((error) => {
			console.error("Failed to initialize RooIgnoreController:", error)
		})

		this.apiConfiguration = apiConfiguration
		this.api = buildApiHandler(this.apiConfiguration)
		this.autoApprovalHandler = new AutoApprovalHandler()

		this.consecutiveMistakeLimit = consecutiveMistakeLimit ?? DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
		this.providerRef = new WeakRef(provider)
		this.globalStoragePath = provider.context.globalStorageUri.fsPath
		this.diffViewProvider = new DiffViewProvider(this.cwd, this)
		this.enableCheckpoints = enableCheckpoints
		this.checkpointTimeout = checkpointTimeout

		this.parentTask = parentTask
		this.taskNumber = taskNumber
		this.initialStatus = initialStatus

		// Headless background-task controls (memory writer / parallel subagents).
		this.isBackground = isBackground
		this.maxAgentTurns = maxAgentTurns
		this.autoApprovalOverride = autoApprovalOverride
		this.silentWrites = silentWrites

		// Store the task's mode and API config name when it's created.
		// For history items, use the stored values; for new tasks, we'll set them
		// after getting state.
		if (historyItem) {
			this._taskMode = historyItem.mode || defaultModeSlug
			this._taskApiConfigName = historyItem.apiConfigName
			this.taskModeReady = Promise.resolve()
			this.taskApiConfigReady = Promise.resolve()
			TelemetryService.instance.captureTaskRestarted(this.taskId)
		} else if (taskMode) {
			// Explicit per-task mode (headless background task / subagent): don't
			// read or mutate the global current mode.
			this._taskMode = taskMode
			this._taskApiConfigName = undefined
			this.taskModeReady = Promise.resolve()
			this.taskApiConfigReady = Promise.resolve()
		} else {
			// For new tasks, don't set the mode/apiConfigName yet - wait for async initialization.
			this._taskMode = undefined
			this._taskApiConfigName = undefined
			// Note: lifecycle methods will be called after lifecycle module is initialized below
			this.taskModeReady = Promise.resolve()
			this.taskApiConfigReady = Promise.resolve()
			TelemetryService.instance.captureTaskCreated(this.taskId)
		}

		this.assistantMessageParser = undefined

		this.messageQueueService = new MessageQueueService()

		this.messageQueueStateChangedHandler = () => {
			this.emit(RooCodeEventName.TaskUserMessage, this.taskId)
			this.emit(RooCodeEventName.QueuedMessagesUpdated, this.taskId, this.messageQueueService.messages)
			this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()
		}

		this.messageQueueService.on("stateChanged", this.messageQueueStateChangedHandler)

		// Initialize TaskLifecycle for lifecycle management FIRST
		// because it's needed for setupProviderProfileChangeListener and mode/api config initialization
		// Pass Task as TaskLifecycleAccess for property access.
		this.lifecycle = new TaskLifecycle(this as unknown as import("./TaskLifecycle").TaskLifecycleAccess)

		// Listen for provider profile changes to update parser state
		this.setupProviderProfileChangeListener(provider)

		// Set up diff strategy
		this.diffStrategy = new MultiSearchReplaceDiffStrategy()

		this.toolRepetitionDetector = new ToolRepetitionDetector(this.consecutiveMistakeLimit)

		// Initialize todo list if provided
		if (initialTodos && initialTodos.length > 0) {
			this.todoList = initialTodos
		}

		// Initialize TokenTracking module (handles token usage, tool usage metrics, and status)
		// Pass Task as TaskTokenTrackingAccess for property access
		this.tokenTracking = new TaskTokenTracking(
			this as unknown as import("./TaskTokenTracking").TaskTokenTrackingAccess,
		)

		// Initialize restoreTodoListForTask callback and TaskHistory
		// Pass Task as TaskHistoryAccess so property reads/writes go through the live
		// Task instance (critical for mutable primitives like abort, assistantMessageSavedToHistory).
		this.restoreTodoListForTask = () => restoreTodoListForTask(this)
		this.history = new TaskHistory(this as unknown as import("./TaskHistory").TaskHistoryAccess)

		// Initialize TaskAskSay for the ask/say communication protocol
		// Pass Task as TaskAskSayAccess so property reads/writes go through the live
		// Task instance (critical for mutable primitives like askResponse, lastMessageTs).
		this.askSay = new TaskAskSay(this as unknown as import("./TaskAskSay").TaskAskSayAccess)

		// Initialize TaskStreamProcessor for stream processing logic
		// Pass Task as TaskStreamProcessorAccess for property access, plus the full Task
		// reference for presentAssistantMessage() calls which require the complete Task object.
		this.streamProcessor = new TaskStreamProcessor(
			this as unknown as import("./TaskStreamProcessor").TaskStreamProcessorAccess,
			this,
		)

		// Initialize TaskContextManager for context management logic
		// Pass Task as TaskContextManagerAccess for property access.
		this.contextManager = new TaskContextManager(
			this as unknown as import("./TaskContextManager").TaskContextManagerAccess,
		)

		// Initialize TaskSubtasks for subtask delegation and resumption logic
		// Pass Task as TaskSubtasksAccess for property access.
		this.subtasks = new TaskSubtasks(this as unknown as import("./TaskSubtasks").TaskSubtasksAccess)

		// Initialize TaskApiLoop for API request loop orchestration
		// Pass Task as TaskApiLoopAccess for property access.
		this.apiLoop = new TaskApiLoop(this as unknown as import("./TaskApiLoop").TaskApiLoopAccess)

		// Memory background writers: run extraction/consolidation when this task
		// completes normally. `abortTask` already covers the cancelled/errored
		// paths, but a normal `attempt_completion` only emits `TaskCompleted` and
		// leaves the task alive (it is later abandoned-aborted, which skips the
		// writers) — so hook completion here. The trigger is idempotent
		// (cursor-based, early-returns on no new messages) and gated to the main
		// agent internally, so double-firing with a later abort is safe. The
		// listener is cleaned up by `removeAllListeners()` in dispose().
		this.on(RooCodeEventName.TaskCompleted, () => {
			// Background tasks (the memory writer itself, parallel subagents) must
			// not spawn their own memory writers — that would recurse.
			if (this.isBackground) return
			try {
				this.lifecycle.triggerMemoryBackgroundWriters()
			} catch (error) {
				console.error(
					`[Task#${this.taskId}.${this.instanceId}] memory writers on completion failed:`,
					error instanceof Error ? error.message : String(error),
				)
			}
		})

		// Now initialize mode/api config for new tasks (after lifecycle is ready)
		if (!historyItem && !taskMode) {
			this.taskModeReady = this.initializeTaskMode(provider)
			this.taskApiConfigReady = this.initializeTaskApiConfigName(provider)
		}

		onCreated?.(this)

		if (startTask) {
			this._started = true
			if (task || images) {
				this.lifecycle.startTask(task, images)
			} else if (historyItem) {
				this.lifecycle.resumeTaskFromHistory().catch((error) => {
					if (this.abandoned || this.abort) {
						return
					}
					console.error(
						`[Task#${this.taskId}.${this.instanceId}] resumeTaskFromHistory failed:`,
						error instanceof Error ? error.message : String(error),
					)
					const provider = this.providerRef.deref()
					provider?.postStateToWebview().catch(() => {})
				})
			} else {
				throw new Error("Either historyItem or task/images must be provided")
			}
		}
	}

	/**
	 * Initialize the task mode from the provider state.
	 * Delegates to TaskLifecycle module.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskMode(provider: ClineProvider): Promise<void> {
		return this.lifecycle.initializeTaskMode(provider)
	}

	/**
	 * Initialize the task API config name from the provider state.
	 * Delegates to TaskLifecycle module.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskApiConfigName(provider: ClineProvider): Promise<void> {
		return this.lifecycle.initializeTaskApiConfigName(provider)
	}

	/**
	 * Sets up a listener for provider profile changes.
	 * Delegates to TaskLifecycle module.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to listen to
	 */
	private setupProviderProfileChangeListener(provider: ClineProvider): void {
		this.lifecycle.setupProviderProfileChangeListener(provider)
	}

	/**
	 * Wait for the task mode to be initialized before proceeding.
	 * This method ensures that any operations depending on the task mode
	 * will have access to the correct mode value.
	 *
	 * ## When to use
	 * - Before accessing mode-specific configurations
	 * - When switching between tasks with different modes
	 * - Before operations that depend on mode-based permissions
	 *
	 * ## Example usage
	 * ```typescript
	 * // Wait for mode initialization before mode-dependent operations
	 * await task.waitForModeInitialization();
	 * const mode = task.taskMode; // Now safe to access synchronously
	 *
	 * // Or use with getTaskMode() for a one-liner
	 * const mode = await task.getTaskMode(); // Internally waits for initialization
	 * ```
	 *
	 * @returns Promise that resolves when the task mode is initialized
	 * @public
	 */
	/**
	 * Wait for the task mode to be initialized before proceeding.
	 * Delegates to TaskLifecycle module.
	 *
	 * @returns Promise that resolves when the task mode is initialized
	 * @public
	 */
	public async waitForModeInitialization(): Promise<void> {
		return this.lifecycle.waitForModeInitialization()
	}

	/**
	 * Get the task mode asynchronously, ensuring it's properly initialized.
	 * Delegates to TaskLifecycle module.
	 *
	 * @returns Promise resolving to the task mode string
	 * @public
	 */
	public async getTaskMode(): Promise<string> {
		return this.lifecycle.getTaskMode()
	}

	/**
	 * Get the task mode synchronously. This should only be used when you're certain
	 * that the mode has already been initialized.
	 * Delegates to TaskLifecycle module.
	 *
	 * @throws {Error} If the mode hasn't been initialized yet
	 * @returns The task mode string
	 * @public
	 */
	public get taskMode(): string {
		return this.lifecycle.taskMode
	}

	/**
	 * Wait for the task API config name to be initialized before proceeding.
	 * Delegates to TaskLifecycle module.
	 *
	 * @returns Promise that resolves when the task API config name is initialized
	 * @public
	 */
	public async waitForApiConfigInitialization(): Promise<void> {
		return this.lifecycle.waitForApiConfigInitialization()
	}

	/**
	 * Get the task API config name asynchronously, ensuring it's properly initialized.
	 * Delegates to TaskLifecycle module.
	 *
	 * @returns Promise resolving to the task API config name string or undefined
	 * @public
	 */
	public async getTaskApiConfigName(): Promise<string | undefined> {
		return this.lifecycle.getTaskApiConfigName()
	}

	/**
	 * Get the task API config name synchronously.
	 * Delegates to TaskLifecycle module.
	 *
	 * @returns The task API config name string or undefined
	 * @public
	 */
	public get taskApiConfigName(): string | undefined {
		return this.lifecycle.taskApiConfigName
	}

	/**
	 * Update the task's API config name.
	 * Delegates to TaskLifecycle module.
	 *
	 * @param apiConfigName - The new API config name to set
	 * @internal
	 */
	public setTaskApiConfigName(apiConfigName: string | undefined): void {
		this.lifecycle.setTaskApiConfigName(apiConfigName)
	}

	static create(options: TaskOptions): [Task, Promise<void>] {
		const instance = new Task({ ...options, startTask: false })
		const { images, task, historyItem } = options
		let promise

		if (images || task) {
			promise = instance.lifecycle.startTask(task, images)
		} else if (historyItem) {
			promise = instance.lifecycle.resumeTaskFromHistory()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		return [instance, promise]
	}

	// API Messages

	private async getSavedApiConversationHistory(): Promise<ApiMessage[]> {
		return this.history.getSavedApiConversationHistory()
	}

	private async addToApiConversationHistory(message: Anthropic.MessageParam, reasoning?: string) {
		return this.history.addToApiConversationHistory(message, reasoning)
	}

	// NOTE: We intentionally do NOT mutate stored messages to merge consecutive user turns.
	// For API requests, consecutive same-role messages are merged via mergeConsecutiveApiMessages()
	// so rewind/edit behavior can still reference original message boundaries.

	async overwriteApiConversationHistory(newHistory: ApiMessage[]) {
		return this.history.overwriteApiConversationHistory(newHistory)
	}

	/**
	 * Flush any pending tool results to the API conversation history.
	 *
	 * This is critical when the task is about to be
	 * delegated (e.g., via new_task). Before delegation, if other tools were
	 * called in the same turn before new_task, their tool_result blocks are
	 * accumulated in `userMessageContent` but haven't been saved to the API
	 * history yet. If we don't flush them before the parent is disposed,
	 * the API conversation will be incomplete and cause 400 errors when
	 * the parent resumes (missing tool_result for tool_use blocks).
	 *
	 * NOTE: The assistant message is typically already in history by the time
	 * tools execute (added in recursivelyMakeClineRequests after streaming completes).
	 * So we usually only need to flush the pending user message with tool_results.
	 */
	public async flushPendingToolResultsToHistory(): Promise<boolean> {
		return this.history.flushPendingToolResultsToHistory()
	}

	private async saveApiConversationHistory(): Promise<boolean> {
		return this.history.saveApiConversationHistory()
	}

	/**
	 * Public wrapper to retry saving the API conversation history.
	 * Uses exponential backoff: up to 3 attempts with delays of 100 ms, 500 ms, 1500 ms.
	 * Used by delegation flow when flushPendingToolResultsToHistory reports failure.
	 */
	public async retrySaveApiConversationHistory(): Promise<boolean> {
		return this.history.retrySaveApiConversationHistory()
	}

	// Cline Messages

	private async getSavedClineMessages(): Promise<ClineMessage[]> {
		return this.history.getSavedClineMessages()
	}

	private async addToClineMessages(message: ClineMessage) {
		return this.history.addToClineMessages(message)
	}

	public async overwriteClineMessages(newMessages: ClineMessage[]) {
		return this.history.overwriteClineMessages(newMessages)
	}

	private async updateClineMessage(message: ClineMessage) {
		return this.history.updateClineMessage(message)
	}

	private async saveClineMessages(): Promise<boolean> {
		return this.history.saveClineMessages()
	}

	private findMessageByTimestamp(ts: number): ClineMessage | undefined {
		return this.history.findMessageByTimestamp(ts)
	}

	// Note that `partial` has three valid states true (partial message),
	// false (completion of partial message), undefined (individual complete
	// message).
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
		return this.askSay.ask(type, text, partial, progressStatus, isProtected)
	}

	handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]) {
		this.askSay.handleWebviewAskResponse(askResponse, text, images)
	}

	/**
	 * Cancel any pending auto-approval timeout.
	 * Called when user interacts (types, clicks buttons, etc.) to prevent the timeout from firing.
	 */
	public cancelAutoApprovalTimeout(): void {
		this.askSay.cancelAutoApprovalTimeout()
	}

	public approveAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.askSay.approveAsk({ text, images })
	}

	public denyAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.askSay.denyAsk({ text, images })
	}

	public supersedePendingAsk(): void {
		this.askSay.supersedePendingAsk()
	}

	/**
	 * Updates the API configuration and rebuilds the API handler.
	 * There is no tool-protocol switching or tool parser swapping.
	 *
	 * @param newApiConfiguration - The new API configuration to use
	 */
	public updateApiConfiguration(newApiConfiguration: ProviderSettings): void {
		// Update the configuration and rebuild the API handler
		this.apiConfiguration = newApiConfiguration
		this.api = buildApiHandler(this.apiConfiguration)
		// Invalidate the cached MemoryCoordinator so the next lazy-getter
		// access rebuilds it against the new handler. Without this, memory-recall
		// side-queries keep running on the old (possibly dead-credentials)
		// handler after a mid-task profile switch (MEM-1).
		this._memoryCoordinator = undefined
		// Invalidate the cached condense (context-compaction) handler so the
		// next access rebuilds the BackgroundModelHandler against the new
		// `this.api` (fallback) and re-resolves the background profile. Without
		// this, a mid-task profile switch would keep condensing on the old
		// handler.
		this._condenseApiHandler = undefined
		this._condenseApiHandlerConfigId = undefined
		this._condensePassthrough = undefined
	}

	public async submitUserMessage(
		text: string,
		images?: string[],
		mode?: string,
		providerProfile?: string,
	): Promise<void> {
		try {
			text = (text ?? "").trim()
			images = images ?? []

			if (text.length === 0 && images.length === 0) {
				return
			}

			const provider = this.providerRef.deref()

			if (provider) {
				if (mode) {
					await provider.setMode(mode)
				}

				if (providerProfile) {
					await provider.setProviderProfile(providerProfile)

					// Update this task's API configuration to match the new profile
					// This ensures the parser state is synchronized with the selected model
					const newState = await provider.getState()
					if (newState?.apiConfiguration) {
						this.updateApiConfiguration(newState.apiConfiguration)
					}
				}

				this.emit(RooCodeEventName.TaskUserMessage, this.taskId)

				// Handle the message directly instead of routing through the webview.
				// This avoids a race condition where the webview's message state hasn't
				// hydrated yet, causing it to interpret the message as a new task request.
				this.askSay.handleWebviewAskResponse("messageResponse", text, images)
			} else {
				console.error("[Task#submitUserMessage] Provider reference lost")
			}
		} catch (error) {
			console.error("[Task#submitUserMessage] Failed to submit user message:", error)
		}
	}

	async handleTerminalOperation(terminalOperation: "continue" | "abort") {
		if (terminalOperation === "continue") {
			this.terminalProcess?.continue()
		} else if (terminalOperation === "abort") {
			this.terminalProcess?.abort()
		}
	}

	private async getFilesReadByRooSafely(context: string): Promise<string[] | undefined> {
		return this.contextManager.getFilesReadByRooSafely(context)
	}

	public async condenseContext(): Promise<void> {
		return this.contextManager.condenseContext()
	}

	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
		options: {
			isNonInteractive?: boolean
		} = {},
		contextCondense?: ContextCondense,
		contextTruncation?: ContextTruncation,
	): Promise<undefined> {
		return this.askSay.say(
			type,
			text,
			images,
			partial,
			checkpoint,
			progressStatus,
			options,
			contextCondense,
			contextTruncation,
		)
	}

	async sayAndCreateMissingParamError(toolName: ToolName, paramName: string, relPath?: string) {
		return this.askSay.sayAndCreateMissingParamError(toolName, paramName, relPath)
	}

	// Lifecycle
	// Start / Resume / Abort / Dispose

	/**
	 * Get enabled MCP tools count for this task.
	 * Returns the count along with the number of servers contributing.
	 *
	 * @returns Object with enabledToolCount and enabledServerCount
	 */
	private async getEnabledMcpToolsCount(): Promise<{ enabledToolCount: number; enabledServerCount: number }> {
		return this.contextManager.getEnabledMcpToolsCount()
	}

	/**
	 * Manually start a **new** task when it was created with `startTask: false`.
	 * Delegates to TaskLifecycle module.
	 */
	public start(): void {
		this.lifecycle.start()
	}

	/**
	 * Start a new task with the given task text and images.
	 * Delegates to TaskLifecycle module.
	 *
	 * @param task - The task text
	 * @param images - Optional array of image paths
	 */
	private async startTask(task?: string, images?: string[]): Promise<void> {
		return this.lifecycle.startTask(task, images)
	}

	/**
	 * Resume a task from history.
	 * Delegates to TaskLifecycle module.
	 */
	private async resumeTaskFromHistory(): Promise<void> {
		return this.lifecycle.resumeTaskFromHistory()
	}

	/**
	 * Cancels the current HTTP request if one is in progress.
	 * Delegates to TaskLifecycle module.
	 *
	 * @param destroyClient - If true, tells the provider to destroy its client to sever connections.
	 */
	public cancelCurrentRequest(destroyClient: boolean = false): void {
		this.lifecycle.cancelCurrentRequest(destroyClient)
	}

	/**
	 * Force emit a final token usage update, ignoring throttle.
	 * Called before task completion or abort to ensure final stats are captured.
	 */
	public emitFinalTokenUsageUpdate(): void {
		this.tokenTracking.emitFinalTokenUsageUpdate()
	}

	/**
	 * Abort the task, stopping any running operations and cleaning up.
	 * Delegates to TaskLifecycle module.
	 *
	 * @param isAbandoned - If true, marks the task as abandoned
	 */
	public async abortTask(isAbandoned = false): Promise<void> {
		return this.lifecycle.abortTask(isAbandoned)
	}

	/**
	 * Track terminal lifecycle events so `dispose()` can emit a final
	 * `TaskAborted` when the task is torn down without one. Overriding `emit`
	 * (rather than wrapping each call site) catches every emitter —
	 * `TaskLifecycle.abortTask`, `AttemptCompletionTool`, and any future
	 * caller — through a single chokepoint.
	 */
	public override emit<K extends keyof TaskEvents>(event: K, ...args: TaskEvents[K]): boolean {
		if (event === RooCodeEventName.TaskCompleted || event === RooCodeEventName.TaskAborted) {
			this.terminalEventEmitted = true
		}
		// Cast through unknown: Node's EventEmitter typings use a conditional
		// `Args<K, T>` that TypeScript can't relate back to `TaskEvents[K]` when
		// spreading generic rest tuples. The runtime behaviour is correct.
		return (super.emit as (event: K, ...args: TaskEvents[K]) => boolean)(event, ...args)
	}

	/**
	 * Dispose of all task resources.
	 * Delegates to TaskLifecycle module for most cleanup, with Task-specific
	 * cleanup for EventEmitter listeners.
	 *
	 * If no terminal event (`TaskCompleted` / `TaskAborted`) has been emitted
	 * yet, emits `TaskAborted` BEFORE removing listeners so that waiters like
	 * `awaitTaskCompletion` resolve instead of hanging forever. This covers
	 * direct `dispose()` calls that bypass `abortTask()` (e.g. test cleanup,
	 * extension shutdown). The `terminalEventEmitted` flag prevents
	 * double-emission when `dispose()` is reached via `abortTask()` (which
	 * already emitted `TaskAborted` before calling `this.lifecycle.dispose()`).
	 */
	public dispose(): void {
		// If no terminal event has fired, emit TaskAborted now so waiters
		// (awaitTaskCompletion, runWithConcurrency, provider event forwarding)
		// resolve. This MUST happen before removeAllListeners() so the handlers
		// are still attached and can run.
		if (!this.terminalEventEmitted) {
			try {
				this.emit(RooCodeEventName.TaskAborted)
			} catch (error) {
				console.error(
					`[Task#${this.taskId}.${this.instanceId}] Error emitting final TaskAborted during dispose:`,
					error instanceof Error ? error.message : String(error),
				)
			}
		}

		// Delegate most cleanup to lifecycle module
		this.lifecycle.dispose()

		// Task-specific cleanup: remove all event listeners
		// (EventEmitter is on Task itself, not accessible through lifecycle interface)
		try {
			this.removeAllListeners()
		} catch (error) {
			console.error("Error removing event listeners:", error)
		}
	}

	// Subtasks
	// Spawn / Wait / Complete
	// Delegates to TaskSubtasks module

	/**
	 * Start a subtask by delegating to the provider.
	 * Delegates to TaskSubtasks module.
	 *
	 * @param message - The message to send to the child task
	 * @param initialTodos - Initial todo items for the child task
	 * @param mode - The mode to use for the child task
	 * @returns Promise resolving to the child task
	 */
	public async startSubtask(message: string, initialTodos: TodoItem[], mode: string) {
		return this.subtasks.startSubtask(message, initialTodos, mode)
	}

	/**
	 * Resume parent task after delegation completion without showing resume ask.
	 * Delegates to TaskSubtasks module.
	 *
	 * This method:
	 * - Clears any pending ask states
	 * - Resets abort and streaming flags
	 * - Ensures next API call includes full context
	 * - Immediately continues task loop without user interaction
	 */
	public async resumeAfterDelegation(): Promise<void> {
		return this.subtasks.resumeAfterDelegation()
	}

	// Task Loop

	/**
	 * Initiates the task loop that drives recursive API requests.
	 * Delegates to TaskApiLoop module.
	 *
	 * @param userContent - The initial user content to send
	 */
	private async initiateTaskLoop(userContent: Anthropic.Messages.ContentBlockParam[]): Promise<void> {
		return this.apiLoop.initiateTaskLoop(userContent)
	}

	/**
	 * The main API request loop using stack-based iteration.
	 * Delegates to TaskApiLoop module.
	 */
	public async recursivelyMakeClineRequests(
		userContent: Anthropic.Messages.ContentBlockParam[],
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		return this.apiLoop.recursivelyMakeClineRequests(userContent, includeFileDetails)
	}

	/**
	 * Build the system prompt with MCP, mode, and custom instructions.
	 * Delegates to TaskApiLoop module.
	 */
	private async getSystemPrompt(): Promise<string> {
		return this.apiLoop.getSystemPrompt()
	}

	/**
	 * Get the current profile ID from state.
	 * Delegates to TaskApiLoop module.
	 */
	private getCurrentProfileId(state: any): string {
		return this.apiLoop.getCurrentProfileId(state)
	}

	/**
	 * Handle context window exceeded error.
	 * Delegates to TaskContextManager module via TaskApiLoop.
	 */
	private async handleContextWindowExceededError(): Promise<void> {
		return this.apiLoop.handleContextWindowExceededError()
	}

	/**
	 * Enforce the user-configured provider rate limit.
	 * Delegates to TaskApiLoop module.
	 */
	private async maybeWaitForProviderRateLimit(retryAttempt: number): Promise<void> {
		return this.apiLoop.maybeWaitForProviderRateLimit(retryAttempt)
	}

	/**
	 * Attempt an API request with retry logic.
	 * Delegates to TaskApiLoop module.
	 */
	public async *attemptApiRequest(
		retryAttempt: number = 0,
		options: { skipProviderRateLimit?: boolean } = {},
	): ApiStream {
		yield* this.apiLoop.attemptApiRequest(retryAttempt, options)
	}

	/**
	 * Shared exponential backoff for retries.
	 * Delegates to TaskApiLoop module.
	 */
	private async backoffAndAnnounce(retryAttempt: number, error: any): Promise<void> {
		return this.apiLoop.backoffAndAnnounce(retryAttempt, error)
	}

	/**
	 * Build clean conversation history by stripping reasoning blocks.
	 * Delegates to TaskApiLoop module.
	 */
	private buildCleanConversationHistory(
		messages: ApiMessage[],
	): Array<
		Anthropic.Messages.MessageParam | { type: "reasoning"; encrypted_content: string; id?: string; summary?: any[] }
	> {
		return this.apiLoop.buildCleanConversationHistory(messages, this.api.getModel().info.preserveReasoning === true)
	}

	// Checkpoints

	public async checkpointSave(force: boolean = false, suppressMessage: boolean = false) {
		return checkpointSave(this, force, suppressMessage)
	}

	public async checkpointRestore(options: CheckpointRestoreOptions) {
		return checkpointRestore(this, options)
	}

	public async checkpointDiff(options: CheckpointDiffOptions) {
		return checkpointDiff(this, options)
	}

	// Metrics (delegate to TokenTracking module)

	public combineMessages(messages: ClineMessage[]): ClineMessage[] {
		return this.tokenTracking.combineMessages(messages)
	}

	public getTokenUsage(): TokenUsage {
		return this.tokenTracking.getTokenUsage()
	}

	public recordToolUsage(toolName: ToolName): void {
		this.tokenTracking.recordToolUsage(toolName)
	}

	public recordToolError(toolName: ToolName, error?: string): void {
		this.tokenTracking.recordToolError(toolName, error)
	}

	// Getters (delegate to TokenTracking module)

	public get taskStatus(): TaskStatus {
		return this.tokenTracking.taskStatus
	}

	public get taskAsk(): ClineMessage | undefined {
		return this.tokenTracking.taskAsk
	}

	public get queuedMessages(): QueuedMessage[] {
		return this.tokenTracking.queuedMessages
	}

	public get tokenUsage(): TokenUsage | undefined {
		return this.tokenTracking.tokenUsage
	}

	public get cwd(): string {
		return this.workspacePath
	}

	/**
	 * Provides convenient access to high-level message operations.
	 * Uses lazy initialization - the MessageManager is only created when first accessed.
	 * Subsequent accesses return the same cached instance.
	 *
	 * ## Important: Single Coordination Point
	 *
	 * **All MessageManager operations must go through this getter** rather than
	 * instantiating `new MessageManager(task)` directly. This ensures:
	 * - A single shared instance for consistent behavior
	 * - Centralized coordination of all rewind/message operations
	 * - Ability to add internal state or instrumentation in the future
	 *
	 * @example
	 * ```typescript
	 * // Correct: Use the getter
	 * await task.messageManager.rewindToTimestamp(ts)
	 *
	 * // Incorrect: Do NOT create new instances directly
	 * // const manager = new MessageManager(task) // Don't do this!
	 * ```
	 */
	get messageManager(): MessageManager {
		if (!this._messageManager) {
			this._messageManager = new MessageManager(this)
		}
		return this._messageManager
	}

	/**
	 * Process any queued messages by dequeuing and submitting them.
	 * This ensures that queued user messages are sent when appropriate,
	 * preventing them from getting stuck in the queue.
	 *
	 * @param context - Context string for logging (e.g., the calling tool name)
	 */
	public processQueuedMessages(): void {
		this.tokenTracking.processQueuedMessages()
	}

	/**
	 * Emit token usage update with debouncing.
	 * This is exposed for TaskHistory to call when saving messages.
	 */
	public debouncedEmitTokenUsage(tokenUsage: TokenUsage, toolUsage: ToolUsage): void {
		this.tokenTracking.emitTokenUsageUpdate(tokenUsage, toolUsage)
	}

	// Expose token tracking snapshots for testing/debugging
	public get tokenUsageSnapshot(): TokenUsage | undefined {
		return this.tokenTracking.tokenUsageSnapshot
	}

	public set tokenUsageSnapshot(value: TokenUsage | undefined) {
		this.tokenTracking.tokenUsageSnapshot = value
	}

	public get toolUsageSnapshot(): ToolUsage | undefined {
		return this.tokenTracking.toolUsageSnapshot
	}

	public set toolUsageSnapshot(value: ToolUsage | undefined) {
		this.tokenTracking.toolUsageSnapshot = value
	}
}
