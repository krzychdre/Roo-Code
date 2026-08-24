import * as path from "path"

import {
	type TaskMetadata,
	type ProviderSettings,
	type ClineApiReqCancelReason,
	type ClineMessage,
	RooCodeEventName,
	getMaxMcpToolsThreshold,
} from "@roo-code/types"

import { type ClineProvider } from "../webview/ClineProvider"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"
import { getTaskDirectoryPath } from "../../utils/storage"
import { formatResponse } from "../prompts/responses"
import { type ApiMessage } from "../task-persistence"
import { type TaskHistory } from "./TaskHistory"
import { type TaskAskSay } from "./TaskAskSay"
import { type TaskContextManager } from "./TaskContextManager"
import { defaultModeSlug } from "../../shared/modes"
import { TaskResumption, type TaskResumptionAccess } from "./TaskResumption"
import { type MemoryCoordinator } from "../memory/memoryTaskIntegration"
import { logger } from "../../utils/logging"
import { t } from "../../i18n"
import {
	executeExtractMemories,
	drainPendingExtraction,
	executeAutoDream,
	drainPendingDreams,
	renderTranscript,
	type AutoDreamConfig,
	type TranscriptMessage,
} from "../memory"

import Anthropic from "@anthropic-ai/sdk"

/**
 * Interface for Task access needed by TaskLifecycle.
 * This is a narrow interface to minimize coupling between modules.
 */
export interface TaskLifecycleAccess {
	// Core identifiers
	taskId: string
	rootTaskId?: string
	parentTaskId?: string
	instanceId: string
	metadata: TaskMetadata
	workspacePath: string
	cwd: string

	// Provider reference and storage
	providerRef: WeakRef<ClineProvider>
	globalStoragePath: string

	// API configuration
	apiConfiguration: ProviderSettings
	api: { cancelRequest: ((destroyClient: boolean) => void) | undefined }
	// Severs an in-flight condense request on the background model. The condense
	// handler is a separate ApiHandler from `api`, so cancelling `api` alone
	// leaves a background-model condense stream running (post-cancel spend,
	// delayed abort).
	cancelCondenseRequest: (destroyClient: boolean) => void

	// Controllers and services
	rooIgnoreController?: { dispose: () => void }
	rooProtectedController?: { dispose: () => void }
	fileContextTracker: { dispose: () => void }
	diffViewProvider: { isEditing: boolean; revertChanges: () => Promise<void> }
	messageQueueService: { dispose: () => void; removeListener: (event: string, handler: () => void) => void }

	// Mutable state arrays (accessed directly for initialization/reset)
	clineMessages: ClineMessage[]
	apiConversationHistory: ApiMessage[]

	// Memory system: the recall coordinator (undefined if memory/recall off)
	// and the iteration counter shared with the API loop for consume-once.
	memoryCoordinator?: MemoryCoordinator
	apiLoopIteration?: number

	// Task state flags
	abort: boolean
	abandoned: boolean
	abortReason?: ClineApiReqCancelReason
	isInitialized: boolean
	isStreaming: boolean
	_started: boolean

	// Background task flag: true for memory writers / parallel subagents.
	// Background tasks must not trigger their own memory writers (unbounded
	// recursion) or drain extraction (they never start it).
	isBackground: boolean

	// Abort controller for current request
	currentRequestAbortController?: AbortController

	// Error counters
	consecutiveNoToolUseCount: number
	consecutiveNoAssistantMessagesCount: number

	// Mode/API config state
	_taskMode: string | undefined
	_taskApiConfigName: string | undefined
	taskModeReady: Promise<void>
	taskApiConfigReady: Promise<void>

	// Event listener
	providerProfileChangeListener?: (config: { name: string; provider?: string }) => void

	// Message queue handler
	messageQueueStateChangedHandler?: () => void

	// Delegated modules
	history: TaskHistory
	askSay: TaskAskSay
	contextManager: TaskContextManager

	// Methods needed
	emit: (event: RooCodeEventName, ...args: any[]) => boolean
	updateApiConfiguration: (newApiConfiguration: ProviderSettings) => void
	initiateTaskLoop: (userContent: Anthropic.Messages.ContentBlockParam[]) => Promise<void>
	emitFinalTokenUsageUpdate: () => void
	cancelCurrentRequest: (destroyClient?: boolean) => void
}

/**
 * TaskLifecycle handles task lifecycle management:
 * - Initialization (mode, API config)
 * - Starting tasks (new and from history)
 * - Abortion and disposal
 */
export class TaskLifecycle {
	// Delegate resumption logic to TaskResumption
	private readonly taskResumption: TaskResumption

	constructor(private readonly access: TaskLifecycleAccess) {
		// Pass the live access reference, not a destructured snapshot. `history`
		// and `askSay` are still undefined on the Task when TaskLifecycle is
		// constructed; freezing them by value here makes resumeTaskFromHistory
		// crash with "Cannot read properties of undefined".
		this.taskResumption = new TaskResumption(access)
	}

	// ======================
	// Initialization Methods
	// ======================

	/**
	 * Initialize the task mode from the provider state.
	 * This method handles async initialization with proper error handling.
	 *
	 * ## Flow
	 * 1. Attempts to fetch the current mode from provider state
	 * 2. Sets `_taskMode` to the fetched mode or `defaultModeSlug` if unavailable
	 * 3. Handles errors gracefully by falling back to default mode
	 * 4. Logs any initialization errors for debugging
	 *
	 * ## Error handling
	 * - Network failures when fetching provider state
	 * - Provider not yet initialized
	 * - Invalid state structure
	 *
	 * All errors result in fallback to `defaultModeSlug` to ensure task can proceed.
	 *
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	async initializeTaskMode(provider: ClineProvider): Promise<void> {
		try {
			const state = await provider.getState()
			this.access._taskMode = state?.mode || defaultModeSlug
		} catch (error) {
			// If there's an error getting state, use the default mode
			this.access._taskMode = defaultModeSlug
			// Use the provider's log method for better error visibility
			const errorMessage = `Failed to initialize task mode: ${error instanceof Error ? error.message : String(error)}`
			provider.log(errorMessage)
		}
	}

	/**
	 * Initialize the task API config name from the provider state.
	 * This method handles async initialization with proper error handling.
	 *
	 * ## Flow
	 * 1. Attempts to fetch the current API config name from provider state
	 * 2. Sets `_taskApiConfigName` to the fetched name or "default" if unavailable
	 * 3. Handles errors gracefully by falling back to "default"
	 * 4. Logs any initialization errors for debugging
	 *
	 * ## Error handling
	 * - Network failures when fetching provider state
	 * - Provider not yet initialized
	 * - Invalid state structure
	 *
	 * All errors result in fallback to "default" to ensure task can proceed.
	 *
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	async initializeTaskApiConfigName(provider: ClineProvider): Promise<void> {
		try {
			const state = await provider.getState()

			// Avoid clobbering a newer value that may have been set while awaiting provider state
			// (e.g., user switches provider profile immediately after task creation).
			if (this.access._taskApiConfigName === undefined) {
				this.access._taskApiConfigName = state?.currentApiConfigName ?? "default"
			}
		} catch (error) {
			// If there's an error getting state, use the default profile (unless a newer value was set).
			if (this.access._taskApiConfigName === undefined) {
				this.access._taskApiConfigName = "default"
			}
			// Use the provider's log method for better error visibility
			const errorMessage = `Failed to initialize task API config name: ${error instanceof Error ? error.message : String(error)}`
			provider.log(errorMessage)
		}
	}

	/**
	 * Sets up a listener for provider profile changes.
	 *
	 * @param provider - The ClineProvider instance to listen to
	 */
	setupProviderProfileChangeListener(provider: ClineProvider): void {
		// Only set up listener if provider has the on method (may not exist in test mocks)
		if (typeof provider.on !== "function") {
			return
		}

		this.access.providerProfileChangeListener = async () => {
			try {
				const newState = await provider.getState()
				if (newState?.apiConfiguration) {
					this.access.updateApiConfiguration(newState.apiConfiguration)
				}
			} catch (error) {
				console.error(
					`[Task#${this.access.taskId}.${this.access.instanceId}] Failed to update API configuration on profile change:`,
					error,
				)
			}
		}

		provider.on(RooCodeEventName.ProviderProfileChanged, this.access.providerProfileChangeListener)
	}

	// ======================
	// Mode/API Config Access
	// ======================

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
	 */
	async waitForModeInitialization(): Promise<void> {
		return this.access.taskModeReady
	}

	/**
	 * Get the task mode asynchronously, ensuring it's properly initialized.
	 * This is the recommended way to access the task mode as it guarantees
	 * the mode is available before returning.
	 *
	 * ## Async behavior
	 * - Internally waits for `taskModeReady` promise to resolve
	 * - Returns the initialized mode or `defaultModeSlug` as fallback
	 * - Safe to call multiple times - subsequent calls return immediately if already initialized
	 *
	 * ## Example usage
	 * ```typescript
	 * // Safe async access
	 * const mode = await task.getTaskMode();
	 * console.log(`Task is running in ${mode} mode`);
	 *
	 * // Use in conditional logic
	 * if (await task.getTaskMode() === 'architect') {
	 *   // Perform architect-specific operations
	 * }
	 * ```
	 *
	 * @returns Promise resolving to the task mode string
	 */
	async getTaskMode(): Promise<string> {
		await this.access.taskModeReady
		return this.access._taskMode || defaultModeSlug
	}

	/**
	 * Get the task mode synchronously. This should only be used when you're certain
	 * that the mode has already been initialized (e.g., after waitForModeInitialization).
	 *
	 * ## When to use
	 * - In synchronous contexts where async/await is not available
	 * - After explicitly waiting for initialization via `waitForModeInitialization()`
	 * - In event handlers or callbacks where mode is guaranteed to be initialized
	 *
	 * ## Example usage
	 * ```typescript
	 * // After ensuring initialization
	 * await task.waitForModeInitialization();
	 * const mode = task.taskMode; // Safe synchronous access
	 *
	 * // In an event handler after task is started
	 * task.on('taskStarted', () => {
	 *   console.log(`Task started in ${task.taskMode} mode`); // Safe here
	 * });
	 * ```
	 *
	 * @throws {Error} If the mode hasn't been initialized yet
	 * @returns The task mode string
	 */
	get taskMode(): string {
		if (this.access._taskMode === undefined) {
			throw new Error("Task mode accessed before initialization. Use getTaskMode() or wait for taskModeReady.")
		}

		return this.access._taskMode
	}

	/**
	 * Wait for the task API config name to be initialized before proceeding.
	 * This method ensures that any operations depending on the task's provider profile
	 * will have access to the correct value.
	 *
	 * ## When to use
	 * - Before accessing provider profile-specific configurations
	 * - When switching between tasks with different provider profiles
	 * - Before operations that depend on the provider profile
	 *
	 * @returns Promise that resolves when the task API config name is initialized
	 */
	async waitForApiConfigInitialization(): Promise<void> {
		return this.access.taskApiConfigReady
	}

	/**
	 * Get the task API config name asynchronously, ensuring it's properly initialized.
	 * This is the recommended way to access the task's provider profile as it guarantees
	 * the value is available before returning.
	 *
	 * ## Async behavior
	 * - Internally waits for `taskApiConfigReady` promise to resolve
	 * - Returns the initialized API config name or undefined as fallback
	 * - Safe to call multiple times - subsequent calls return immediately if already initialized
	 *
	 * @returns Promise resolving to the task API config name string or undefined
	 */
	async getTaskApiConfigName(): Promise<string | undefined> {
		await this.access.taskApiConfigReady
		return this.access._taskApiConfigName
	}

	/**
	 * Get the task API config name synchronously. This should only be used when you're certain
	 * that the value has already been initialized (e.g., after waitForApiConfigInitialization).
	 *
	 * ## When to use
	 * - In synchronous contexts where async/await is not available
	 * - After explicitly waiting for initialization via `waitForApiConfigInitialization()`
	 * - In event handlers or callbacks where API config name is guaranteed to be initialized
	 *
	 * Note: Unlike taskMode, this getter does not throw if uninitialized since the API config
	 * name can legitimately be undefined (backward compatibility with tasks created before
	 * this feature was added).
	 *
	 * @returns The task API config name string or undefined
	 */
	get taskApiConfigName(): string | undefined {
		return this.access._taskApiConfigName
	}

	/**
	 * Update the task's API config name. This is called when the user switches
	 * provider profiles while a task is active, allowing the task to remember
	 * its new provider profile.
	 *
	 * @param apiConfigName - The new API config name to set
	 */
	setTaskApiConfigName(apiConfigName: string | undefined): void {
		this.access._taskApiConfigName = apiConfigName
	}

	// ======================
	// Lifecycle Methods
	// ======================

	/**
	 * Start the task manually (for delegation flow).
	 * This is used when a task is created with startTask: false.
	 * Only starts if not already started.
	 */
	start(): void {
		if (this.access._started) {
			return
		}
		this.access._started = true

		const { task, images } = this.access.metadata

		if (task || images) {
			this.startTask(task ?? undefined, images ?? undefined)
		}
	}

	/**
	 * Start a new task with the given task text and images.
	 * Initializes conversation history and begins the task loop.
	 *
	 * @param task - The task text
	 * @param images - Optional array of image paths
	 */
	async startTask(task?: string, images?: string[]): Promise<void> {
		try {
			// `conversationHistory` (for API) and `clineMessages` (for webview)
			// need to be in sync.
			// If the extension process were killed, then on restart the
			// `clineMessages` might not be empty, so we need to set it to [] when
			// we create a new Cline client (otherwise webview would show stale
			// messages from previous session).
			this.access.clineMessages = []
			this.access.apiConversationHistory = []

			// The todo list is already set in the constructor if initialTodos were provided
			// No need to add any messages - the todoList property is already set

			await this.access.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

			await this.access.askSay.say("text", task, images)

			// Check for too many MCP tools and warn the user. The threshold is
			// relaxed when the `deferredTools` experiment is on, because deferred
			// loading keeps MCP tool schemas out of the per-turn prompt.
			const { enabledToolCount, enabledServerCount } = await this.access.contextManager.getEnabledMcpToolsCount()
			const deferredToolsEnabled =
				(await this.access.providerRef.deref()?.getState())?.experiments?.deferredTools === true
			const threshold = getMaxMcpToolsThreshold(deferredToolsEnabled)
			if (enabledToolCount > threshold) {
				await this.access.askSay.say(
					"too_many_tools_warning",
					JSON.stringify({
						toolCount: enabledToolCount,
						serverCount: enabledServerCount,
						threshold,
					}),
					undefined,
					undefined,
					undefined,
					undefined,
					{ isNonInteractive: true },
				)
			}
			this.access.isInitialized = true

			const imageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(images)

			// Task starting
			await this.access
				.initiateTaskLoop([
					{
						type: "text",
						text: `<user_message>\n${task}\n</user_message>`,
					},
					...imageBlocks,
				])
				.catch((error) => {
					// Swallow loop rejection when the task was intentionally abandoned/aborted
					// during delegation or user cancellation to prevent unhandled rejections.
					if (this.access.abandoned === true || this.access.abortReason === "user_cancelled") {
						return
					}
					throw error
				})
		} catch (error) {
			// In tests and some UX flows, tasks can be aborted while `startTask` is still
			// initializing. Treat abort/abandon as expected and avoid unhandled rejections.
			if (
				this.access.abandoned === true ||
				this.access.abort === true ||
				this.access.abortReason === "user_cancelled"
			) {
				return
			}
			throw error
		}
	}

	/**
	 * Resume a task from history, reconstructing conversation state.
	 * Delegates to TaskResumption module.
	 */
	async resumeTaskFromHistory(): Promise<void> {
		return this.taskResumption.resumeTaskFromHistory()
	}

	/**
	 * Cancels the current HTTP request if one is in progress.
	 * This immediately aborts the underlying stream rather than waiting for the next chunk.
	 *
	 * @param destroyClient - If true, tells the provider to destroy its client to sever connections.
	 *                        This is useful for local models that may continue inference even after abort.
	 */
	cancelCurrentRequest(destroyClient: boolean = false): void {
		if (this.access.currentRequestAbortController) {
			console.log(`[Task#${this.access.taskId}.${this.access.instanceId}] Aborting current HTTP request`)
			this.access.currentRequestAbortController.abort()
			this.access.currentRequestAbortController = undefined
		}

		// Tell the API provider to cancel its request and optionally destroy its client
		if (this.access.api.cancelRequest) {
			this.access.api.cancelRequest(destroyClient)
		}

		// The condense handler streams from a separate (background) provider;
		// cancelling `api` does not reach it. Without this, Stop during an
		// auto-condense served by the background model leaves the stream
		// running to completion (post-cancel token spend, delayed abort).
		// Optional call: partial access mocks in tests may not wire it.
		this.access.cancelCondenseRequest?.(destroyClient)
	}

	/**
	 * Abort the task, stopping any running operations and cleaning up.
	 *
	 * Split into three ordered phases so the load-bearing ordering — recently
	 * the source of several bugs (writers skipped on user-cancel + background,
	 * drains before dispose, TaskAborted emitted before dispose) — is explicit:
	 *
	 *   1. prepareAbort  — flags + emit + trigger memory writers
	 *   2. cleanupAbort  — dispose + persist messages
	 *   3. drainAbort    — await in-flight extraction/dreams
	 *
	 * @param isAbandoned - If true, marks the task as abandoned (different from user-cancelled)
	 */
	async abortTask(isAbandoned = false): Promise<void> {
		const isUserCancelled = this.prepareAbort(isAbandoned)
		await this.cleanupAbort()
		await this.drainAbort(isUserCancelled)
	}

	/**
	 * Phase 1 of abort: set flags, reset counters, force final token usage,
	 * emit TaskAborted, and trigger memory background writers.
	 *
	 * Ordering constraint: MUST run before cleanupAbort and drainAbort.
	 * Sets the `abort` flag that stops autonomously running promises, emits
	 * the abort event while task state is still intact, and fires memory
	 * writers before dispose tears anything down.
	 *
	 * @returns `isUserCancelled` — needed by drainAbort's guard.
	 */
	private prepareAbort(isAbandoned: boolean): boolean {
		// Aborting task

		// Will stop any autonomously running promises.
		if (isAbandoned) {
			this.access.abandoned = true
		}

		this.access.abort = true

		// Reset consecutive error counters on abort (manual intervention)
		this.access.consecutiveNoToolUseCount = 0
		this.access.consecutiveNoAssistantMessagesCount = 0

		// Force final token usage update before abort event
		this.access.emitFinalTokenUsageUpdate()

		this.access.emit(RooCodeEventName.TaskAborted)

		// Memory background writers: fire-and-forget extraction + dream at task
		// end. Both are gated internally (memory enabled, main agent, no direct
		// writes for extraction; time/session/lock cascade for dream) and run
		// as sandboxed sub-Tasks. Abandoned tasks skip extraction (no durable
		// signal to save from an abandoned run). User-cancelled aborts also skip:
		// the writers spawn a fresh LLM request, so firing them here would put the
		// inference engine right back to work the moment the user pressed Stop
		// (completion is the durable extraction signal; a cancelled run has none).
		// We `void` the promises; the drain below awaits them with a soft timeout
		// so in-flight work isn't orphaned on extension shutdown.
		const isUserCancelled = this.access.abortReason === "user_cancelled"
		// Background tasks (memory writers, parallel subagents) must never
		// trigger their own memory writers — that would recurse unboundedly
		// (aborted background task → new background task → aborted → …).
		// They also never start extraction, so draining is pointless for them.
		if (!isAbandoned && !isUserCancelled && !this.access.isBackground) {
			try {
				this.triggerMemoryBackgroundWriters()
			} catch (error) {
				console.error("Error triggering memory background writers:", error)
			}
		}

		return isUserCancelled
	}

	/**
	 * Phase 2 of abort: dispose the task and persist final messages.
	 *
	 * Ordering constraint: MUST run after prepareAbort (flags set, writers
	 * triggered) and before drainAbort (messages must be persisted before
	 * we await background work that might reference them).
	 */
	private async cleanupAbort(): Promise<void> {
		try {
			this.dispose() // Call the centralized dispose method
		} catch (error) {
			console.error(`Error during task ${this.access.taskId}.${this.access.instanceId} disposal:`, error)
			// Don't rethrow - we want abort to always succeed
		}
		// Save the countdown message in the automatic retry or other content.
		try {
			// Save the countdown message in the automatic retry or other content.
			await this.access.history.saveClineMessages()
		} catch (error) {
			console.error(
				`Error saving messages during abort for task ${this.access.taskId}.${this.access.instanceId}:`,
				error,
			)
		}
	}

	/**
	 * Phase 3 of abort: drain in-flight memory extraction and dreams.
	 *
	 * Ordering constraint: MUST run after cleanupAbort (dispose + save done).
	 * Skipped on user cancel (holds isStreaming=true past cancelTask's 3s
	 * pWaitFor and freezes the UI) and for background tasks (they never start
	 * extraction/dreams, so there is nothing to drain).
	 */
	private async drainAbort(isUserCancelled: boolean): Promise<void> {
		// Drain in-flight memory extraction so it isn't orphaned on shutdown.
		// Soft 60s timeout (unref'd internally) so it never blocks process exit.
		// Skipped on user cancel: the stream loop awaits abortTask()
		// (TaskApiLoop.handleStreamError), so draining here holds isStreaming=true
		// past cancelTask's 3s pWaitFor and freezes the UI. In-flight extraction
		// runs as a provider-level background task and survives without the drain;
		// the drain only matters for extension shutdown. Also skipped for
		// background tasks: they never start extraction, so there is nothing to drain.
		// Same guards apply to dreams (MEM-2): skip drain on user cancel and for
		// background tasks — they never start dreams, so there is nothing to drain.
		if (!isUserCancelled && !this.access.isBackground) {
			try {
				await drainPendingExtraction(60_000)
				await drainPendingDreams(60_000)
			} catch (error) {
				console.error("Error draining memory background writers:", error)
			}
		}
	}

	/**
	 * Fire-and-forget the memory background writers (extraction + dream).
	 *
	 * Extraction saves memories the main agent didn't get to; dream
	 * periodically consolidates. Both are best-effort and sandboxed; both are
	 * skipped when memory is disabled or this isn't the main agent.
	 *
	 * Called on normal completion (via the task's `TaskCompleted` subscription)
	 * and on non-abandoned abort. Both entry points are idempotent: extraction
	 * is cursor-based and early-returns when there are no new messages, so a
	 * completion-then-abort sequence never double-writes.
	 *
	 * The runner is `provider.memorySubTaskRunner` (Phase 2), which spawns a
	 * headless, write-sandboxed background task that actually persists memories.
	 */
	public triggerMemoryBackgroundWriters(): void {
		const provider = this.access.providerRef.deref()
		if (!provider) return
		// The provider's `memorySubTaskRunner` spawns a headless, write-sandboxed
		// background task and returns the memory files it wrote (Phase 2). This is
		// what makes the writers actually persist memories.
		const subTaskRunner = provider.memorySubTaskRunner
		// Render the recent conversation so the *fresh* extraction sub-agent has
		// content to analyze (it can't fork the parent's context — see the plan).
		const transcript = renderTranscript(this.access.apiConversationHistory as unknown as TranscriptMessage[])
		// Fire-and-forget, but never let a rejection escape as an unhandledRejection
		// in the extension host (e.g. memory paths not initialized at activation).
		const logWriterFailure = (writer: string) => (e: unknown) => {
			logger.error(`[memory] ${writer} trigger failed: ${e instanceof Error ? e.message : String(e)}`)
		}
		executeExtractMemories({
			cwd: this.access.cwd,
			isMainAgent: !this.access.parentTaskId,
			taskId: this.access.taskId,
			messages: this.access
				.clineMessages as unknown as import("../memory/extractMemories").ExtractionMessageView[],
			transcript,
			subTaskRunner,
			onSaved: (count) => {
				if (count > 0) {
					console.log(`[memory] extractMemories saved ${count} memor${count === 1 ? "y" : "ies"}`)
					provider.notifyBackgroundOutcome(t("common:info.memory_saved", { count }))
				}
			},
		}).catch(logWriterFailure("extractMemories"))
		const dreamConfig: AutoDreamConfig = {
			enabled: provider.getValue("autoDreamEnabled") ?? true,
			minHours: provider.getValue("autoDreamMinHours") ?? 24,
			minSessions: provider.getValue("autoDreamMinSessions") ?? 5,
		}
		// HistoryItem uses `ts` (creation timestamp) as its time field; the
		// dream's session gate reads `lastModified`. Map the field. `ts` is a
		// creation-time snapshot, so it undercounts activity within a long
		// session — safe, since the gate is a skip-only throttle.
		void provider
			.getTaskHistory()
			.then((history) =>
				executeAutoDream({
					cwd: this.access.cwd,
					isMainAgent: !this.access.parentTaskId,
					config: dreamConfig,
					taskHistory: history.map((h) => ({
						lastModified: typeof h.ts === "number" ? h.ts : undefined,
					})),
					currentTaskId: this.access.taskId,
					subTaskRunner,
					onImproved: (count) => {
						if (count > 0) {
							console.log(`[memory] autoDream improved ${count} memor${count === 1 ? "y" : "ies"}`)
							provider.notifyBackgroundOutcome(t("common:info.memory_consolidated", { count }))
						}
					},
				}),
			)
			.catch(logWriterFailure("autoDream"))
	}

	/**
	 * Dispose of all task resources, cleaning up terminals, listeners, and controllers.
	 * This is the centralized cleanup method called on abort and task completion.
	 */
	dispose(): void {
		console.log(`[Task#dispose] disposing task ${this.access.taskId}.${this.access.instanceId}`)

		// Cancel any in-progress HTTP request
		try {
			this.access.cancelCurrentRequest()
		} catch (error) {
			console.error("Error cancelling current request:", error)
		}

		// Abort any in-flight memory recall prefetch so a lingering side-query
		// can't resolve after the task is gone.
		try {
			this.access.memoryCoordinator?.disposePrefetch()
		} catch (error) {
			console.error("Error disposing memory prefetch:", error)
		}

		// Remove provider profile change listener
		try {
			if (this.access.providerProfileChangeListener) {
				const provider = this.access.providerRef.deref()
				if (provider) {
					provider.off(RooCodeEventName.ProviderProfileChanged, this.access.providerProfileChangeListener)
				}
				this.access.providerProfileChangeListener = undefined
			}
		} catch (error) {
			console.error("Error removing provider profile change listener:", error)
		}

		// Dispose message queue and remove event listeners.
		try {
			if (this.access.messageQueueStateChangedHandler) {
				this.access.messageQueueService.removeListener(
					"stateChanged",
					this.access.messageQueueStateChangedHandler,
				)
				this.access.messageQueueStateChangedHandler = undefined
			}

			this.access.messageQueueService.dispose()
		} catch (error) {
			console.error("Error disposing message queue:", error)
		}

		// Remove all event listeners to prevent memory leaks.
		try {
			// Note: We cannot call removeAllListeners directly through the access interface
			// The Task itself handles this via its EventEmitter inheritance
		} catch (error) {
			console.error("Error removing event listeners:", error)
		}

		// Release any terminals associated with this task.
		try {
			// Release any terminals associated with this task.
			TerminalRegistry.releaseTerminalsForTask(this.access.taskId)
		} catch (error) {
			console.error("Error releasing terminals:", error)
		}

		// Cleanup command output artifacts.
		//
		// Deliberately NOT extended to the `artifacts/` directory: dispose() also
		// runs when the user stops a task, and the very same task can be rehydrated
		// afterwards with a history that still cites its spilled artifacts. Those
		// files are reclaimed when the task itself is deleted, because
		// `deleteTaskWithId` removes the whole task directory.
		getTaskDirectoryPath(this.access.globalStoragePath, this.access.taskId)
			.then((taskDir) => {
				const outputDir = path.join(taskDir, "command-output")
				return OutputInterceptor.cleanup(outputDir)
			})
			.catch((error) => {
				console.error("Error cleaning up command output artifacts:", error)
			})

		try {
			if (this.access.rooIgnoreController) {
				this.access.rooIgnoreController.dispose()
				this.access.rooIgnoreController = undefined
			}
		} catch (error) {
			console.error("Error disposing RooIgnoreController:", error)
			// This is the critical one for the leak fix.
		}

		try {
			this.access.fileContextTracker.dispose()
		} catch (error) {
			console.error("Error disposing file context tracker:", error)
		}

		try {
			// If we're not streaming then `abortStream` won't be called.
			if (this.access.isStreaming && this.access.diffViewProvider.isEditing) {
				this.access.diffViewProvider.revertChanges().catch(console.error)
			}
		} catch (error) {
			console.error("Error reverting diff changes:", error)
		}
	}
}
