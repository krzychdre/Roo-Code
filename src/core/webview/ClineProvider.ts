import os from "os"
import * as path from "path"
import fs from "fs/promises"
import EventEmitter from "events"

import { Anthropic } from "@anthropic-ai/sdk"
import delay from "delay"
import axios from "axios"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import {
	type TaskProviderLike,
	type TaskProviderEvents,
	type GlobalState,
	type ProviderName,
	type ProviderSettings,
	type RooCodeSettings,
	type ProviderSettingsEntry,
	type StaticAppProperties,
	type DynamicAppProperties,
	type CloudAppProperties,
	type TaskProperties,
	type GitProperties,
	type TelemetryProperties,
	type TelemetryPropertiesProvider,
	type CodeActionId,
	type CodeActionName,
	type TerminalActionId,
	type TerminalActionPromptType,
	type HistoryItem,
	type CloudUserInfo,
	type CloudOrganizationMembership,
	type CreateTaskOptions,
	type TokenUsage,
	type ToolUsage,
	type ExtensionMessage,
	type ExtensionState,
	type MarketplaceInstalledMetadata,
	RooCodeEventName,
	requestyDefaultModelId,
	openRouterDefaultModelId,
	DEFAULT_WRITE_DELAY_MS,
	ORGANIZATION_ALLOW_ALL,
	DEFAULT_MODES,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	DEFAULT_PARALLEL_TASKS_MAX_CONCURRENCY,
	DEFAULT_SUBAGENT_FOLLOWUP_TIMEOUT_SEC,
	getModelId,
	isRetiredProvider,
} from "@roo-code/types"
import { aggregateTaskCostsRecursive, type AggregatedCosts } from "./aggregateTaskCosts"
import { TelemetryService } from "@roo-code/telemetry"
import { CloudService, getRooCodeApiUrl } from "@roo-code/cloud"

import { Package } from "../../shared/package"
import { findLast } from "../../shared/array"
import { supportPrompt } from "../../shared/support-prompt"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { Mode, defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { experimentDefault } from "../../shared/experiments"
import { formatLanguage } from "../../shared/language"
import { WebviewMessage } from "../../shared/WebviewMessage"
import { EMBEDDING_MODEL_PROFILES } from "../../shared/embeddingModels"
import { ProfileValidator } from "../../shared/ProfileValidator"

import { Terminal } from "../../integrations/terminal/Terminal"
import { getCustomSoundsDir, resolveCustomSoundUri } from "../../integrations/misc/custom-sounds"
import { downloadTask, getTaskFileName } from "../../integrations/misc/export-markdown"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"
import { getTheme } from "../../integrations/theme/getTheme"
import WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker"

import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { MarketplaceManager } from "../../services/marketplace"
import { ShadowCheckpointService } from "../../services/checkpoints/ShadowCheckpointService"
import { CodeIndexManager } from "../../services/code-index/manager"
import type { IndexProgressUpdate } from "../../services/code-index/interfaces/manager"
import { MdmService } from "../../services/mdm/MdmService"
import { SkillsManager } from "../../services/skills/SkillsManager"

import { fileExistsAtPath } from "../../utils/fs"
import { getWorkspaceGitInfo } from "../../utils/git"
import { getWorkspacePath } from "../../utils/path"
import { OrganizationAllowListViolationError } from "../../utils/errors"

import { setPanel } from "../../activate/registerCommands"

import { t } from "../../i18n"

import { buildApiHandler } from "../../api"
import { forceFullModelDetailsLoad, hasLoadedFullDetails } from "../../api/providers/fetchers/lmstudio"

import { ContextProxy } from "../config/ContextProxy"
import { ProviderSettingsManager } from "../config/ProviderSettingsManager"
import { CustomModesManager } from "../config/CustomModesManager"
import { Task, type AutoApprovalOverride } from "../task/Task"
import { memoryWriteSandbox, filterMemoryWrittenPaths, type SubTaskRunner } from "../memory"

import { webviewMessageHandler } from "./webviewMessageHandler"
import type { ClineMessage, TodoItem } from "@roo-code/types"
import {
	readApiMessages,
	saveApiMessages,
	saveTaskMessages,
	TaskHistoryStore,
	type TaskHistoryStoreHandle,
} from "../task-persistence"
import { readTaskMessages } from "../task-persistence/taskMessages"
import { getNonce } from "./getNonce"
import { getUri } from "./getUri"
import { SubagentRegistry } from "./SubagentRegistry"
import { REQUESTY_BASE_URL } from "../../shared/utils/requesty"
import { validateAndFixToolResultIds } from "../task/validateToolResultIds"

/**
 * https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
 * https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
 */

export type ClineProviderEvents = {
	clineCreated: [cline: Task]
}

interface PendingEditOperation {
	messageTs: number
	editedContent: string
	images?: string[]
	messageIndex: number
	apiConversationHistoryIndex: number
	timeoutId: NodeJS.Timeout
	createdAt: number
}

export class ClineProvider
	extends EventEmitter<TaskProviderEvents>
	implements vscode.WebviewViewProvider, TelemetryPropertiesProvider, TaskProviderLike
{
	// Used in package.json as the view's id. This value cannot be changed due
	// to how VSCode caches views based on their id, and updating the id would
	// break existing instances of the extension.
	public static readonly sideBarId = `${Package.name}.SidebarProvider`
	public static readonly tabPanelId = `${Package.name}.TabPanelProvider`
	private static activeInstances: Set<ClineProvider> = new Set()
	private disposables: vscode.Disposable[] = []
	private webviewDisposables: vscode.Disposable[] = []
	private view?: vscode.WebviewView | vscode.WebviewPanel
	private clineStack: Task[] = []
	// Headless background tasks (memory writers, parallel subagents). Deliberately
	// kept OFF `clineStack` so `getCurrentTask()` and the webview stay bound to the
	// foreground task. Keyed by taskId; entries are removed on completion/abort.
	private backgroundTasks = new Map<string, Task>()
	// Live summaries + tail subscriptions for the UI-visible subset of
	// backgroundTasks (parallel subagents). Memory writers never register.
	// The `currentTaskIdProvider` stamps `sourceTaskId` on every
	// `subagentsUpdated` push so the webview can scope updates by
	// `currentTaskId` (defense-in-depth against late terminal updates from a
	// just-abandoned task leaking into the new task's panel).
	public readonly subagentRegistry = new SubagentRegistry(
		(message) => {
			this.postMessageToWebview(message).catch(() => {})
		},
		() => this.getCurrentTask()?.taskId,
	)
	// Live memory-system activity counters ("recalling/writing memory…" badge).
	private memoryActivityCounts = { recall: 0, write: 0 }
	// Children whose delegated parent could not be proven detached on cancel.
	// reopenParentFromDelegation() refuses to reopen a parent for any child here.
	private cancelledDelegationChildIds = new Set<string>()
	private codeIndexStatusSubscription?: vscode.Disposable
	private codeIndexManager?: CodeIndexManager
	private _workspaceTracker?: WorkspaceTracker // workSpaceTracker read-only for access outside this class
	protected mcpHub?: McpHub // Change from private to protected
	protected skillsManager?: SkillsManager
	private marketplaceManager: MarketplaceManager
	private mdmService?: MdmService
	private taskCreationCallback: (task: Task) => void
	private taskEventListeners: WeakMap<Task, Array<() => void>> = new WeakMap()
	private currentWorkspacePath: string | undefined
	private _disposed = false

	private recentTasksCache?: string[]
	private readonly taskHistoryOrigin = Symbol("ClineProvider.taskHistoryOrigin")
	private readonly taskHistoryStoreReady: Promise<TaskHistoryStore>
	/**
	 * Ref-counted handle that owns the shared {@link TaskHistoryStore} for
	 * this storage path. Disposed in {@link dispose} so the final consumer
	 * tears down the watcher/timers; earlier consumers keep the store alive.
	 */
	private taskHistoryStoreHandle?: TaskHistoryStoreHandle
	/** Unsubscribe for the shared store's change notifications. */
	private taskHistoryStoreUnsubscribe?: () => void
	/**
	 * IDs of task-history mutations this provider initiated (via
	 * `updateTaskHistory` / `deleteTaskFromState` /
	 * `delegateParentAndOpenChild`'s `atomicReadAndUpdate`). Used to
	 * suppress the `onChange` echo for our own writes so we don't double-send
	 * the targeted webview message. Entries are consumed (deleted) by the
	 * `onChange` handler when it sees the matching `external:false` event.
	 */
	private pendingOperations: Map<string, PendingEditOperation> = new Map()
	private static readonly PENDING_OPERATION_TIMEOUT_MS = 30000 // 30 seconds

	private cloudOrganizationsCache: CloudOrganizationMembership[] | null = null
	private cloudOrganizationsCacheTimestamp: number | null = null
	private static readonly CLOUD_ORGANIZATIONS_CACHE_DURATION_MS = 5 * 1000 // 5 seconds

	/**
	 * Monotonically increasing sequence number for clineMessages state pushes.
	 * Used by the frontend to reject stale state that arrives out-of-order.
	 */
	private clineMessagesSeq = 0

	public isViewLaunched = false
	public settingsImportedAt?: number
	public readonly latestAnnouncementId = "apr-2026-v3.53.0-community-handoff-gpt55-opus47" // v3.53.0 Community handoff, GPT-5.5, Claude Opus 4.7, checkpoint navigation
	public readonly providerSettingsManager: ProviderSettingsManager
	public readonly customModesManager: CustomModesManager

	constructor(
		readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
		private readonly renderContext: "sidebar" | "editor" = "sidebar",
		public readonly contextProxy: ContextProxy,
		mdmService?: MdmService,
	) {
		super()
		this.currentWorkspacePath = getWorkspacePath()

		ClineProvider.activeInstances.add(this)

		this.mdmService = mdmService
		this.updateGlobalState("codebaseIndexModels", EMBEDDING_MODEL_PROFILES)

		// Acquire a shared, ref-counted TaskHistoryStore for this storage
		// path. Multiple ClineProvider instances (sidebar + editor tab,
		// multiple windows on the same storage) share one watcher/timer set;
		// the final dispose tears them down. Distinct storage paths or
		// contexts get distinct stores. Path aliases that canonicalize to the
		// same path (trailing separator, `.`/`..` segments, mixed separators)
		// collapse to one store.
		const pendingHistoryStore = TaskHistoryStore.acquire(this.contextProxy.globalStorageUri.fsPath)
		this.taskHistoryStoreReady = pendingHistoryStore.then((handle) => {
			if (this._disposed) {
				handle.dispose()
				throw new Error("ClineProvider was disposed before TaskHistoryStore became ready")
			}
			this.taskHistoryStoreHandle = handle
			this.subscribeToTaskHistoryStore(handle.store)
			return handle.store
		})

		// React to cache changes from the shared store. The store fires one
		// event per change with `external` (filesystem/other-process origin),
		// `kind` ("upsert" | "delete" | "external"), and the affected
		// `taskId`/`item` when known.
		//
		// - For a LOCAL mutation performed through THIS provider's own
		//   `updateTaskHistory`/`deleteTaskFromState`/`atomicReadAndUpdate`,
		//   we already sent the targeted `taskHistoryItemUpdated`/full state
		//   message ourselves, so we skip the onChange callback to avoid a
		//   redundant broadcast. (The store still reports `external:false` for
		//   these, which other providers sharing the store WILL act on.)
		// - For a mutation performed by ANOTHER provider sharing the store
		//   (also `external:false` because it's a local mutation — just not
		//   ours), we push a targeted `taskHistoryItemUpdated` /
		//   `taskHistoryDeleted` message and refresh `recentTasksCache`, but
		//   we do NOT rebroadcast the full history.
		// - For an EXTERNAL change (watcher/periodic reconcile picked up a
		//   change from another process or an explicit invalidate), we fall
		//   back to a full `taskHistoryUpdated` broadcast because the watcher
		//   coalesces IDs and a targeted message per ID is not always
		//   available.
		//
		// We track the IDs of mutations this provider initiated so we can
		// suppress the echo for our own writes (the store has no notion of
		// "which provider caused this" — every local mutation is
		// `external:false`).
		this.initializeTaskHistoryStore().catch((error) => {
			if (!this._disposed) {
				this.log(`Failed to initialize TaskHistoryStore: ${error}`)
			}
		})

		// Start configuration loading (which might trigger indexing) in the background.
		// Don't await, allowing activation to continue immediately.

		// Register this provider with the telemetry service to enable it to add
		// properties like mode and provider.
		TelemetryService.instance.setProvider(this)

		this._workspaceTracker = new WorkspaceTracker(this)

		this.providerSettingsManager = new ProviderSettingsManager(this.context)

		this.customModesManager = new CustomModesManager(this.context, async () => {
			await this.postStateToWebviewWithoutClineMessages()
		})

		// Initialize MCP Hub through the singleton manager
		McpServerManager.getInstance(this.context, this)
			.then((hub) => {
				this.mcpHub = hub
				this.mcpHub.registerClient()
			})
			.catch((error) => {
				this.log(`Failed to initialize MCP Hub: ${error}`)
			})

		// Initialize Skills Manager for skill discovery
		this.skillsManager = new SkillsManager(this)
		this.skillsManager.initialize().catch((error) => {
			this.log(`Failed to initialize Skills Manager: ${error}`)
		})

		this.marketplaceManager = new MarketplaceManager(this.context, this.customModesManager)

		// Forward <most> task events to the provider.
		// We do something fairly similar for the IPC-based API.
		this.taskCreationCallback = (instance: Task) => {
			this.emit(RooCodeEventName.TaskCreated, instance)

			// Create named listener functions so we can remove them later.
			const onTaskStarted = () => this.emit(RooCodeEventName.TaskStarted, instance.taskId)
			const onTaskCompleted = (taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage) => {
				this.subagentRegistry.markTerminal(taskId, "completed")
				this.emit(RooCodeEventName.TaskCompleted, taskId, tokenUsage, toolUsage)
			}
			const onTaskAborted = async () => {
				// Generic "failed"; RunParallelTasksTool refines to "cancelled"
				// when the abort turns out to be a fan-out cancellation.
				this.subagentRegistry.markTerminal(instance.taskId, "failed")
				this.emit(RooCodeEventName.TaskAborted, instance.taskId)

				try {
					// Only rehydrate on genuine streaming failures.
					// User-initiated cancels are handled by cancelTask().
					// Background tasks (memory writers / subagents) are never on the
					// stack and must not rehydrate as a foreground task.
					if (instance.abortReason === "streaming_failed" && !instance.isBackground) {
						// Defensive safeguard: if another path already replaced this instance, skip
						const current = this.getCurrentTask()
						if (current && current.instanceId !== instance.instanceId) {
							this.log(
								`[onTaskAborted] Skipping rehydrate: current instance ${current.instanceId} != aborted ${instance.instanceId}`,
							)
							return
						}

						const { historyItem } = await this.getTaskWithId(instance.taskId)
						const rootTask = instance.rootTask
						const parentTask = instance.parentTask
						await this.createTaskWithHistoryItem({ ...historyItem, rootTask, parentTask })
					}
				} catch (error) {
					this.log(
						`[onTaskAborted] Failed to rehydrate after streaming failure: ${
							error instanceof Error ? error.message : String(error)
						}`,
					)
				}
			}
			const onTaskFocused = () => this.emit(RooCodeEventName.TaskFocused, instance.taskId)
			const onTaskUnfocused = () => this.emit(RooCodeEventName.TaskUnfocused, instance.taskId)
			const onTaskActive = (taskId: string) => {
				this.subagentRegistry.setLiveStatus(taskId, "running")
				this.emit(RooCodeEventName.TaskActive, taskId)
			}
			const onTaskInteractive = (taskId: string) => {
				this.subagentRegistry.setLiveStatus(taskId, "awaiting_input")
				this.emit(RooCodeEventName.TaskInteractive, taskId)
			}
			const onTaskResumable = (taskId: string) => this.emit(RooCodeEventName.TaskResumable, taskId)
			const onTaskIdle = (taskId: string) => this.emit(RooCodeEventName.TaskIdle, taskId)
			const onTaskPaused = (taskId: string) => this.emit(RooCodeEventName.TaskPaused, taskId)
			const onTaskUnpaused = (taskId: string) => this.emit(RooCodeEventName.TaskUnpaused, taskId)
			const onTaskSpawned = (taskId: string) => this.emit(RooCodeEventName.TaskSpawned, taskId)
			const onTaskUserMessage = (taskId: string) => this.emit(RooCodeEventName.TaskUserMessage, taskId)
			const onTaskTokenUsageUpdated = (taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage) => {
				if (this.subagentRegistry.has(taskId)) {
					this.subagentRegistry.update(taskId, {
						tokensIn: tokenUsage.totalTokensIn,
						tokensOut: tokenUsage.totalTokensOut,
						totalCost: tokenUsage.totalCost,
					})
				}
				this.emit(RooCodeEventName.TaskTokenUsageUpdated, taskId, tokenUsage, toolUsage)
			}

			// Attach the listeners.
			instance.on(RooCodeEventName.TaskStarted, onTaskStarted)
			instance.on(RooCodeEventName.TaskCompleted, onTaskCompleted)
			instance.on(RooCodeEventName.TaskAborted, onTaskAborted)
			instance.on(RooCodeEventName.TaskFocused, onTaskFocused)
			instance.on(RooCodeEventName.TaskUnfocused, onTaskUnfocused)
			instance.on(RooCodeEventName.TaskActive, onTaskActive)
			instance.on(RooCodeEventName.TaskInteractive, onTaskInteractive)
			instance.on(RooCodeEventName.TaskResumable, onTaskResumable)
			instance.on(RooCodeEventName.TaskIdle, onTaskIdle)
			instance.on(RooCodeEventName.TaskPaused, onTaskPaused)
			instance.on(RooCodeEventName.TaskUnpaused, onTaskUnpaused)
			instance.on(RooCodeEventName.TaskSpawned, onTaskSpawned)
			instance.on(RooCodeEventName.TaskUserMessage, onTaskUserMessage)
			instance.on(RooCodeEventName.TaskTokenUsageUpdated, onTaskTokenUsageUpdated)

			// Store the cleanup functions for later removal.
			this.taskEventListeners.set(instance, [
				() => instance.off(RooCodeEventName.TaskStarted, onTaskStarted),
				() => instance.off(RooCodeEventName.TaskCompleted, onTaskCompleted),
				() => instance.off(RooCodeEventName.TaskAborted, onTaskAborted),
				() => instance.off(RooCodeEventName.TaskFocused, onTaskFocused),
				() => instance.off(RooCodeEventName.TaskUnfocused, onTaskUnfocused),
				() => instance.off(RooCodeEventName.TaskActive, onTaskActive),
				() => instance.off(RooCodeEventName.TaskInteractive, onTaskInteractive),
				() => instance.off(RooCodeEventName.TaskResumable, onTaskResumable),
				() => instance.off(RooCodeEventName.TaskIdle, onTaskIdle),
				() => instance.off(RooCodeEventName.TaskUserMessage, onTaskUserMessage),
				() => instance.off(RooCodeEventName.TaskPaused, onTaskPaused),
				() => instance.off(RooCodeEventName.TaskUnpaused, onTaskUnpaused),
				() => instance.off(RooCodeEventName.TaskSpawned, onTaskSpawned),
				() => instance.off(RooCodeEventName.TaskTokenUsageUpdated, onTaskTokenUsageUpdated),
			])
		}

		// Initialize Roo Code Cloud profile sync.
		if (CloudService.hasInstance()) {
			this.initializeCloudProfileSync().catch((error) => {
				this.log(`Failed to initialize cloud profile sync: ${error}`)
			})
		} else {
			this.log("CloudService not ready, deferring cloud profile sync")
		}
	}

	/**
	 * Initialize the shared TaskHistoryStore and, if present, migrate the
	 * legacy `taskHistory` globalState array into per-task files before
	 * clearing the legacy key.
	 *
	 * Migration safety:
	 * - The legacy array is only read when {@link ContextProxy.hasLegacyTaskHistory}
	 *   reports a value, so starts after a successful cleanup never
	 *   materialize it.
	 * - {@link TaskHistoryStore.migrateFromLegacyHistory} is idempotent and
	 *   never overwrites an existing per-task file, so a partially-migrated
	 *   state resumes without clobbering newer records.
	 * - The legacy keys are cleared only after migration reports success; on
	 *   failure they are left intact so the next start can retry.
	 */
	private async initializeTaskHistoryStore(): Promise<void> {
		const taskHistoryStore = await this.getTaskHistoryStore()

		// One-time backfill from the legacy globalState array. Skipped
		// entirely (no read, no writes) once cleanup has run.
		if (this.contextProxy.hasLegacyTaskHistory()) {
			const legacy = this.contextProxy.getLegacyTaskHistory<HistoryItem>() ?? []
			if (legacy.length > 0) {
				this.log(`[initializeTaskHistoryStore] Migrating ${legacy.length} legacy entries`)
				const ok = await taskHistoryStore.migrateFromLegacyHistory(legacy)
				if (!ok) {
					this.log("[initializeTaskHistoryStore] Migration incomplete — legacy keys retained for retry")
					return
				}
				this.log("[initializeTaskHistoryStore] Migration complete")
			}
			// Only clear after a successful migration (or when the
			// legacy array was empty — nothing to migrate).
			await this.contextProxy.clearLegacyTaskHistoryKeys()
		}
	}

	private subscribeToTaskHistoryStore(taskHistoryStore: TaskHistoryStore): void {
		this.taskHistoryStoreUnsubscribe = taskHistoryStore.onChange((event) => {
			if (event.origin === this.taskHistoryOrigin || !this.isViewLaunched || this._disposed) {
				return
			}

			this.recentTasksCache = undefined
			if (event.kind === "delete" && event.taskId) {
				this.postMessageToWebview({
					type: "taskHistoryItemDeleted",
					taskHistoryItemId: event.taskId,
				}).catch((err) => {
					this.log(
						`[TaskHistoryStore onChange] targeted delete push failed: ${err instanceof Error ? err.message : String(err)}`,
					)
				})
			} else if (event.kind === "upsert" && event.item) {
				this.postMessageToWebview({
					type: "taskHistoryItemUpdated",
					taskHistoryItem: event.item,
				}).catch((err) => {
					this.log(
						`[TaskHistoryStore onChange] targeted upsert push failed: ${err instanceof Error ? err.message : String(err)}`,
					)
				})
			} else if (event.kind === "external") {
				this.broadcastTaskHistoryUpdate().catch((err) => {
					this.log(
						`[TaskHistoryStore onChange] broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
					)
				})
			}
		})
	}

	private async getTaskHistoryStore(): Promise<TaskHistoryStore> {
		if (this._disposed) {
			throw new Error("ClineProvider is disposed")
		}
		const taskHistoryStore = await this.taskHistoryStoreReady
		if (this._disposed) {
			throw new Error("ClineProvider is disposed")
		}
		return taskHistoryStore
	}

	/**
	 * Override EventEmitter's on method to match TaskProviderLike interface
	 */
	override on<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		return super.on(event, listener as any)
	}

	/**
	 * Override EventEmitter's off method to match TaskProviderLike interface
	 */
	override off<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		return super.off(event, listener as any)
	}

	/**
	 * Initialize cloud profile synchronization
	 */
	private async initializeCloudProfileSync() {
		try {
			// Check if authenticated and sync profiles
			if (CloudService.hasInstance() && CloudService.instance.isAuthenticated()) {
				await this.syncCloudProfiles()
			}

			// Set up listener for future updates
			if (CloudService.hasInstance()) {
				CloudService.instance.on("settings-updated", this.handleCloudSettingsUpdate)
			}
		} catch (error) {
			this.log(`Error in initializeCloudProfileSync: ${error}`)
		}
	}

	/**
	 * Handle cloud settings updates
	 */
	private handleCloudSettingsUpdate = async () => {
		try {
			await this.syncCloudProfiles()
		} catch (error) {
			this.log(`Error handling cloud settings update: ${error}`)
		}
	}

	/**
	 * Synchronize cloud profiles with local profiles.
	 */
	private async syncCloudProfiles() {
		try {
			const settings = CloudService.instance.getOrganizationSettings()

			if (!settings?.providerProfiles) {
				return
			}

			const currentApiConfigName = this.getGlobalState("currentApiConfigName")

			const result = await this.providerSettingsManager.syncCloudProfiles(
				settings.providerProfiles,
				currentApiConfigName,
			)

			if (result.hasChanges) {
				// Update list.
				await this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig())

				if (result.activeProfileChanged && result.activeProfileId) {
					// Reload full settings for new active profile.
					const profile = await this.providerSettingsManager.getProfile({
						id: result.activeProfileId,
					})
					await this.activateProviderProfile({ name: profile.name })
				}

				await this.postStateToWebviewWithoutClineMessages()
			}
		} catch (error) {
			this.log(`Error syncing cloud profiles: ${error}`)
		}
	}

	/**
	 * Initialize cloud profile synchronization when CloudService is ready
	 * This method is called externally after CloudService has been initialized
	 */
	public async initializeCloudProfileSyncWhenReady(): Promise<void> {
		try {
			if (CloudService.hasInstance() && CloudService.instance.isAuthenticated()) {
				await this.syncCloudProfiles()
			}

			if (CloudService.hasInstance()) {
				CloudService.instance.off("settings-updated", this.handleCloudSettingsUpdate)
				CloudService.instance.on("settings-updated", this.handleCloudSettingsUpdate)
			}
		} catch (error) {
			this.log(`Failed to initialize cloud profile sync when ready: ${error}`)
		}
	}

	// Adds a new Task instance to clineStack, marking the start of a new task.
	// The instance is pushed to the top of the stack (LIFO order).
	// When the task is completed, the top instance is removed, reactivating the
	// previous task.
	async addClineToStack(task: Task) {
		// Add this cline instance into the stack that represents the order of
		// all the called tasks.
		this.clineStack.push(task)
		task.emit(RooCodeEventName.TaskFocused)

		// Perform special setup provider specific tasks.
		await this.performPreparationTasks(task)

		// Ensure getState() resolves correctly.
		const state = await this.getState()

		if (!state || typeof state.mode !== "string") {
			throw new Error(t("common:errors.retrieve_current_mode"))
		}
	}

	async performPreparationTasks(cline: Task) {
		// LMStudio: We need to force model loading in order to read its context
		// size; we do it now since we're starting a task with that model selected.
		if (cline.apiConfiguration && cline.apiConfiguration.apiProvider === "lmstudio") {
			try {
				if (!hasLoadedFullDetails(cline.apiConfiguration.lmStudioModelId!)) {
					await forceFullModelDetailsLoad(
						cline.apiConfiguration.lmStudioBaseUrl ?? "http://localhost:1234",
						cline.apiConfiguration.lmStudioModelId!,
					)
				}
			} catch (error) {
				this.log(`Failed to load full model details for LM Studio: ${error}`)
				vscode.window.showErrorMessage(error.message)
			}
		}
	}

	// Removes and destroys the top Cline instance (the current finished task),
	// activating the previous one (resuming the parent task).
	async removeClineFromStack(options?: { skipDelegationRepair?: boolean }) {
		if (this.clineStack.length === 0) {
			return
		}

		// Pop the top Cline instance from the stack.
		let task = this.clineStack.pop()

		if (task) {
			// Capture delegation metadata before abort/dispose, since abortTask(true)
			// is async and the task reference is cleared afterwards.
			const childTaskId = task.taskId
			const parentTaskId = task.parentTaskId

			// NOTE: deliberately no subagentRegistry cleanup here. Popping a
			// task is often mere abandonment (switching tasks via history, an
			// in-place rehydrate) — its fan-out children keep running detached
			// and must stay visible in the panel. The panel is reset at task
			// boundaries by the entry points (createTask / clearTask /
			// createTaskWithHistoryItem) via `resetSubagentPanel`, NOT here,
			// so mid-task re-fan-out for the same parent (beginFanOut) keeps
			// its semantics. For a pure abandonment (history switch), the
			// detached children stay visible until the next task boundary.

			task.emit(RooCodeEventName.TaskUnfocused)

			try {
				// Abort the running task and set isAbandoned to true so
				// all running promises will exit as well.
				await task.abortTask(true)
			} catch (e) {
				this.log(
					`[ClineProvider#removeClineFromStack] abortTask() failed ${task.taskId}.${task.instanceId}: ${e.message}`,
				)
			}

			// Remove event listeners before clearing the reference.
			const cleanupFunctions = this.taskEventListeners.get(task)

			if (cleanupFunctions) {
				cleanupFunctions.forEach((cleanup) => cleanup())
				this.taskEventListeners.delete(task)
			}

			// Make sure no reference kept, once promises end it will be
			// garbage collected.
			task = undefined

			// Delegation-aware parent metadata repair:
			// If the popped task was a delegated child, repair the parent's metadata
			// so it transitions from "delegated" back to "active" and becomes resumable
			// from the task history list.
			// Skip when called from delegateParentAndOpenChild() during nested delegation
			// transitions (A→B→C), where the caller intentionally replaces the active
			// child and will update the parent to point at the new child.
			if (parentTaskId && childTaskId && !options?.skipDelegationRepair) {
				try {
					const { historyItem: parentHistory } = await this.getTaskWithId(parentTaskId)

					if (parentHistory.status === "delegated" && parentHistory.awaitingChildId === childTaskId) {
						await this.updateTaskHistory({
							...parentHistory,
							status: "active",
							awaitingChildId: undefined,
						})
						this.log(
							`[ClineProvider#removeClineFromStack] Repaired parent ${parentTaskId} metadata: delegated → active (child ${childTaskId} removed)`,
						)
					}
				} catch (err) {
					// Non-fatal: log but do not block the pop operation.
					this.log(
						`[ClineProvider#removeClineFromStack] Failed to repair parent metadata for ${parentTaskId} (non-fatal): ${
							err instanceof Error ? err.message : String(err)
						}`,
					)
				}
			}
		}
	}

	getTaskStackSize(): number {
		return this.clineStack.length
	}

	public getCurrentTaskStack(): string[] {
		return this.clineStack.map((cline) => cline.taskId)
	}

	// Pending Edit Operations Management

	/**
	 * Sets a pending edit operation with automatic timeout cleanup
	 */
	public setPendingEditOperation(
		operationId: string,
		editData: {
			messageTs: number
			editedContent: string
			images?: string[]
			messageIndex: number
			apiConversationHistoryIndex: number
		},
	): void {
		// Clear any existing operation with the same ID
		this.clearPendingEditOperation(operationId)

		// Create timeout for automatic cleanup
		const timeoutId = setTimeout(() => {
			this.clearPendingEditOperation(operationId)
			this.log(`[setPendingEditOperation] Automatically cleared stale pending operation: ${operationId}`)
		}, ClineProvider.PENDING_OPERATION_TIMEOUT_MS)

		// Store the operation
		this.pendingOperations.set(operationId, {
			...editData,
			timeoutId,
			createdAt: Date.now(),
		})

		this.log(`[setPendingEditOperation] Set pending operation: ${operationId}`)
	}

	/**
	 * Gets a pending edit operation by ID
	 */
	private getPendingEditOperation(operationId: string): PendingEditOperation | undefined {
		return this.pendingOperations.get(operationId)
	}

	/**
	 * Clears a specific pending edit operation
	 */
	private clearPendingEditOperation(operationId: string): boolean {
		const operation = this.pendingOperations.get(operationId)
		if (operation) {
			clearTimeout(operation.timeoutId)
			this.pendingOperations.delete(operationId)
			this.log(`[clearPendingEditOperation] Cleared pending operation: ${operationId}`)
			return true
		}
		return false
	}

	/**
	 * Clears all pending edit operations
	 */
	private clearAllPendingEditOperations(): void {
		for (const [operationId, operation] of this.pendingOperations) {
			clearTimeout(operation.timeoutId)
		}
		this.pendingOperations.clear()
		this.log(`[clearAllPendingEditOperations] Cleared all pending operations`)
	}

	/*
	VSCode extensions use the disposable pattern to clean up resources when the sidebar/editor tab is closed by the user or system. This applies to event listening, commands, interacting with the UI, etc.
	- https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
	- https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	*/
	private clearWebviewResources() {
		while (this.webviewDisposables.length) {
			const x = this.webviewDisposables.pop()
			if (x) {
				x.dispose()
			}
		}
	}

	async dispose() {
		if (this._disposed) {
			return
		}

		this._disposed = true
		this.log("Disposing ClineProvider...")

		// Clear all tasks from the stack.
		while (this.clineStack.length > 0) {
			await this.removeClineFromStack()
		}

		this.log("Cleared all tasks")

		// Clear all pending edit operations to prevent memory leaks
		this.clearAllPendingEditOperations()
		this.log("Cleared pending operations")

		if (this.view && "dispose" in this.view) {
			this.view.dispose()
			this.log("Disposed webview")
		}

		this.clearWebviewResources()

		// Clean up cloud service event listener
		if (CloudService.hasInstance()) {
			CloudService.instance.off("settings-updated", this.handleCloudSettingsUpdate)
		}

		while (this.disposables.length) {
			const x = this.disposables.pop()

			if (x) {
				x.dispose()
			}
		}

		this._workspaceTracker?.dispose()
		this._workspaceTracker = undefined
		await this.mcpHub?.unregisterClient()
		this.mcpHub = undefined
		await this.skillsManager?.dispose()
		this.skillsManager = undefined
		this.marketplaceManager?.cleanup()
		this.customModesManager?.dispose()
		this.taskHistoryStoreUnsubscribe?.()
		this.taskHistoryStoreUnsubscribe = undefined
		// Release the shared store handle. The final consumer's release
		// disposes the underlying watcher/timers; earlier consumers only
		// detach so closing one panel never breaks the others.
		this.taskHistoryStoreHandle?.dispose()
		this.taskHistoryStoreHandle = undefined
		this.log("Disposed all disposables")
		ClineProvider.activeInstances.delete(this)

		// Clean up any event listeners attached to this provider
		this.removeAllListeners()

		McpServerManager.unregisterProvider(this)
	}

	public static getVisibleInstance(): ClineProvider | undefined {
		return findLast(Array.from(this.activeInstances), (instance) => instance.view?.visible === true)
	}

	public static async getInstance(): Promise<ClineProvider | undefined> {
		let visibleProvider = ClineProvider.getVisibleInstance()

		// If no visible provider, try to show the sidebar view
		if (!visibleProvider) {
			await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
			// Wait briefly for the view to become visible
			await delay(100)
			visibleProvider = ClineProvider.getVisibleInstance()
		}

		// If still no visible provider, return
		if (!visibleProvider) {
			return
		}

		return visibleProvider
	}

	public static async isActiveTask(): Promise<boolean> {
		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return false
		}

		// Check if there is a cline instance in the stack (if this provider has an active task)
		if (visibleProvider.getCurrentTask()) {
			return true
		}

		return false
	}

	public static async handleCodeAction(
		command: CodeActionId,
		promptType: CodeActionName,
		params: Record<string, string | any[]>,
	): Promise<void> {
		// Capture telemetry for code action usage
		TelemetryService.instance.captureCodeActionUsed(promptType)

		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return
		}

		const { customSupportPrompts } = await visibleProvider.getState()

		// TODO: Improve type safety for promptType.
		const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

		if (command === "addToContext") {
			await visibleProvider.postMessageToWebview({
				type: "invoke",
				invoke: "setChatBoxMessage",
				text: `${prompt}\n\n`,
			})
			await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
			return
		}

		await visibleProvider.createTask(prompt)
	}

	public static async handleTerminalAction(
		command: TerminalActionId,
		promptType: TerminalActionPromptType,
		params: Record<string, string | any[]>,
	): Promise<void> {
		TelemetryService.instance.captureCodeActionUsed(promptType)

		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return
		}

		const { customSupportPrompts } = await visibleProvider.getState()
		const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

		if (command === "terminalAddToContext") {
			await visibleProvider.postMessageToWebview({
				type: "invoke",
				invoke: "setChatBoxMessage",
				text: `${prompt}\n\n`,
			})
			await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
			return
		}

		try {
			await visibleProvider.createTask(prompt)
		} catch (error) {
			if (error instanceof OrganizationAllowListViolationError) {
				// Errors from terminal commands seem to get swallowed / ignored.
				vscode.window.showErrorMessage(error.message)
			}

			throw error
		}
	}

	async resolveWebviewView(webviewView: vscode.WebviewView | vscode.WebviewPanel) {
		this.view = webviewView
		const inTabMode = "onDidChangeViewState" in webviewView

		if (inTabMode) {
			setPanel(webviewView, "tab")
		} else if ("onDidChangeVisibility" in webviewView) {
			setPanel(webviewView, "sidebar")
		}

		// Initialize out-of-scope variables that need to receive persistent
		// global state values.
		this.getState().then(
			({
				terminalShellIntegrationTimeout = Terminal.defaultShellIntegrationTimeout,
				terminalShellIntegrationDisabled = false,
				terminalCommandDelay = 0,
				terminalZshClearEolMark = true,
				terminalZshOhMy = false,
				terminalZshP10k = false,
				terminalPowershellCounter = false,
				terminalZdotdir = false,
				terminalProfile,
			}) => {
				Terminal.setShellIntegrationTimeout(terminalShellIntegrationTimeout)
				Terminal.setShellIntegrationDisabled(terminalShellIntegrationDisabled)
				Terminal.setCommandDelay(terminalCommandDelay)
				Terminal.setTerminalZshClearEolMark(terminalZshClearEolMark)
				Terminal.setTerminalZshOhMy(terminalZshOhMy)
				Terminal.setTerminalZshP10k(terminalZshP10k)
				Terminal.setPowershellCounter(terminalPowershellCounter)
				Terminal.setTerminalZdotdir(terminalZdotdir)
				Terminal.setTerminalProfile(terminalProfile)
			},
		)

		// Set up webview options with proper resource roots
		const resourceRoots = [this.contextProxy.extensionUri]

		// Add workspace folders to allow access to workspace files
		if (vscode.workspace.workspaceFolders) {
			resourceRoots.push(...vscode.workspace.workspaceFolders.map((folder) => folder.uri))
		}

		// Allow webview to load user-uploaded custom sound files (notification settings).
		resourceRoots.push(vscode.Uri.file(getCustomSoundsDir(this.contextProxy.globalStorageUri.fsPath)))

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: resourceRoots,
		}

		webviewView.webview.html =
			this.contextProxy.extensionMode === vscode.ExtensionMode.Development
				? await this.getHMRHtmlContent(webviewView.webview)
				: await this.getHtmlContent(webviewView.webview)

		// Sets up an event listener to listen for messages passed from the webview view context
		// and executes code based on the message that is received.
		this.setWebviewMessageListener(webviewView.webview)

		// Initialize code index status subscription for the current workspace.
		this.updateCodeIndexStatusSubscription()

		// Listen for active editor changes to update code index status for the
		// current workspace.
		const activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
			// Update subscription when workspace might have changed.
			this.updateCodeIndexStatusSubscription()
		})
		this.webviewDisposables.push(activeEditorSubscription)

		// Listen for when the panel becomes visible.
		// https://github.com/microsoft/vscode-discussions/discussions/840
		if ("onDidChangeViewState" in webviewView) {
			// WebviewView and WebviewPanel have all the same properties except
			// for this visibility listener panel.
			const viewStateDisposable = webviewView.onDidChangeViewState(() => {
				if (this.view?.visible) {
					this.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
				} else {
					this.logWebviewHiddenDiagnostics()
				}
			})

			this.webviewDisposables.push(viewStateDisposable)
		} else if ("onDidChangeVisibility" in webviewView) {
			// sidebar
			const visibilityDisposable = webviewView.onDidChangeVisibility(() => {
				if (this.view?.visible) {
					this.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
				} else {
					this.logWebviewHiddenDiagnostics()
				}
			})

			this.webviewDisposables.push(visibilityDisposable)
		}

		// Listen for when the view is disposed
		// This happens when the user closes the view or when the view is closed programmatically
		webviewView.onDidDispose(
			async () => {
				if (inTabMode) {
					this.log("Disposing ClineProvider instance for tab view")
					await this.dispose()
				} else {
					this.log("Clearing webview resources for sidebar view")
					this.clearWebviewResources()
					// Reset current workspace manager reference when view is disposed
					this.codeIndexManager = undefined
				}
			},
			null,
			this.disposables,
		)

		// Listen for when color changes
		const configDisposable = vscode.workspace.onDidChangeConfiguration(async (e) => {
			if (e && e.affectsConfiguration("workbench.colorTheme")) {
				// Sends latest theme name to webview
				await this.postMessageToWebview({ type: "theme", text: JSON.stringify(await getTheme()) })
			}
		})
		this.webviewDisposables.push(configDisposable)

		// If the extension is starting a new session, clear previous task state.
		// But don't clear if there's already an active task (e.g., resumed via IPC/bridge).
		const currentTask = this.getCurrentTask()
		if (!currentTask || currentTask.abandoned || currentTask.abort) {
			await this.removeClineFromStack()
		}
	}

	public async createTaskWithHistoryItem(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean },
	) {
		const isCliRuntime = process.env.ROO_CLI_RUNTIME === "1"
		// CLI injects runtime provider settings from command flags/env at startup.
		// Restoring provider profiles from task history can overwrite those
		// runtime settings with stale/incomplete persisted profiles.
		const skipProfileRestoreFromHistory = isCliRuntime

		// Check if we're rehydrating the current task to avoid flicker
		const currentTask = this.getCurrentTask()
		const isRehydratingCurrentTask = currentTask && currentTask.taskId === historyItem.id

		if (!isRehydratingCurrentTask) {
			// Reset the subagent panel BEFORE popping the stack so the
			// broadcast still carries the about-to-be-popped task's id as
			// `sourceTaskId` (the webview scopes by currentTaskId; after the
			// pop there is no current task and the post would be dropped by
			// the scope guard). Historical subagents for the task we are
			// about to rehydrate are restored AFTER the new Task is on the
			// stack, via `rehydrateSubagents` below.
			try {
				await this.resetSubagentPanel()
			} catch {
				// Non-fatal: panel reset is best-effort.
			}
			await this.removeClineFromStack()
		}

		// If the history item has a saved mode, restore it and its associated API configuration.
		if (historyItem.mode) {
			// Validate that the mode still exists
			const customModes = await this.customModesManager.getCustomModes()
			const modeExists = getModeBySlug(historyItem.mode, customModes) !== undefined

			if (!modeExists) {
				// Mode no longer exists, fall back to default mode.
				this.log(
					`Mode '${historyItem.mode}' from history no longer exists. Falling back to default mode '${defaultModeSlug}'.`,
				)
				historyItem.mode = defaultModeSlug
			}

			await this.updateGlobalState("mode", historyItem.mode)

			// Load the saved API config for the restored mode if it exists.
			// Skip mode-based profile activation if historyItem.apiConfigName exists,
			// since the task's specific provider profile will override it anyway.
			const lockApiConfigAcrossModes = this.context.workspaceState.get("lockApiConfigAcrossModes", false)

			if (!historyItem.apiConfigName && !lockApiConfigAcrossModes && !skipProfileRestoreFromHistory) {
				const savedConfigId = await this.providerSettingsManager.getModeConfigId(historyItem.mode)
				const listApiConfig = await this.providerSettingsManager.listConfig()

				// Update listApiConfigMeta first to ensure UI has latest data.
				await this.updateGlobalState("listApiConfigMeta", listApiConfig)

				// If this mode has a saved config, use it.
				if (savedConfigId) {
					const profile = listApiConfig.find(({ id }) => id === savedConfigId)

					if (profile?.name) {
						try {
							// Check if the profile has actual API configuration (not just an id).
							// In CLI mode, the ProviderSettingsManager may return empty default profiles
							// that only contain 'id' and 'name' fields. Activating such a profile would
							// overwrite the CLI's working API configuration with empty settings.
							const fullProfile = await this.providerSettingsManager.getProfile({ name: profile.name })
							const hasActualSettings = !!fullProfile.apiProvider

							if (hasActualSettings) {
								await this.activateProviderProfile({ name: profile.name })
							} else {
								// The task will continue with the current/default configuration.
							}
						} catch (error) {
							// Log the error but continue with task restoration.
							this.log(
								`Failed to restore API configuration for mode '${historyItem.mode}': ${
									error instanceof Error ? error.message : String(error)
								}. Continuing with default configuration.`,
							)
							// The task will continue with the current/default configuration.
						}
					}
				}
			}
		}

		// If the history item has a saved API config name (provider profile), restore it.
		// This overrides any mode-based config restoration above, because the task's
		// specific provider profile takes precedence over mode defaults.
		if (historyItem.apiConfigName && !skipProfileRestoreFromHistory) {
			const listApiConfig = await this.providerSettingsManager.listConfig()
			// Keep global state/UI in sync with latest profiles for parity with mode restoration above.
			await this.updateGlobalState("listApiConfigMeta", listApiConfig)
			const profile = listApiConfig.find(({ name }) => name === historyItem.apiConfigName)

			if (profile?.name) {
				try {
					await this.activateProviderProfile(
						{ name: profile.name },
						{ persistModeConfig: false, persistTaskHistory: false },
					)
				} catch (error) {
					// Log the error but continue with task restoration.
					this.log(
						`Failed to restore API configuration '${historyItem.apiConfigName}' for task: ${
							error instanceof Error ? error.message : String(error)
						}. Continuing with current configuration.`,
					)
				}
			} else {
				// Profile no longer exists, log warning but continue
				this.log(
					`Provider profile '${historyItem.apiConfigName}' from history no longer exists. Using current configuration.`,
				)
			}
		} else if (historyItem.apiConfigName && skipProfileRestoreFromHistory) {
			this.log(
				`Skipping restore of provider profile '${historyItem.apiConfigName}' for task ${historyItem.id} in CLI runtime.`,
			)
		}

		const { apiConfiguration, enableCheckpoints, checkpointTimeout, experiments, cloudUserInfo, taskSyncEnabled } =
			await this.getState()

		const task = new Task({
			provider: this,
			apiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
			historyItem,
			experiments,
			rootTask: historyItem.rootTask,
			parentTask: historyItem.parentTask,
			taskNumber: historyItem.number,
			workspacePath: historyItem.workspace,
			onCreated: this.taskCreationCallback,
			startTask: options?.startTask ?? true,
			// Preserve the status from the history item to avoid overwriting it when the task saves messages
			initialStatus: historyItem.status,
		})

		if (isRehydratingCurrentTask) {
			// Replace the current task in-place to avoid UI flicker
			const stackIndex = this.clineStack.length - 1

			// Properly dispose of the old task to ensure garbage collection
			const oldTask = this.clineStack[stackIndex]

			// Abort the old task to stop running processes and mark as abandoned
			try {
				await oldTask.abortTask(true)
			} catch (e) {
				this.log(
					`[createTaskWithHistoryItem] abortTask() failed for old task ${oldTask.taskId}.${oldTask.instanceId}: ${e.message}`,
				)
			}

			// Remove event listeners from the old task
			const cleanupFunctions = this.taskEventListeners.get(oldTask)
			if (cleanupFunctions) {
				cleanupFunctions.forEach((cleanup) => cleanup())
				this.taskEventListeners.delete(oldTask)
			}

			// Replace the task in the stack
			this.clineStack[stackIndex] = task
			task.emit(RooCodeEventName.TaskFocused)

			// Perform preparation tasks and set up event listeners
			await this.performPreparationTasks(task)

			this.log(
				`[createTaskWithHistoryItem] rehydrated task ${task.taskId}.${task.instanceId} in-place (flicker-free)`,
			)
		} else {
			await this.addClineToStack(task)

			this.log(
				`[createTaskWithHistoryItem] ${task.parentTask ? "child" : "parent"} task ${task.taskId}.${task.instanceId} instantiated`,
			)
		}

		// Restore the historical parallel-subagent panel for this task. Reads
		// `parallelChildIds` + the `subagents.json` sidecar written by
		// `run_parallel_tasks`; no-op (panel stays empty) for pre-fix history
		// items or tasks that never fanned out. Done after the Task is on the
		// stack so `getCurrentTask()` matches the parent we are restoring,
		// and before the eager state push so the push carries the restored
		// rows. Best-effort: a missing/corrupt sidecar never breaks the
		// parent rehydration.
		await this.rehydrateSubagents(historyItem)

		// Eager state push so the webview shows the new task immediately;
		// resumeTaskFromHistory pushes further updates asynchronously.
		await this.postStateToWebview()

		// Check if there's a pending edit after checkpoint restoration
		const operationId = `task-${task.taskId}`
		const pendingEdit = this.getPendingEditOperation(operationId)
		if (pendingEdit) {
			this.clearPendingEditOperation(operationId) // Clear the pending edit

			this.log(`[createTaskWithHistoryItem] Processing pending edit after checkpoint restoration`)

			// Process the pending edit after a short delay to ensure the task is fully initialized
			setTimeout(async () => {
				try {
					// Find the message index in the restored state
					const { messageIndex, apiConversationHistoryIndex } = (() => {
						const messageIndex = task.clineMessages.findIndex((msg) => msg.ts === pendingEdit.messageTs)
						const apiConversationHistoryIndex = task.apiConversationHistory.findIndex(
							(msg) => msg.ts === pendingEdit.messageTs,
						)
						return { messageIndex, apiConversationHistoryIndex }
					})()

					if (messageIndex !== -1) {
						// Remove the target message and all subsequent messages
						await task.overwriteClineMessages(task.clineMessages.slice(0, messageIndex))

						if (apiConversationHistoryIndex !== -1) {
							await task.overwriteApiConversationHistory(
								task.apiConversationHistory.slice(0, apiConversationHistoryIndex),
							)
						}

						// Process the edited message
						await task.handleWebviewAskResponse(
							"messageResponse",
							pendingEdit.editedContent,
							pendingEdit.images,
						)
					}
				} catch (error) {
					this.log(`[createTaskWithHistoryItem] Error processing pending edit: ${error}`)
				}
			}, 100) // Small delay to ensure task is fully ready
		}

		return task
	}

	public async postMessageToWebview(message: ExtensionMessage) {
		if (this._disposed) {
			return
		}

		try {
			await this.view?.webview.postMessage(message)
		} catch {
			// View disposed, drop message silently
		}
	}

	private async getHMRHtmlContent(webview: vscode.Webview): Promise<string> {
		let localPort = "5173"

		try {
			const fs = require("fs")
			const path = require("path")
			const portFilePath = path.resolve(__dirname, "../../.vite-port")

			if (fs.existsSync(portFilePath)) {
				localPort = fs.readFileSync(portFilePath, "utf8").trim()
				console.log(`[ClineProvider:Vite] Using Vite server port from ${portFilePath}: ${localPort}`)
			} else {
				console.log(
					`[ClineProvider:Vite] Port file not found at ${portFilePath}, using default port: ${localPort}`,
				)
			}
		} catch (err) {
			console.error("[ClineProvider:Vite] Failed to read Vite port file:", err)
		}

		const localServerUrl = `localhost:${localPort}`

		// Check if local dev server is running.
		try {
			await axios.get(`http://${localServerUrl}`)
		} catch (error) {
			vscode.window.showErrorMessage(t("common:errors.hmr_not_running"))
			return this.getHtmlContent(webview)
		}

		const nonce = getNonce()

		// Get the OpenRouter base URL from configuration
		const { apiConfiguration } = await this.getState()
		const openRouterBaseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai"
		// Extract the domain for CSP
		const openRouterDomain = openRouterBaseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"

		const stylesUri = getUri(webview, this.contextProxy.extensionUri, [
			"webview-ui",
			"build",
			"assets",
			"index.css",
		])

		const codiconsUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "codicons", "codicon.css"])
		const materialIconsUri = getUri(webview, this.contextProxy.extensionUri, [
			"assets",
			"vscode-material-icons",
			"icons",
		])
		const imagesUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "images"])
		const audioUri = getUri(webview, this.contextProxy.extensionUri, ["webview-ui", "audio"])

		const file = "src/index.tsx"
		const scriptUri = `http://${localServerUrl}/${file}`

		const reactRefresh = /*html*/ `
			<script nonce="${nonce}" type="module">
				import RefreshRuntime from "http://localhost:${localPort}/@react-refresh"
				RefreshRuntime.injectIntoGlobalHook(window)
				window.$RefreshReg$ = () => {}
				window.$RefreshSig$ = () => (type) => type
				window.__vite_plugin_react_preamble_installed__ = true
			</script>
		`

		const csp = [
			"default-src 'none'",
			`font-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline' https://* http://${localServerUrl} http://0.0.0.0:${localPort}`,
			`img-src ${webview.cspSource} https://storage.googleapis.com https://img.clerk.com data:`,
			`media-src ${webview.cspSource}`,
			`script-src 'unsafe-eval' ${webview.cspSource} https://* https://*.posthog.com http://${localServerUrl} http://0.0.0.0:${localPort} 'nonce-${nonce}'`,
			`connect-src ${webview.cspSource} ${openRouterDomain} https://* https://*.posthog.com ws://${localServerUrl} ws://0.0.0.0:${localPort} http://${localServerUrl} http://0.0.0.0:${localPort}`,
		]

		return /*html*/ `
			<!DOCTYPE html>
			<html lang="en">
				<head>
					<meta charset="utf-8">
					<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
					<meta http-equiv="Content-Security-Policy" content="${csp.join("; ")}">
					<link rel="stylesheet" type="text/css" href="${stylesUri}">
					<link href="${codiconsUri}" rel="stylesheet" />
					<script nonce="${nonce}">
						window.IMAGES_BASE_URI = "${imagesUri}"
						window.AUDIO_BASE_URI = "${audioUri}"
						window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}"
					</script>
					<title>Roo Code</title>
				</head>
				<body>
					<div id="root"></div>
					${reactRefresh}
					<script type="module" src="${scriptUri}"></script>
				</body>
			</html>
		`
	}

	/**
	 * Defines and returns the HTML that should be rendered within the webview panel.
	 *
	 * @remarks This is also the place where references to the React webview build files
	 * are created and inserted into the webview HTML.
	 *
	 * @param webview A reference to the extension webview
	 * @param extensionUri The URI of the directory containing the extension
	 * @returns A template string literal containing the HTML that should be
	 * rendered within the webview panel
	 */
	private async getHtmlContent(webview: vscode.Webview): Promise<string> {
		// Get the local path to main script run in the webview,
		// then convert it to a uri we can use in the webview.

		// The CSS file from the React build output
		const stylesUri = getUri(webview, this.contextProxy.extensionUri, [
			"webview-ui",
			"build",
			"assets",
			"index.css",
		])

		const scriptUri = getUri(webview, this.contextProxy.extensionUri, ["webview-ui", "build", "assets", "index.js"])
		const codiconsUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "codicons", "codicon.css"])
		const materialIconsUri = getUri(webview, this.contextProxy.extensionUri, [
			"assets",
			"vscode-material-icons",
			"icons",
		])
		const imagesUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "images"])
		const audioUri = getUri(webview, this.contextProxy.extensionUri, ["webview-ui", "audio"])

		// Use a nonce to only allow a specific script to be run.
		/*
		content security policy of your webview to only allow scripts that have a specific nonce
		create a content security policy meta tag so that only loading scripts with a nonce is allowed
		As your extension grows you will likely want to add custom styles, fonts, and/or images to your webview. If you do, you will need to update the content security policy meta tag to explicitly allow for these resources. E.g.
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">
		- 'unsafe-inline' is required for styles due to vscode-webview-toolkit's dynamic style injection
		- since we pass base64 images to the webview, we need to specify img-src ${webview.cspSource} data:;

		in meta tag we add nonce attribute: A cryptographic nonce (only used once) to allow scripts. The server must generate a unique nonce value each time it transmits a policy. It is critical to provide a nonce that cannot be guessed as bypassing a resource's policy is otherwise trivial.
		*/
		const nonce = getNonce()

		// Get the OpenRouter base URL from configuration
		const { apiConfiguration } = await this.getState()
		const openRouterBaseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai"
		// Extract the domain for CSP
		const openRouterDomain = openRouterBaseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"

		// Tip: Install the es6-string-html VS Code extension to enable code highlighting below
		return /*html*/ `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
            <meta name="theme-color" content="#000000">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https://storage.googleapis.com https://img.clerk.com data:; media-src ${webview.cspSource}; script-src ${webview.cspSource} 'wasm-unsafe-eval' 'nonce-${nonce}' 'strict-dynamic'; connect-src ${webview.cspSource} ${openRouterDomain} https://api.requesty.ai;">
            <link rel="stylesheet" type="text/css" href="${stylesUri}">
			<link href="${codiconsUri}" rel="stylesheet" />
			<script nonce="${nonce}">
				window.IMAGES_BASE_URI = "${imagesUri}"
				window.AUDIO_BASE_URI = "${audioUri}"
				window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}"
			</script>
            <title>Roo Code</title>
          </head>
          <body>
            <noscript>You need to enable JavaScript to run this app.</noscript>
            <div id="root"></div>
            <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
          </body>
        </html>
      `
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * @param webview A reference to the extension webview
	 */
	private setWebviewMessageListener(webview: vscode.Webview) {
		const onReceiveMessage = async (message: WebviewMessage) =>
			webviewMessageHandler(this, message, this.marketplaceManager)

		const messageDisposable = webview.onDidReceiveMessage(onReceiveMessage)
		this.webviewDisposables.push(messageDisposable)
	}

	/**
	 * Handle switching to a new mode, including updating the associated API configuration
	 * @param newMode The mode to switch to
	 */
	public async handleModeSwitch(newMode: Mode) {
		const task = this.getCurrentTask()

		if (task) {
			TelemetryService.instance.captureModeSwitch(task.taskId, newMode)
			task.emit(RooCodeEventName.TaskModeSwitched, task.taskId, newMode)

			try {
				// Update the task history with the new mode first.
				const taskHistoryStore = await this.getTaskHistoryStore()
				const taskHistoryItem = taskHistoryStore.get(task.taskId)

				if (taskHistoryItem) {
					await this.updateTaskHistory({ ...taskHistoryItem, mode: newMode })
				}

				// Only update the task's mode after successful persistence.
				;(task as any)._taskMode = newMode
			} catch (error) {
				// If persistence fails, log the error but don't update the in-memory state.
				this.log(
					`Failed to persist mode switch for task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
				)

				// Optionally, we could emit an event to notify about the failure.
				// This ensures the in-memory state remains consistent with persisted state.
				throw error
			}
		}

		await this.updateGlobalState("mode", newMode)

		this.emit(RooCodeEventName.ModeChanged, newMode)

		// If workspace lock is on, keep the current API config — don't load mode-specific config
		const lockApiConfigAcrossModes = this.context.workspaceState.get("lockApiConfigAcrossModes", false)
		if (lockApiConfigAcrossModes) {
			await this.postStateToWebview()
			return
		}

		// Load the saved API config for the new mode if it exists.
		const savedConfigId = await this.providerSettingsManager.getModeConfigId(newMode)
		const listApiConfig = await this.providerSettingsManager.listConfig()

		// Update listApiConfigMeta first to ensure UI has latest data.
		await this.updateGlobalState("listApiConfigMeta", listApiConfig)

		// If this mode has a saved config, use it.
		if (savedConfigId) {
			const profile = listApiConfig.find(({ id }) => id === savedConfigId)

			if (profile?.name) {
				// Check if the profile has actual API configuration (not just an id).
				// In CLI mode, the ProviderSettingsManager may return empty default profiles
				// that only contain 'id' and 'name' fields. Activating such a profile would
				// overwrite the CLI's working API configuration with empty settings.
				// Skip activation if the profile has no apiProvider set - this indicates
				// an unconfigured/empty profile.
				const fullProfile = await this.providerSettingsManager.getProfile({ name: profile.name })
				const hasActualSettings = !!fullProfile.apiProvider

				if (hasActualSettings) {
					await this.activateProviderProfile({ name: profile.name })
				} else {
					// The task will continue with the current/default configuration.
				}
			} else {
				// The task will continue with the current/default configuration.
			}
		} else {
			// If no saved config for this mode, save current config as default.
			const currentApiConfigNameAfter = this.getGlobalState("currentApiConfigName")

			if (currentApiConfigNameAfter) {
				const config = listApiConfig.find((c) => c.name === currentApiConfigNameAfter)

				if (config?.id) {
					await this.providerSettingsManager.setModeConfig(newMode, config.id)
				}
			}
		}

		await this.postStateToWebview()
	}

	// Provider Profile Management

	/**
	 * Updates the current task's API handler.
	 * Rebuilds when:
	 * - provider or model changes, OR
	 * - explicitly forced (e.g., user-initiated profile switch/save to apply changed settings like headers/baseUrl/tier).
	 * Always synchronizes task.apiConfiguration with latest provider settings.
	 * @param providerSettings The new provider settings to apply
	 * @param options.forceRebuild Force rebuilding the API handler regardless of provider/model equality
	 */
	private updateTaskApiHandlerIfNeeded(
		providerSettings: ProviderSettings,
		options: { forceRebuild?: boolean } = {},
	): void {
		const task = this.getCurrentTask()
		if (!task) return

		const { forceRebuild = false } = options

		// Determine if we need to rebuild using the previous configuration snapshot
		const prevConfig = task.apiConfiguration
		const prevProvider = prevConfig?.apiProvider
		const prevModelId = prevConfig ? getModelId(prevConfig) : undefined
		const newProvider = providerSettings.apiProvider
		const newModelId = getModelId(providerSettings)

		const needsRebuild = forceRebuild || prevProvider !== newProvider || prevModelId !== newModelId

		if (needsRebuild) {
			// Use updateApiConfiguration which handles both API handler rebuild and parser sync.
			// Note: updateApiConfiguration is declared async but has no actual async operations,
			// so we can safely call it without awaiting.
			task.updateApiConfiguration(providerSettings)
		} else {
			// No rebuild needed, just sync apiConfiguration
			;(task as any).apiConfiguration = providerSettings
		}
	}

	getProviderProfileEntries(): ProviderSettingsEntry[] {
		return this.contextProxy.getValues().listApiConfigMeta || []
	}

	getProviderProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.getProviderProfileEntries().find((profile) => profile.name === name)
	}

	public hasProviderProfileEntry(name: string): boolean {
		return !!this.getProviderProfileEntry(name)
	}

	async upsertProviderProfile(
		name: string,
		providerSettings: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		try {
			// TODO: Do we need to be calling `activateProfile`? It's not
			// clear to me what the source of truth should be; in some cases
			// we rely on the `ContextProxy`'s data store and in other cases
			// we rely on the `ProviderSettingsManager`'s data store. It might
			// be simpler to unify these two.
			const id = await this.providerSettingsManager.saveConfig(name, providerSettings)

			if (activate) {
				const { mode } = await this.getState()

				// These promises do the following:
				// 1. Adds or updates the list of provider profiles.
				// 2. Sets the current provider profile.
				// 3. Sets the current mode's provider profile.
				// 4. Copies the provider settings to the context.
				//
				// Note: 1, 2, and 4 can be done in one `ContextProxy` call:
				// this.contextProxy.setValues({ ...providerSettings, listApiConfigMeta: ..., currentApiConfigName: ... })
				// We should probably switch to that and verify that it works.
				// I left the original implementation in just to be safe.
				await Promise.all([
					this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig()),
					this.updateGlobalState("currentApiConfigName", name),
					this.providerSettingsManager.setModeConfig(mode, id),
					this.contextProxy.setProviderSettings(providerSettings),
				])

				// Change the provider for the current task.
				// TODO: We should rename `buildApiHandler` for clarity (e.g. `getProviderClient`).
				this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true })

				// Keep the current task's sticky provider profile in sync with the newly-activated profile.
				await this.persistStickyProviderProfileToCurrentTask(name)
			} else {
				await this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig())
			}

			await this.postStateToWebview()
			return id
		} catch (error) {
			this.log(
				`Error create new api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			vscode.window.showErrorMessage(t("common:errors.create_api_config"))
			return undefined
		}
	}

	async deleteProviderProfile(profileToDelete: ProviderSettingsEntry) {
		const globalSettings = this.contextProxy.getValues()
		let profileToActivate: string | undefined = globalSettings.currentApiConfigName

		if (profileToDelete.name === profileToActivate) {
			profileToActivate = this.getProviderProfileEntries().find(({ name }) => name !== profileToDelete.name)?.name
		}

		if (!profileToActivate) {
			throw new Error("You cannot delete the last profile")
		}

		const entries = this.getProviderProfileEntries().filter(({ name }) => name !== profileToDelete.name)

		await this.contextProxy.setValues({
			...globalSettings,
			currentApiConfigName: profileToActivate,
			listApiConfigMeta: entries,
		})

		await this.postStateToWebview()
	}

	private async persistStickyProviderProfileToCurrentTask(apiConfigName: string): Promise<void> {
		const task = this.getCurrentTask()
		if (!task) {
			return
		}

		try {
			// Update in-memory state immediately so sticky behavior works even before the task has
			// been persisted into taskHistory (it will be captured on the next save).
			task.setTaskApiConfigName(apiConfigName)

			const taskHistoryStore = await this.getTaskHistoryStore()
			const taskHistoryItem = taskHistoryStore.get(task.taskId)

			if (taskHistoryItem) {
				await this.updateTaskHistory({ ...taskHistoryItem, apiConfigName })
			}
		} catch (error) {
			// If persistence fails, log the error but don't fail the profile switch.
			this.log(
				`Failed to persist provider profile switch for task ${task.taskId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	async activateProviderProfile(
		args: { name: string } | { id: string },
		options?: { persistModeConfig?: boolean; persistTaskHistory?: boolean },
	) {
		const { name, id, ...providerSettings } = await this.providerSettingsManager.activateProfile(args)

		const persistModeConfig = options?.persistModeConfig ?? true
		const persistTaskHistory = options?.persistTaskHistory ?? true

		// See `upsertProviderProfile` for a description of what this is doing.
		await Promise.all([
			this.contextProxy.setValue("listApiConfigMeta", await this.providerSettingsManager.listConfig()),
			this.contextProxy.setValue("currentApiConfigName", name),
			this.contextProxy.setProviderSettings(providerSettings),
		])

		const { mode } = await this.getState()

		if (id && persistModeConfig) {
			await this.providerSettingsManager.setModeConfig(mode, id)
		}

		// Change the provider for the current task.
		this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true })

		// Update the current task's sticky provider profile, unless this activation is
		// being used purely as a non-persisting restoration (e.g., reopening a task from history).
		if (persistTaskHistory) {
			await this.persistStickyProviderProfileToCurrentTask(name)
		}

		await this.postStateToWebview()

		if (providerSettings.apiProvider) {
			this.emit(RooCodeEventName.ProviderProfileChanged, { name, provider: providerSettings.apiProvider })
		}
	}

	async updateCustomInstructions(instructions?: string) {
		// User may be clearing the field.
		await this.updateGlobalState("customInstructions", instructions || undefined)
		await this.postStateToWebview()
	}

	// MCP

	async ensureMcpServersDirectoryExists(): Promise<string> {
		// Get platform-specific application data directory
		let mcpServersDir: string
		if (process.platform === "win32") {
			// Windows: %APPDATA%\Roo-Code\MCP
			mcpServersDir = path.join(os.homedir(), "AppData", "Roaming", "Roo-Code", "MCP")
		} else if (process.platform === "darwin") {
			// macOS: ~/Documents/Cline/MCP
			mcpServersDir = path.join(os.homedir(), "Documents", "Cline", "MCP")
		} else {
			// Linux: ~/.local/share/Cline/MCP
			mcpServersDir = path.join(os.homedir(), ".local", "share", "Roo-Code", "MCP")
		}

		try {
			await fs.mkdir(mcpServersDir, { recursive: true })
		} catch (error) {
			// Fallback to a relative path if directory creation fails
			return path.join(os.homedir(), ".roo-code", "mcp")
		}
		return mcpServersDir
	}

	async ensureSettingsDirectoryExists(): Promise<string> {
		const { getSettingsDirectoryPath } = await import("../../utils/storage")
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
		return getSettingsDirectoryPath(globalStoragePath)
	}

	// OpenRouter

	async handleOpenRouterCallback(code: string) {
		let { apiConfiguration, currentApiConfigName = "default" } = await this.getState()

		let apiKey: string

		try {
			const baseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai/api/v1"
			// Extract the base domain for the auth endpoint.
			const baseUrlDomain = baseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"
			const response = await axios.post(`${baseUrlDomain}/api/v1/auth/keys`, { code })

			if (response.data && response.data.key) {
				apiKey = response.data.key
			} else {
				throw new Error("Invalid response from OpenRouter API")
			}
		} catch (error) {
			this.log(
				`Error exchanging code for API key: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			throw error
		}

		const newConfiguration: ProviderSettings = {
			...apiConfiguration,
			apiProvider: "openrouter",
			openRouterApiKey: apiKey,
			openRouterModelId: apiConfiguration?.openRouterModelId || openRouterDefaultModelId,
		}

		await this.upsertProviderProfile(currentApiConfigName, newConfiguration)
	}

	// Requesty

	async handleRequestyCallback(code: string, baseUrl: string | null) {
		let { apiConfiguration } = await this.getState()

		const newConfiguration: ProviderSettings = {
			...apiConfiguration,
			apiProvider: "requesty",
			requestyApiKey: code,
			requestyModelId: apiConfiguration?.requestyModelId || requestyDefaultModelId,
		}

		// set baseUrl as undefined if we don't provide one
		// or if it is the default requesty url
		if (!baseUrl || baseUrl === REQUESTY_BASE_URL) {
			newConfiguration.requestyBaseUrl = undefined
		} else {
			newConfiguration.requestyBaseUrl = baseUrl
		}

		const profileName = `Requesty (${new Date().toLocaleString()})`
		await this.upsertProviderProfile(profileName, newConfiguration)
	}

	// Task history

	async getTaskWithId(id: string): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		// Ensure the store is initialized before reading — an early task lookup
		// (e.g. resume via command before the constructor's fire-and-forget init
		// completes) would otherwise miss entries that haven't been loaded yet.
		const taskHistoryStore = await this.getTaskHistoryStore()

		const historyItem = taskHistoryStore.get(id)

		if (!historyItem) {
			throw new Error("Task not found")
		}

		const { getTaskDirectoryPath } = await import("../../utils/storage")
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
		const taskDirPath = await getTaskDirectoryPath(globalStoragePath, id)
		const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
		const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
		const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)

		let apiConversationHistory: Anthropic.MessageParam[] = []

		if (fileExists) {
			try {
				apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"))
			} catch (error) {
				console.warn(
					`[getTaskWithId] api_conversation_history.json corrupted for task ${id}, returning empty history: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		} else {
			console.warn(
				`[getTaskWithId] api_conversation_history.json missing for task ${id}, returning empty history`,
			)
		}

		return {
			historyItem,
			taskDirPath,
			apiConversationHistoryFilePath,
			uiMessagesFilePath,
			apiConversationHistory,
		}
	}

	async getTaskWithAggregatedCosts(taskId: string): Promise<{
		historyItem: HistoryItem
		aggregatedCosts: AggregatedCosts
	}> {
		const { historyItem } = await this.getTaskWithId(taskId)

		const aggregatedCosts = await aggregateTaskCostsRecursive(taskId, async (id: string) => {
			const result = await this.getTaskWithId(id)
			return result.historyItem
		})

		return { historyItem, aggregatedCosts }
	}

	async showTaskWithId(id: string) {
		if (id !== this.getCurrentTask()?.taskId) {
			const { historyItem } = await this.getTaskWithId(id)

			// Resolve rootTask/parentTask references from the active stack so
			// that subtask delegation metadata survives history-item round-trips
			// (only the IDs are persisted, not the live Task objects).
			let rootTask: Task | undefined
			let parentTask: Task | undefined
			if (historyItem.rootTaskId) {
				rootTask = this.clineStack.find((t) => t.taskId === historyItem.rootTaskId)
			}
			if (historyItem.parentTaskId) {
				parentTask = this.clineStack.find((t) => t.taskId === historyItem.parentTaskId)
			}

			await this.createTaskWithHistoryItem({ ...historyItem, rootTask, parentTask })
		}

		await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	async exportTaskWithId(id: string) {
		const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
		const fileName = getTaskFileName(historyItem.ts)
		const defaultUri = await resolveDefaultSaveUri(this.contextProxy, "lastTaskExportPath", fileName, {
			useWorkspace: false,
			fallbackDir: path.join(os.homedir(), "Downloads"),
		})
		const saveUri = await downloadTask(historyItem.ts, apiConversationHistory, defaultUri)

		if (saveUri) {
			await saveLastExportPath(this.contextProxy, "lastTaskExportPath", saveUri)
		}
	}

	/* Condenses a task's message history to use fewer tokens. */
	async condenseTaskContext(taskId: string) {
		let task: Task | undefined
		for (let i = this.clineStack.length - 1; i >= 0; i--) {
			if (this.clineStack[i].taskId === taskId) {
				task = this.clineStack[i]
				break
			}
		}
		if (!task) {
			// Task gone: still dismiss the spinner so the UI doesn't hang.
			await this.postMessageToWebview({ type: "condenseTaskContextResponse", text: taskId })
			throw new Error(`Task with id ${taskId} not found in stack`)
		}
		// Claim 1: wrap condenseContext in try/finally so the
		// condenseTaskContextResponse (which dismisses the ChatView spinner and
		// re-enables input) is ALWAYS sent, even when condenseContext throws.
		// Without this, an unwrapped throw leaves the spinner hanging forever
		// and the input blocked — the manual condense path has no other
		// finally (unlike manageContextIfNeeded, which has its own).
		try {
			await task.condenseContext()
		} finally {
			await this.postMessageToWebview({ type: "condenseTaskContextResponse", text: taskId })
		}
	}

	// this function deletes a task from task history, and deletes its checkpoints and delete the task folder
	// If the task has subtasks (childIds), they will also be deleted recursively
	async deleteTaskWithId(id: string, cascadeSubtasks: boolean = true) {
		try {
			// get the task directory full path and history item
			const { taskDirPath, historyItem } = await this.getTaskWithId(id)

			// Collect all task IDs to delete (parent + all subtasks)
			const allIdsToDelete: string[] = [id]

			if (cascadeSubtasks) {
				// Recursively collect all child IDs
				const collectChildIds = async (taskId: string): Promise<void> => {
					try {
						const { historyItem: item } = await this.getTaskWithId(taskId)
						if (item.childIds && item.childIds.length > 0) {
							for (const childId of item.childIds) {
								allIdsToDelete.push(childId)
								await collectChildIds(childId)
							}
						}
					} catch (error) {
						// Child task may already be deleted or not found, continue
						console.log(`[deleteTaskWithId] child task ${taskId} not found, skipping`)
					}
				}

				await collectChildIds(id)
			}

			// Remove from stack if any of the tasks to delete are in the current task stack
			for (const taskId of allIdsToDelete) {
				if (taskId === this.getCurrentTask()?.taskId) {
					// Close the current task instance; delegation flows will be handled via metadata if applicable.
					await this.removeClineFromStack()
					break
				}
			}

			// Delete all tasks from state in one batch. Mark each as
			// self-originated so the shared store's onChange echo
			// (external:false) is suppressed for us — we send our own
			// targeted delete messages below. Other providers sharing the
			// store still receive the echo and push their own targeted
			// deletes.
			const taskHistoryStore = await this.getTaskHistoryStore()
			await taskHistoryStore.deleteMany(allIdsToDelete, this.taskHistoryOrigin)
			this.recentTasksCache = undefined
			// Push a targeted delete message per ID so the webview removes
			// just these items without a full history resend (the full state
			// push below still runs for legacy callers).
			if (this.isViewLaunched) {
				for (const taskId of allIdsToDelete) {
					await this.postMessageToWebview({
						type: "taskHistoryItemDeleted",
						taskHistoryItemId: taskId,
					}).catch((err) => {
						this.log(
							`[deleteTaskWithId] targeted delete push failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
						)
					})
				}
			}

			// Delete associated shadow repositories or branches and task directories
			const globalStorageDir = this.contextProxy.globalStorageUri.fsPath
			const workspaceDir = this.cwd
			const { getTaskDirectoryPath } = await import("../../utils/storage")
			const globalStoragePath = this.contextProxy.globalStorageUri.fsPath

			for (const taskId of allIdsToDelete) {
				try {
					await ShadowCheckpointService.deleteTask({ taskId, globalStorageDir, workspaceDir })
				} catch (error) {
					console.error(
						`[deleteTaskWithId${taskId}] failed to delete associated shadow repository or branch: ${error instanceof Error ? error.message : String(error)}`,
					)
				}

				// Delete the task directory
				try {
					const dirPath = await getTaskDirectoryPath(globalStoragePath, taskId)
					await fs.rm(dirPath, { recursive: true, force: true })
					console.log(`[deleteTaskWithId${taskId}] removed task directory`)
				} catch (error) {
					console.error(
						`[deleteTaskWithId${taskId}] failed to remove task directory: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}

			await this.postStateToWebview()
		} catch (error) {
			// If task is not found, just remove it from state
			if (error instanceof Error && error.message === "Task not found") {
				await this.deleteTaskFromState(id)
				return
			}
			throw error
		}
	}

	async deleteTaskFromState(id: string) {
		// Mark this as a self-originated mutation so the shared store's
		// `onChange` echo (external:false) is suppressed for us — we send
		// our own targeted delete message below. Other providers sharing the
		// store still receive the echo and push their own targeted delete.
		const taskHistoryStore = await this.getTaskHistoryStore()
		await taskHistoryStore.delete(id, this.taskHistoryOrigin)
		this.recentTasksCache = undefined

		// Send a targeted delete message so the webview removes just this
		// item without a full history resend. The full state push below
		// still runs for legacy callers, but the webview's history list is
		// updated by this lightweight message first.
		if (this.isViewLaunched) {
			await this.postMessageToWebview({
				type: "taskHistoryItemDeleted",
				taskHistoryItemId: id,
			}).catch((err) => {
				this.log(
					`[deleteTaskFromState] targeted delete push failed: ${err instanceof Error ? err.message : String(err)}`,
				)
			})
		}

		await this.postStateToWebview()
	}

	async refreshWorkspace() {
		this.currentWorkspacePath = getWorkspacePath()
		await this.postStateToWebview()
	}

	async postStateToWebview() {
		const state = await this.getStateToPostToWebview({ includeTaskHistory: true })
		this.clineMessagesSeq++
		state.clineMessagesSeq = this.clineMessagesSeq
		this.postMessageToWebview({ type: "state", state })

		// Check MDM compliance and send user to account tab if not compliant
		// Only redirect if there's an actual MDM policy requiring authentication
		if (this.mdmService?.requiresCloudAuth() && !this.checkMdmCompliance()) {
			await this.postMessageToWebview({ type: "action", action: "cloudButtonClicked" })
		}
	}

	/**
	 * Like postStateToWebview but intentionally omits taskHistory.
	 *
	 * Rationale:
	 * - taskHistory can be large and was being resent on every chat message update.
	 * - The webview maintains taskHistory in-memory and receives updates via
	 *   `taskHistoryUpdated` / `taskHistoryItemUpdated` / `taskHistoryItemDeleted`.
	 *
	 * This path does NOT call `taskHistoryStore.getAll()`: the builder is
	 * invoked with `includeTaskHistory: false`, so the history is never
	 * materialized or sorted here. The webview keeps its in-memory history
	 * list in sync via the targeted messages.
	 */
	async postStateToWebviewWithoutTaskHistory(): Promise<void> {
		const state = await this.getStateToPostToWebview({ includeTaskHistory: false })
		this.clineMessagesSeq++
		state.clineMessagesSeq = this.clineMessagesSeq
		const { taskHistory: _omit, ...rest } = state
		this.postMessageToWebview({ type: "state", state: rest })

		// Preserve existing MDM redirect behavior
		if (this.mdmService?.requiresCloudAuth() && !this.checkMdmCompliance()) {
			await this.postMessageToWebview({ type: "action", action: "cloudButtonClicked" })
		}
	}

	/**
	 * Like postStateToWebview but intentionally omits both clineMessages and taskHistory.
	 *
	 * Rationale:
	 * - Cloud event handlers (auth, settings, user-info) and mode changes trigger state pushes
	 *   that have nothing to do with chat messages. Including clineMessages in these pushes
	 *   creates race conditions where a stale snapshot of clineMessages (captured during async
	 *   getStateToPostToWebview) overwrites newer messages the task has streamed in the meantime.
	 * - This method ensures cloud/mode events only push the state fields they actually affect
	 *   (cloud auth, org settings, profiles, etc.) without interfering with task message streaming.
	 *
	 * This path does NOT call `taskHistoryStore.getAll()` (the builder is
	 * invoked with `includeTaskHistory: false`).
	 */
	async postStateToWebviewWithoutClineMessages(): Promise<void> {
		const state = await this.getStateToPostToWebview({ includeTaskHistory: false })
		const { clineMessages: _omitMessages, taskHistory: _omitHistory, ...rest } = state
		this.postMessageToWebview({ type: "state", state: rest })

		// Preserve existing MDM redirect behavior
		if (this.mdmService?.requiresCloudAuth() && !this.checkMdmCompliance()) {
			await this.postMessageToWebview({ type: "action", action: "cloudButtonClicked" })
		}
	}

	/**
	 * Fetches marketplace data on demand to avoid blocking main state updates
	 */
	async fetchMarketplaceData() {
		try {
			const [marketplaceResult, marketplaceInstalledMetadata] = await Promise.all([
				this.marketplaceManager.getMarketplaceItems().catch((error) => {
					console.error("Failed to fetch marketplace items:", error)
					return { organizationMcps: [], marketplaceItems: [], errors: [error.message] }
				}),
				this.marketplaceManager.getInstallationMetadata().catch((error) => {
					console.error("Failed to fetch installation metadata:", error)
					return { project: {}, global: {} } as MarketplaceInstalledMetadata
				}),
			])

			// Send marketplace data separately
			this.postMessageToWebview({
				type: "marketplaceData",
				organizationMcps: marketplaceResult.organizationMcps || [],
				marketplaceItems: marketplaceResult.marketplaceItems || [],
				marketplaceInstalledMetadata: marketplaceInstalledMetadata || { project: {}, global: {} },
				errors: marketplaceResult.errors,
			})
		} catch (error) {
			console.error("Failed to fetch marketplace data:", error)

			// Send empty data on error to prevent UI from hanging
			this.postMessageToWebview({
				type: "marketplaceData",
				organizationMcps: [],
				marketplaceItems: [],
				marketplaceInstalledMetadata: { project: {}, global: {} },
				errors: [error instanceof Error ? error.message : String(error)],
			})

			// Show user-friendly error notification for network issues
			if (error instanceof Error && error.message.includes("timeout")) {
				vscode.window.showWarningMessage(
					"Marketplace data could not be loaded due to network restrictions. Core functionality remains available.",
				)
			}
		}
	}

	/**
	 * Merges allowed commands from global state and workspace configuration
	 * with proper validation and deduplication
	 */
	private mergeAllowedCommands(globalStateCommands?: string[]): string[] {
		return this.mergeCommandLists("allowedCommands", "allowed", globalStateCommands)
	}

	/**
	 * Merges denied commands from global state and workspace configuration
	 * with proper validation and deduplication
	 */
	private mergeDeniedCommands(globalStateCommands?: string[]): string[] {
		return this.mergeCommandLists("deniedCommands", "denied", globalStateCommands)
	}

	/**
	 * Common utility for merging command lists from global state and workspace configuration.
	 * Implements the Command Denylist feature's merging strategy with proper validation.
	 *
	 * @param configKey - VSCode workspace configuration key
	 * @param commandType - Type of commands for error logging
	 * @param globalStateCommands - Commands from global state
	 * @returns Merged and deduplicated command list
	 */
	private mergeCommandLists(
		configKey: "allowedCommands" | "deniedCommands",
		commandType: "allowed" | "denied",
		globalStateCommands?: string[],
	): string[] {
		try {
			// Validate and sanitize global state commands
			const validGlobalCommands = Array.isArray(globalStateCommands)
				? globalStateCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []

			// Get workspace configuration commands
			const workspaceCommands = vscode.workspace.getConfiguration(Package.name).get<string[]>(configKey) || []

			// Validate and sanitize workspace commands
			const validWorkspaceCommands = Array.isArray(workspaceCommands)
				? workspaceCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []

			// Combine and deduplicate commands
			// Global state takes precedence over workspace configuration
			const mergedCommands = [...new Set([...validGlobalCommands, ...validWorkspaceCommands])]

			return mergedCommands
		} catch (error) {
			console.error(`Error merging ${commandType} commands:`, error)
			// Return empty array as fallback to prevent crashes
			return []
		}
	}

	async getStateToPostToWebview(options: { includeTaskHistory?: boolean } = {}): Promise<ExtensionState> {
		const { includeTaskHistory = true } = options
		// Ensure the store is initialized before reading task history. Even
		// when `includeTaskHistory` is false we still await readiness so the
		// cache is populated for `currentTaskItem` lookups below.
		const taskHistoryStore = await this.getTaskHistoryStore()

		const {
			apiConfiguration,
			lastShownAnnouncementId,
			customInstructions,
			alwaysAllowReadOnly,
			alwaysAllowReadOnlyOutsideWorkspace,
			alwaysAllowWrite,
			alwaysAllowWriteOutsideWorkspace,
			alwaysAllowWriteProtected,
			alwaysAllowExecute,
			allowedCommands,
			deniedCommands,
			alwaysAllowMcp,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			alwaysApprovePlan,
			allowedMaxRequests,
			allowedMaxCost,
			autoCondenseContext,
			autoCondenseContextPercent,
			autoCondenseContextApiConfigId,
			memoryWriterApiConfigId,
			soundEnabled,
			enableCheckpoints,
			checkpointTimeout,
			soundVolume,
			customSoundCelebration,
			customSoundCelebrationOriginal,
			customSoundProgressLoop,
			customSoundProgressLoopOriginal,
			customSoundNotification,
			customSoundNotificationOriginal,
			writeDelayMs,
			terminalShellIntegrationTimeout,
			terminalShellIntegrationDisabled,
			terminalCommandDelay,
			terminalPowershellCounter,
			terminalZshClearEolMark,
			terminalZshOhMy,
			terminalZshP10k,
			terminalZdotdir,
			terminalProfile,
			mcpEnabled,
			currentApiConfigName,
			listApiConfigMeta,
			pinnedApiConfigs,
			mode,
			customModePrompts,
			customSupportPrompts,
			enhancementApiConfigId,
			autoApprovalEnabled,
			autoApprovalMode,
			customModes,
			experiments,
			maxOpenTabsContext,
			maxWorkspaceFiles,
			disabledTools,
			telemetrySetting,
			showRooIgnoredFiles,
			enableSubfolderRules,
			language,
			maxImageFileSize,
			maxTotalImageSize,
			historyPreviewCollapsed,
			reasoningBlockCollapsed,
			enterBehavior,
			cloudUserInfo,
			cloudIsAuthenticated,
			sharingEnabled,
			publicSharingEnabled,
			organizationAllowList,
			organizationSettingsVersion,
			customCondensingPrompt,
			codebaseIndexConfig,
			codebaseIndexModels,
			profileThresholds,
			alwaysAllowFollowupQuestions,
			followupAutoApproveTimeoutMs,
			includeDiagnosticMessages,
			maxDiagnosticMessages,
			includeTaskHistoryInEnhance,
			includeCurrentTime,
			includeCurrentCost,
			maxGitStatusFiles,
			parallelTasksMaxConcurrency,
			subagentFollowupTimeoutSec,
			taskSyncEnabled,
			imageGenerationProvider,
			openRouterImageApiKey,
			openRouterImageGenerationSelectedModel,
			lockApiConfigAcrossModes,
		} = await this.getState()

		let cloudOrganizations: CloudOrganizationMembership[] = []

		try {
			if (!CloudService.instance.isCloudAgent) {
				const now = Date.now()

				if (
					this.cloudOrganizationsCache !== null &&
					this.cloudOrganizationsCacheTimestamp !== null &&
					now - this.cloudOrganizationsCacheTimestamp < ClineProvider.CLOUD_ORGANIZATIONS_CACHE_DURATION_MS
				) {
					cloudOrganizations = this.cloudOrganizationsCache!
				} else {
					cloudOrganizations = await CloudService.instance.getOrganizationMemberships()
					this.cloudOrganizationsCache = cloudOrganizations
					this.cloudOrganizationsCacheTimestamp = now
				}
			}
		} catch (error) {
			// Ignore this error.
		}

		const telemetryKey = process.env.POSTHOG_API_KEY
		const machineId = vscode.env.machineId
		const mergedAllowedCommands = this.mergeAllowedCommands(allowedCommands)
		const mergedDeniedCommands = this.mergeDeniedCommands(deniedCommands)
		const cwd = this.cwd
		const currentTask = this.getCurrentTask()

		// Resolve user-uploaded custom sound files to webview URIs (undefined => use built-in).
		const customSoundUris: ExtensionState["customSoundUris"] = {}
		const webview = this.view?.webview
		if (webview) {
			const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
			const [celebrationUri, progressLoopUri, notificationUri] = await Promise.all([
				resolveCustomSoundUri(webview, globalStoragePath, customSoundCelebration),
				resolveCustomSoundUri(webview, globalStoragePath, customSoundProgressLoop),
				resolveCustomSoundUri(webview, globalStoragePath, customSoundNotification),
			])
			if (celebrationUri) customSoundUris.celebration = celebrationUri
			if (progressLoopUri) customSoundUris.progress_loop = progressLoopUri
			if (notificationUri) customSoundUris.notification = notificationUri
		}

		return {
			version: this.context.extension?.packageJSON?.version ?? "",
			apiConfiguration,
			customInstructions,
			alwaysAllowReadOnly: alwaysAllowReadOnly ?? false,
			alwaysAllowReadOnlyOutsideWorkspace: alwaysAllowReadOnlyOutsideWorkspace ?? false,
			alwaysAllowWrite: alwaysAllowWrite ?? false,
			alwaysAllowWriteOutsideWorkspace: alwaysAllowWriteOutsideWorkspace ?? false,
			alwaysAllowWriteProtected: alwaysAllowWriteProtected ?? false,
			alwaysAllowExecute: alwaysAllowExecute ?? false,
			alwaysAllowMcp: alwaysAllowMcp ?? false,
			alwaysAllowModeSwitch: alwaysAllowModeSwitch ?? false,
			alwaysAllowSubtasks: alwaysAllowSubtasks ?? false,
			alwaysApprovePlan: alwaysApprovePlan ?? false,
			allowedMaxRequests,
			allowedMaxCost,
			autoCondenseContext: autoCondenseContext ?? true,
			autoCondenseContextPercent: autoCondenseContextPercent ?? 100,
			autoCondenseContextApiConfigId,
			memoryWriterApiConfigId,
			uriScheme: vscode.env.uriScheme,
			currentTaskId: currentTask?.taskId,
			currentTaskItem: currentTask?.taskId ? taskHistoryStore.get(currentTask.taskId) : undefined,
			clineMessages: currentTask?.clineMessages || [],
			subagents: this.subagentRegistry.list(),
			memoryActivity: { ...this.memoryActivityCounts },
			currentTaskTodos: currentTask?.todoList || [],
			messageQueue: currentTask?.messageQueueService?.messages,
			// Only materialize + sort the full history when the caller
			// actually needs it. `postStateToWebviewWithoutTaskHistory` and
			// `postStateToWebviewWithoutClineMessages` pass
			// `includeTaskHistory: false` so this hot path (every chat
			// message update, every cloud/mode event) never calls
			// `getAll()`. The webview keeps its history list in sync via the
			// targeted `taskHistoryItemUpdated` / `taskHistoryItemDeleted`
			// messages and the full `taskHistoryUpdated` broadcast.
			taskHistory: includeTaskHistory
				? taskHistoryStore.getAll().filter((item: HistoryItem) => item.ts && item.task)
				: [],
			soundEnabled: soundEnabled ?? false,
			// Send `null` (not `undefined`) so the webview merge actually clears
			// the slot after a reset — postMessage drops undefined keys.
			customSoundCelebration: customSoundCelebration ?? null,
			customSoundCelebrationOriginal: customSoundCelebrationOriginal ?? null,
			customSoundProgressLoop: customSoundProgressLoop ?? null,
			customSoundProgressLoopOriginal: customSoundProgressLoopOriginal ?? null,
			customSoundNotification: customSoundNotification ?? null,
			customSoundNotificationOriginal: customSoundNotificationOriginal ?? null,
			customSoundUris,
			enableCheckpoints: enableCheckpoints ?? true,
			checkpointTimeout: checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			shouldShowAnnouncement:
				telemetrySetting !== "unset" && lastShownAnnouncementId !== this.latestAnnouncementId,
			allowedCommands: mergedAllowedCommands,
			deniedCommands: mergedDeniedCommands,
			soundVolume: soundVolume ?? 0.5,
			writeDelayMs: writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
			terminalShellIntegrationTimeout: terminalShellIntegrationTimeout ?? Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled: terminalShellIntegrationDisabled ?? true,
			terminalCommandDelay: terminalCommandDelay ?? 0,
			terminalPowershellCounter: terminalPowershellCounter ?? false,
			terminalZshClearEolMark: terminalZshClearEolMark ?? true,
			terminalZshOhMy: terminalZshOhMy ?? false,
			terminalZshP10k: terminalZshP10k ?? false,
			terminalZdotdir: terminalZdotdir ?? false,
			terminalProfile,
			mcpEnabled: mcpEnabled ?? true,
			currentApiConfigName: currentApiConfigName ?? "default",
			listApiConfigMeta: listApiConfigMeta ?? [],
			pinnedApiConfigs: pinnedApiConfigs ?? {},
			mode: mode ?? defaultModeSlug,
			customModePrompts: customModePrompts ?? {},
			customSupportPrompts: customSupportPrompts ?? {},
			enhancementApiConfigId,
			autoApprovalEnabled: autoApprovalEnabled ?? false,
			autoApprovalMode: autoApprovalMode ?? "default",
			customModes,
			experiments: experiments ?? experimentDefault,
			mcpServers: this.mcpHub?.getAllServers() ?? [],
			maxOpenTabsContext: maxOpenTabsContext ?? 20,
			maxWorkspaceFiles: maxWorkspaceFiles ?? 200,
			cwd,
			disabledTools,
			telemetrySetting,
			telemetryKey,
			machineId,
			showRooIgnoredFiles: showRooIgnoredFiles ?? false,
			enableSubfolderRules: enableSubfolderRules ?? false,
			language: language ?? formatLanguage(vscode.env.language),
			renderContext: this.renderContext,
			maxImageFileSize: maxImageFileSize ?? 5,
			maxTotalImageSize: maxTotalImageSize ?? 20,
			settingsImportedAt: this.settingsImportedAt,
			historyPreviewCollapsed: historyPreviewCollapsed ?? false,
			reasoningBlockCollapsed: reasoningBlockCollapsed ?? true,
			enterBehavior: enterBehavior ?? "send",
			cloudUserInfo,
			cloudIsAuthenticated: cloudIsAuthenticated ?? false,
			cloudAuthSkipModel: this.context.globalState.get<boolean>("roo-auth-skip-model") ?? false,
			cloudOrganizations,
			sharingEnabled: sharingEnabled ?? false,
			publicSharingEnabled: publicSharingEnabled ?? false,
			organizationAllowList,
			organizationSettingsVersion,
			customCondensingPrompt,
			codebaseIndexModels: codebaseIndexModels ?? EMBEDDING_MODEL_PROFILES,
			codebaseIndexConfig: {
				codebaseIndexEnabled: codebaseIndexConfig?.codebaseIndexEnabled ?? false,
				codebaseIndexQdrantUrl: codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
				codebaseIndexEmbedderProvider: codebaseIndexConfig?.codebaseIndexEmbedderProvider ?? "openai",
				codebaseIndexEmbedderBaseUrl: codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
				codebaseIndexEmbedderModelId: codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
				codebaseIndexEmbedderModelDimension: codebaseIndexConfig?.codebaseIndexEmbedderModelDimension ?? 1536,
				codebaseIndexOpenAiCompatibleBaseUrl: codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexSearchMaxResults: codebaseIndexConfig?.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: codebaseIndexConfig?.codebaseIndexSearchMinScore,
				codebaseIndexBedrockRegion: codebaseIndexConfig?.codebaseIndexBedrockRegion,
				codebaseIndexBedrockProfile: codebaseIndexConfig?.codebaseIndexBedrockProfile,
				codebaseIndexOpenRouterSpecificProvider: codebaseIndexConfig?.codebaseIndexOpenRouterSpecificProvider,
			},
			// Only set mdmCompliant if there's an actual MDM policy
			// undefined means no MDM policy, true means compliant, false means non-compliant
			mdmCompliant: this.mdmService?.requiresCloudAuth() ? this.checkMdmCompliance() : undefined,
			profileThresholds: profileThresholds ?? {},
			cloudApiUrl: getRooCodeApiUrl(),
			hasOpenedModeSelector: this.getGlobalState("hasOpenedModeSelector") ?? false,
			lockApiConfigAcrossModes: lockApiConfigAcrossModes ?? false,
			alwaysAllowFollowupQuestions: alwaysAllowFollowupQuestions ?? false,
			followupAutoApproveTimeoutMs: followupAutoApproveTimeoutMs ?? 60000,
			includeDiagnosticMessages: includeDiagnosticMessages ?? true,
			maxDiagnosticMessages: maxDiagnosticMessages ?? 50,
			includeTaskHistoryInEnhance: includeTaskHistoryInEnhance ?? true,
			includeCurrentTime: includeCurrentTime ?? true,
			includeCurrentCost: includeCurrentCost ?? true,
			maxGitStatusFiles: maxGitStatusFiles ?? 0,
			parallelTasksMaxConcurrency: parallelTasksMaxConcurrency ?? DEFAULT_PARALLEL_TASKS_MAX_CONCURRENCY,
			subagentFollowupTimeoutSec: subagentFollowupTimeoutSec ?? DEFAULT_SUBAGENT_FOLLOWUP_TIMEOUT_SEC,
			taskSyncEnabled,
			imageGenerationProvider,
			openRouterImageApiKey,
			openRouterImageGenerationSelectedModel,
			openAiCodexIsAuthenticated: await (async () => {
				try {
					const { openAiCodexOAuthManager } = await import("../../integrations/openai-codex/oauth")
					return await openAiCodexOAuthManager.isAuthenticated()
				} catch {
					return false
				}
			})(),
			debug: vscode.workspace.getConfiguration(Package.name).get<boolean>("debug", false),
		}
	}

	/**
	 * Storage
	 * https://dev.to/kompotkot/how-to-use-secretstorage-in-your-vscode-extensions-2hco
	 * https://www.eliostruyf.com/devhack-code-extension-storage-options/
	 */

	async getState(): Promise<
		Omit<
			ExtensionState,
			"clineMessages" | "renderContext" | "hasOpenedModeSelector" | "version" | "shouldShowAnnouncement"
		>
	> {
		const stateValues = this.contextProxy.getValues()
		const customModes = await this.customModesManager.getCustomModes()

		// Determine apiProvider with the same logic as before, while filtering retired providers.
		const apiProvider: ProviderName =
			stateValues.apiProvider && !isRetiredProvider(stateValues.apiProvider)
				? stateValues.apiProvider
				: "anthropic"

		// Build the apiConfiguration object combining state values and secrets.
		const providerSettings = this.contextProxy.getProviderSettings()

		// Ensure apiProvider is set properly if not already in state
		if (!providerSettings.apiProvider) {
			providerSettings.apiProvider = apiProvider
		}

		let organizationAllowList = ORGANIZATION_ALLOW_ALL

		try {
			organizationAllowList = await CloudService.instance.getAllowList()
		} catch (error) {
			console.error(
				`[getState] failed to get organization allow list: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let cloudUserInfo: CloudUserInfo | null = null

		try {
			cloudUserInfo = CloudService.instance.getUserInfo()
		} catch (error) {
			console.error(
				`[getState] failed to get cloud user info: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let cloudIsAuthenticated: boolean = false

		try {
			cloudIsAuthenticated = CloudService.instance.isAuthenticated()
		} catch (error) {
			console.error(
				`[getState] failed to get cloud authentication state: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let sharingEnabled: boolean = false

		try {
			sharingEnabled = await CloudService.instance.canShareTask()
		} catch (error) {
			console.error(
				`[getState] failed to get sharing enabled state: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let publicSharingEnabled: boolean = false

		try {
			publicSharingEnabled = await CloudService.instance.canSharePublicly()
		} catch (error) {
			console.error(
				`[getState] failed to get public sharing enabled state: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let organizationSettingsVersion: number = -1

		try {
			if (CloudService.hasInstance()) {
				const settings = CloudService.instance.getOrganizationSettings()
				organizationSettingsVersion = settings?.version ?? -1
			}
		} catch (error) {
			console.error(
				`[getState] failed to get organization settings version: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let taskSyncEnabled: boolean = false

		try {
			taskSyncEnabled = CloudService.instance.isTaskSyncEnabled()
		} catch (error) {
			console.error(
				`[getState] failed to get task sync enabled state: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		// Return the same structure as before.
		return {
			apiConfiguration: providerSettings,
			// The plan-review write gate (checkAutoApproval) resolves relative
			// tool paths against cwd; getStateToPostToWebview has it, but this
			// method is what TaskAskSay/subagent approval consume.
			cwd: this.cwd,
			lastShownAnnouncementId: stateValues.lastShownAnnouncementId,
			customInstructions: stateValues.customInstructions,
			apiModelId: stateValues.apiModelId,
			alwaysAllowReadOnly: stateValues.alwaysAllowReadOnly ?? false,
			alwaysAllowReadOnlyOutsideWorkspace: stateValues.alwaysAllowReadOnlyOutsideWorkspace ?? false,
			alwaysAllowWrite: stateValues.alwaysAllowWrite ?? false,
			alwaysAllowWriteOutsideWorkspace: stateValues.alwaysAllowWriteOutsideWorkspace ?? false,
			alwaysAllowWriteProtected: stateValues.alwaysAllowWriteProtected ?? false,
			alwaysAllowExecute: stateValues.alwaysAllowExecute ?? false,
			alwaysAllowMcp: stateValues.alwaysAllowMcp ?? false,
			alwaysAllowModeSwitch: stateValues.alwaysAllowModeSwitch ?? false,
			alwaysAllowSubtasks: stateValues.alwaysAllowSubtasks ?? false,
			alwaysApprovePlan: stateValues.alwaysApprovePlan ?? false,
			alwaysAllowFollowupQuestions: stateValues.alwaysAllowFollowupQuestions ?? false,
			followupAutoApproveTimeoutMs: stateValues.followupAutoApproveTimeoutMs ?? 60000,
			diagnosticsEnabled: stateValues.diagnosticsEnabled ?? true,
			allowedMaxRequests: stateValues.allowedMaxRequests,
			allowedMaxCost: stateValues.allowedMaxCost,
			autoCondenseContext: stateValues.autoCondenseContext ?? true,
			autoCondenseContextPercent: stateValues.autoCondenseContextPercent ?? 100,
			autoCondenseContextApiConfigId: stateValues.autoCondenseContextApiConfigId,
			memoryWriterApiConfigId: stateValues.memoryWriterApiConfigId,
			// `getState` is a hot path consumed by many internal call sites
			// (system prompt building, auto-approval, retry, plan review…)
			// that never read task history. Materializing and sorting the
			// full history here on every call was a dominant per-message cost.
			// Callers that actually need the history must use
			// {@link getTaskHistory} or {@link getStateToPostToWebview},
			// both of which read it explicitly. We return an empty array to
			// satisfy the ExtensionState shape without the I/O.
			taskHistory: [],
			allowedCommands: stateValues.allowedCommands,
			deniedCommands: stateValues.deniedCommands,
			soundEnabled: stateValues.soundEnabled ?? false,
			customSoundCelebration: stateValues.customSoundCelebration,
			customSoundCelebrationOriginal: stateValues.customSoundCelebrationOriginal,
			customSoundProgressLoop: stateValues.customSoundProgressLoop,
			customSoundProgressLoopOriginal: stateValues.customSoundProgressLoopOriginal,
			customSoundNotification: stateValues.customSoundNotification,
			customSoundNotificationOriginal: stateValues.customSoundNotificationOriginal,
			enableCheckpoints: stateValues.enableCheckpoints ?? true,
			checkpointTimeout: stateValues.checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			soundVolume: stateValues.soundVolume,
			writeDelayMs: stateValues.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
			terminalShellIntegrationTimeout:
				stateValues.terminalShellIntegrationTimeout ?? Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled: stateValues.terminalShellIntegrationDisabled ?? true,
			terminalCommandDelay: stateValues.terminalCommandDelay ?? 0,
			terminalPowershellCounter: stateValues.terminalPowershellCounter ?? false,
			terminalZshClearEolMark: stateValues.terminalZshClearEolMark ?? true,
			terminalZshOhMy: stateValues.terminalZshOhMy ?? false,
			terminalZshP10k: stateValues.terminalZshP10k ?? false,
			terminalZdotdir: stateValues.terminalZdotdir ?? false,
			terminalProfile: stateValues.terminalProfile,
			mode: stateValues.mode ?? defaultModeSlug,
			language: stateValues.language ?? formatLanguage(vscode.env.language),
			mcpEnabled: stateValues.mcpEnabled ?? true,
			mcpServers: this.mcpHub?.getAllServers() ?? [],
			currentApiConfigName: stateValues.currentApiConfigName ?? "default",
			listApiConfigMeta: stateValues.listApiConfigMeta ?? [],
			pinnedApiConfigs: stateValues.pinnedApiConfigs ?? {},
			modeApiConfigs: stateValues.modeApiConfigs ?? ({} as Record<Mode, string>),
			customModePrompts: stateValues.customModePrompts ?? {},
			customSupportPrompts: stateValues.customSupportPrompts ?? {},
			enhancementApiConfigId: stateValues.enhancementApiConfigId,
			experiments: stateValues.experiments ?? experimentDefault,
			autoApprovalEnabled: stateValues.autoApprovalEnabled ?? false,
			autoApprovalMode: stateValues.autoApprovalMode ?? "default",
			customModes,
			maxOpenTabsContext: stateValues.maxOpenTabsContext ?? 20,
			maxWorkspaceFiles: stateValues.maxWorkspaceFiles ?? 200,
			disabledTools: stateValues.disabledTools,
			telemetrySetting: stateValues.telemetrySetting || "unset",
			showRooIgnoredFiles: stateValues.showRooIgnoredFiles ?? false,
			enableSubfolderRules: stateValues.enableSubfolderRules ?? false,
			maxImageFileSize: stateValues.maxImageFileSize ?? 5,
			maxTotalImageSize: stateValues.maxTotalImageSize ?? 20,
			historyPreviewCollapsed: stateValues.historyPreviewCollapsed ?? false,
			reasoningBlockCollapsed: stateValues.reasoningBlockCollapsed ?? true,
			enterBehavior: stateValues.enterBehavior ?? "send",
			cloudUserInfo,
			cloudIsAuthenticated,
			sharingEnabled,
			publicSharingEnabled,
			organizationAllowList,
			organizationSettingsVersion,
			customCondensingPrompt: stateValues.customCondensingPrompt,
			codebaseIndexModels: stateValues.codebaseIndexModels ?? EMBEDDING_MODEL_PROFILES,
			codebaseIndexConfig: {
				codebaseIndexEnabled: stateValues.codebaseIndexConfig?.codebaseIndexEnabled ?? false,
				codebaseIndexQdrantUrl:
					stateValues.codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
				codebaseIndexEmbedderProvider:
					stateValues.codebaseIndexConfig?.codebaseIndexEmbedderProvider ?? "openai",
				codebaseIndexEmbedderBaseUrl: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
				codebaseIndexEmbedderModelId: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
				codebaseIndexEmbedderModelDimension:
					stateValues.codebaseIndexConfig?.codebaseIndexEmbedderModelDimension,
				codebaseIndexOpenAiCompatibleBaseUrl:
					stateValues.codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexSearchMaxResults: stateValues.codebaseIndexConfig?.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: stateValues.codebaseIndexConfig?.codebaseIndexSearchMinScore,
				codebaseIndexBedrockRegion: stateValues.codebaseIndexConfig?.codebaseIndexBedrockRegion,
				codebaseIndexBedrockProfile: stateValues.codebaseIndexConfig?.codebaseIndexBedrockProfile,
				codebaseIndexOpenRouterSpecificProvider:
					stateValues.codebaseIndexConfig?.codebaseIndexOpenRouterSpecificProvider,
			},
			profileThresholds: stateValues.profileThresholds ?? {},
			lockApiConfigAcrossModes: this.context.workspaceState.get("lockApiConfigAcrossModes", false),
			includeDiagnosticMessages: stateValues.includeDiagnosticMessages ?? true,
			maxDiagnosticMessages: stateValues.maxDiagnosticMessages ?? 50,
			includeTaskHistoryInEnhance: stateValues.includeTaskHistoryInEnhance ?? true,
			includeCurrentTime: stateValues.includeCurrentTime ?? true,
			includeCurrentCost: stateValues.includeCurrentCost ?? true,
			maxGitStatusFiles: stateValues.maxGitStatusFiles ?? 0,
			parallelTasksMaxConcurrency:
				stateValues.parallelTasksMaxConcurrency ?? DEFAULT_PARALLEL_TASKS_MAX_CONCURRENCY,
			subagentFollowupTimeoutSec: stateValues.subagentFollowupTimeoutSec ?? DEFAULT_SUBAGENT_FOLLOWUP_TIMEOUT_SEC,
			taskSyncEnabled,
			imageGenerationProvider: stateValues.imageGenerationProvider,
			openRouterImageApiKey: stateValues.openRouterImageApiKey,
			openRouterImageGenerationSelectedModel: stateValues.openRouterImageGenerationSelectedModel,
		}
	}

	/**
	 * Updates a task in the task history and optionally broadcasts the
	 * updated item to the webview. Delegates persistence to the shared
	 * {@link TaskHistoryStore}.
	 *
	 * Returns `void` — callers that need the full sorted history should call
	 * {@link getTaskHistory} explicitly. This avoids copying and sorting the
	 * entire history on every mutation; the webview is kept in sync via the
	 * targeted `taskHistoryItemUpdated` message and the store's
	 * {@link TaskHistoryStore.onChange} subscription.
	 *
	 * @param item The history item to update or add
	 * @param options.broadcast Whether to broadcast the updated item to the webview (default: true)
	 */
	async updateTaskHistory(item: HistoryItem, options: { broadcast?: boolean } = {}): Promise<void> {
		const { broadcast = true } = options

		// Mark this as a self-originated mutation so the shared store's
		// `onChange` echo (external:false) is suppressed for us — we send
		// our own targeted message below. Other providers sharing the store
		// still receive the echo and push their own targeted update.
		const taskHistoryStore = await this.getTaskHistoryStore()
		await taskHistoryStore.upsert(item, this.taskHistoryOrigin)
		this.recentTasksCache = undefined

		// Broadcast the updated item to the webview if requested.
		// Prefer per-item updates to avoid repeatedly cloning/sending the full history.
		if (broadcast && this.isViewLaunched) {
			const updatedItem = taskHistoryStore.get(item.id) ?? item
			await this.postMessageToWebview({ type: "taskHistoryItemUpdated", taskHistoryItem: updatedItem })
		}
	}

	/**
	 * Broadcasts a task history update to the webview.
	 * This sends a lightweight message with just the task history, rather than the full state.
	 * @param history The task history to broadcast (if not provided, reads from the store)
	 */
	public async broadcastTaskHistoryUpdate(history?: HistoryItem[]): Promise<void> {
		if (!this.isViewLaunched) {
			return
		}

		const taskHistoryStore = await this.getTaskHistoryStore()
		const taskHistory = history ?? taskHistoryStore.getAll()

		// Sort and filter the history the same way as getStateToPostToWebview
		const sortedHistory = taskHistory
			.filter((item: HistoryItem) => item.ts && item.task)
			.sort((a: HistoryItem, b: HistoryItem) => b.ts - a.ts)

		await this.postMessageToWebview({
			type: "taskHistoryUpdated",
			taskHistory: sortedHistory,
		})
	}

	/**
	 * Focused accessor for the full task history from the store.
	 *
	 * Used by consumers (e.g. TaskLifecycle auto-dream) that previously read
	 * `taskHistory` from globalState. The TaskHistoryStore is the sole
	 * persistence source, so this replaces those globalState reads.
	 *
	 * @returns All history items sorted by timestamp descending (newest first).
	 */
	public async getTaskHistory(): Promise<HistoryItem[]> {
		return (await this.getTaskHistoryStore()).getAll()
	}

	// ContextProxy

	// @deprecated - Use `ContextProxy#setValue` instead.
	private async updateGlobalState<K extends keyof GlobalState>(key: K, value: GlobalState[K]) {
		await this.contextProxy.setValue(key, value)
	}

	// @deprecated - Use `ContextProxy#getValue` instead.
	private getGlobalState<K extends keyof GlobalState>(key: K) {
		return this.contextProxy.getValue(key)
	}

	public async setValue<K extends keyof RooCodeSettings>(key: K, value: RooCodeSettings[K]) {
		await this.contextProxy.setValue(key, value)
	}

	public getValue<K extends keyof RooCodeSettings>(key: K) {
		return this.contextProxy.getValue(key)
	}

	public getValues() {
		return this.contextProxy.getValues()
	}

	public async setValues(values: RooCodeSettings) {
		await this.contextProxy.setValues(values)
	}

	// dev

	async resetState() {
		const answer = await vscode.window.showInformationMessage(
			t("common:confirmation.reset_state"),
			{ modal: true },
			t("common:answers.yes"),
		)

		if (answer !== t("common:answers.yes")) {
			return
		}

		// Log out from cloud if authenticated
		if (CloudService.hasInstance()) {
			try {
				await CloudService.instance.logout()
			} catch (error) {
				this.log(
					`Failed to logout from cloud during reset: ${error instanceof Error ? error.message : String(error)}`,
				)
				// Continue with reset even if logout fails
			}
		}

		await this.contextProxy.resetAllState()
		await this.providerSettingsManager.resetAllConfigs()
		await this.customModesManager.resetCustomModes()
		await this.removeClineFromStack()
		await this.postStateToWebview()
		await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	// logging

	public log(message: string) {
		this.outputChannel.appendLine(message)
		console.log(message)
	}

	// getters

	public get workspaceTracker(): WorkspaceTracker | undefined {
		return this._workspaceTracker
	}

	get viewLaunched() {
		return this.isViewLaunched
	}

	get messages() {
		return this.getCurrentTask()?.clineMessages || []
	}

	public getMcpHub(): McpHub | undefined {
		return this.mcpHub
	}

	public getSkillsManager(): SkillsManager | undefined {
		return this.skillsManager
	}

	/**
	 * Check if the current state is compliant with MDM policy
	 * @returns true if compliant or no MDM policy exists, false if MDM policy exists and user is non-compliant
	 */
	public checkMdmCompliance(): boolean {
		if (!this.mdmService) {
			return true // No MDM service, allow operation
		}

		const compliance = this.mdmService.isCompliant()

		if (!compliance.compliant) {
			return false
		}

		return true
	}

	/**
	 * Gets the CodeIndexManager for the current active workspace
	 * @returns CodeIndexManager instance for the current workspace or the default one
	 */
	public getCurrentWorkspaceCodeIndexManager(): CodeIndexManager | undefined {
		return CodeIndexManager.getInstance(this.context)
	}

	/**
	 * Updates the code index status subscription to listen to the current workspace manager
	 */
	private updateCodeIndexStatusSubscription(): void {
		// Get the current workspace manager
		const currentManager = this.getCurrentWorkspaceCodeIndexManager()

		// If the manager hasn't changed, no need to update subscription
		if (currentManager === this.codeIndexManager) {
			return
		}

		// Dispose the old subscription if it exists
		if (this.codeIndexStatusSubscription) {
			this.codeIndexStatusSubscription.dispose()
			this.codeIndexStatusSubscription = undefined
		}

		// Update the current workspace manager reference
		this.codeIndexManager = currentManager

		// Subscribe to the new manager's progress updates if it exists
		if (currentManager) {
			this.codeIndexStatusSubscription = currentManager.onProgressUpdate((update: IndexProgressUpdate) => {
				// Only send updates if this manager is still the current one
				if (currentManager === this.getCurrentWorkspaceCodeIndexManager()) {
					// Get the full status from the manager to ensure we have all fields correctly formatted
					const fullStatus = currentManager.getCurrentStatus()
					this.postMessageToWebview({
						type: "indexingStatusUpdate",
						values: fullStatus,
					})
				}
			})

			if (this.view) {
				this.webviewDisposables.push(this.codeIndexStatusSubscription)
			}

			// Send initial status for the current workspace
			this.postMessageToWebview({
				type: "indexingStatusUpdate",
				values: currentManager.getCurrentStatus(),
			})
		}
	}

	/**
	 * TaskProviderLike, TelemetryPropertiesProvider
	 */

	public getCurrentTask(): Task | undefined {
		if (this.clineStack.length === 0) {
			return undefined
		}

		return this.clineStack[this.clineStack.length - 1]
	}

	private logWebviewHiddenDiagnostics(): void {
		const task = this.getCurrentTask()
		if (!task || task.abort || task.abandoned) {
			return
		}
		this.log(
			`[Tumble Code] Webview hidden during active task.\n` +
				`  taskId:       ${task.taskId}\n` +
				`  messageCount: ${task.clineMessages.length}\n` +
				`  stackDepth:   ${this.clineStack.length}\n` +
				`  timestamp:    ${new Date().toISOString()}\n` +
				`If the panel appears gray after this, include this log when reporting the issue.`,
		)
	}

	public async getRecentTasks(): Promise<string[]> {
		if (this.recentTasksCache) {
			return this.recentTasksCache
		}

		const history = (await this.getTaskHistoryStore()).getAll()
		const workspaceTasks: HistoryItem[] = []

		for (const item of history) {
			if (!item.ts || !item.task || item.workspace !== this.cwd) {
				continue
			}

			workspaceTasks.push(item)
		}

		if (workspaceTasks.length === 0) {
			this.recentTasksCache = []
			return this.recentTasksCache
		}

		workspaceTasks.sort((a, b) => b.ts - a.ts)
		let recentTaskIds: string[] = []

		if (workspaceTasks.length >= 100) {
			// If we have at least 100 tasks, return tasks from the last 7 days.
			const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

			for (const item of workspaceTasks) {
				// Stop when we hit tasks older than 7 days.
				if (item.ts < sevenDaysAgo) {
					break
				}

				recentTaskIds.push(item.id)
			}
		} else {
			// Otherwise, return the most recent 100 tasks (or all if less than 100).
			recentTaskIds = workspaceTasks.slice(0, Math.min(100, workspaceTasks.length)).map((item) => item.id)
		}

		this.recentTasksCache = recentTaskIds
		return this.recentTasksCache
	}

	// When initializing a new task, (not from history but from a tool command
	// new_task) there is no need to remove the previous task since the new
	// task is a subtask of the previous one, and when it finishes it is removed
	// from the stack and the caller is resumed in this way we can have a chain
	// of tasks, each one being a sub task of the previous one until the main
	// task is finished.
	public async createTask(
		text?: string,
		images?: string[],
		parentTask?: Task,
		options: CreateTaskOptions = {},
		configuration: RooCodeSettings = {},
	): Promise<Task> {
		if (configuration) {
			await this.setValues(configuration)

			if (configuration.allowedCommands) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update("allowedCommands", configuration.allowedCommands, vscode.ConfigurationTarget.Global)
			}

			if (configuration.deniedCommands) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update("deniedCommands", configuration.deniedCommands, vscode.ConfigurationTarget.Global)
			}

			if (configuration.commandExecutionTimeout !== undefined) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update(
						"commandExecutionTimeout",
						configuration.commandExecutionTimeout,
						vscode.ConfigurationTarget.Global,
					)
			}

			if (configuration.currentApiConfigName) {
				await this.setProviderProfile(configuration.currentApiConfigName)
			}

			// Register custom modes so the CustomModesManager knows about them.
			// setValues writes to global state, but the manager overwrites that
			// when it merges .roomodes + global settings on refresh.  Persisting
			// via updateCustomMode ensures modes survive the merge cycle.
			if (configuration.customModes?.length) {
				for (const mode of configuration.customModes) {
					await this.customModesManager.updateCustomMode(mode.slug, mode)
				}
			}
		}

		const { apiConfiguration, organizationAllowList, enableCheckpoints, checkpointTimeout, experiments } =
			await this.getState()

		// Single-open-task invariant: always enforce for user-initiated top-level tasks
		if (!parentTask) {
			// Reset the subagent panel BEFORE popping the stack so the
			// broadcast still carries the about-to-be-popped task's id as
			// `sourceTaskId` (the webview scopes by currentTaskId; after the
			// pop there is no current task and the post would be dropped by
			// the scope guard). Subagents from the previous task never leak
			// into the new task's panel.
			try {
				await this.resetSubagentPanel()
			} catch {
				// Non-fatal: panel reset is best-effort.
			}
			try {
				await this.removeClineFromStack()
			} catch {
				// Non-fatal
			}
		}

		if (!ProfileValidator.isProfileAllowed(apiConfiguration, organizationAllowList)) {
			throw new OrganizationAllowListViolationError(t("common:errors.violated_organization_allowlist"))
		}

		const task = new Task({
			provider: this,
			apiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
			task: text,
			images,
			experiments,
			rootTask: this.clineStack.length > 0 ? this.clineStack[0] : undefined,
			parentTask,
			taskNumber: this.clineStack.length + 1,
			onCreated: this.taskCreationCallback,
			initialTodos: options.initialTodos,
			// Ensure this task is present in clineStack before startTask() emits
			// its initial state update, so state.currentTaskId is available ASAP.
			startTask: false,
			...options,
		})

		await this.addClineToStack(task)
		// Gate the explicit start so callers passing `startTask: false`
		// (e.g. delegateParentAndOpenChild) can persist surrounding metadata
		// before the task loop begins. Without this, the child loop starts here
		// and the later child.start() becomes a no-op (_started guard).
		if (options.startTask !== false) {
			task.start()
		}

		this.log(
			`[createTask] ${task.parentTask ? "child" : "parent"} task ${task.taskId}.${task.instanceId} instantiated`,
		)

		return task
	}

	/**
	 * Create and start a HEADLESS background task — the reusable primitive behind
	 * the memory background writers and the `run_parallel_tasks` subagents.
	 *
	 * Unlike {@link createTask}, a background task:
	 * - is **never** pushed onto `clineStack`, so `getCurrentTask()` and the
	 *   webview stay bound to the foreground task;
	 * - runs autonomously via `autoApprovalOverride` (interactive asks never block
	 *   it — the task isn't the current task, so no webview response would arrive);
	 * - is bounded by `maxAgentTurns`;
	 * - can run in its own `workspacePath` (a git worktree) and `taskMode`
	 *   (e.g. a write-sandboxed mode).
	 *
	 * Pair with {@link awaitTaskCompletion} to await its result.
	 */
	public async createBackgroundTask(
		text: string,
		options: {
			taskMode?: string
			workspacePath?: string
			maxAgentTurns?: number
			autoApprovalOverride?: AutoApprovalOverride
			silentWrites?: boolean
			initialTodos?: TodoItem[]
			apiConfiguration?: ProviderSettings
			/**
			 * Registers the child in the subagent registry so it is visible in
			 * the webview subagents panel. Omitted for internal background
			 * tasks (memory writers), which stay invisible.
			 */
			subagentInfo?: { parentTaskId: string; index: number; description: string }
		} = {},
	): Promise<Task> {
		const state = await this.getState()
		// Model resolution, most specific wins: explicit apiConfiguration from
		// the caller → the subtask mode's pinned API profile (same binding a
		// foreground mode switch applies) → the currently active profile.
		// Mode resolution is scoped to panel-visible subagents so internal
		// background tasks (memory writers) keep their explicit/current config.
		let apiConfiguration = options.apiConfiguration
		let apiConfigName = options.apiConfiguration ? undefined : state.currentApiConfigName
		if (!apiConfiguration && options.subagentInfo && options.taskMode) {
			const resolved = await this.getApiConfigurationForMode(options.taskMode)
			if (resolved) {
				apiConfiguration = resolved.apiConfiguration
				apiConfigName = resolved.name
			}
		}
		apiConfiguration ??= state.apiConfiguration
		const { experiments } = state

		const task = new Task({
			provider: this,
			apiConfiguration,
			// Background tasks don't participate in checkpoints (no shadow git per
			// memory write); keeps them cheap and side-effect-free.
			enableCheckpoints: false,
			experiments,
			task: text,
			taskMode: options.taskMode,
			workspacePath: options.workspacePath,
			isBackground: true,
			maxAgentTurns: options.maxAgentTurns,
			autoApprovalOverride: options.autoApprovalOverride,
			silentWrites: options.silentWrites,
			initialTodos: options.initialTodos,
			// Start explicitly below (after registry insert), never via the stack.
			startTask: false,
			onCreated: this.taskCreationCallback,
		})

		this.backgroundTasks.set(task.taskId, task)
		if (options.subagentInfo) {
			// Register BEFORE start() so a tail subscribed on the queued
			// placeholder streams the child's first messages.
			const now = Date.now()
			this.subagentRegistry.register({
				taskId: task.taskId,
				parentTaskId: options.subagentInfo.parentTaskId,
				index: options.subagentInfo.index,
				mode: options.taskMode ?? state.mode,
				description: options.subagentInfo.description,
				status: "running",
				apiConfigName,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				startedAt: now,
				lastActivityAt: now,
			})
		}
		this.log(`[createBackgroundTask] started background task ${task.taskId}.${task.instanceId}`)
		task.start()
		return task
	}

	/** Look up a live headless background task (parallel subagent) by id. */
	public getBackgroundTask(taskId: string): Task | undefined {
		return this.backgroundTasks.get(taskId)
	}

	/**
	 * Find the CURRENT live instance of a task by id on the foreground stack
	 * (top-down). Used by a detached fan-out to deliver its report to the
	 * rehydrated instance of its parent — the original instance that launched
	 * the fan-out may have been abandoned by a task switch or in-place
	 * rehydrate while the children kept running.
	 */
	public getLiveTaskInstance(taskId: string): Task | undefined {
		for (let i = this.clineStack.length - 1; i >= 0; i--) {
			if (this.clineStack[i].taskId === taskId) {
				return this.clineStack[i]
			}
		}
		return undefined
	}

	/**
	 * Absolute path of the extension global storage directory (the parent of
	 * `tasks/<id>/`). Exposed so `run_parallel_tasks` can resolve its
	 * `subagents.json` sidecar path without importing storage helpers
	 * directly (keeps the tool's provider surface narrow and testable).
	 */
	public get globalStoragePath(): string {
		return this.contextProxy.globalStorageUri.fsPath
	}

	/**
	 * Atomically read a task's `HistoryItem`, apply `updater`, and write it
	 * back. Thin wrapper over `TaskHistoryStore.atomicReadAndUpdate` exposed
	 * so `run_parallel_tasks` can record `parallelChildIds` on the parent
	 * without importing the store directly. Throws if the store is missing
	 * the task; callers (the tool) wrap this in best-effort error handling.
	 */
	public async atomicReadAndUpdateHistoryItem(
		taskId: string,
		updater: (current: HistoryItem) => HistoryItem,
	): Promise<HistoryItem> {
		const taskHistoryStore = await this.getTaskHistoryStore()
		return taskHistoryStore.atomicReadAndUpdate(taskId, updater, this.taskHistoryOrigin)
	}

	/**
	 * Adjust a memory-activity counter and push the change to the webview.
	 * `active: true` opens an activity window, `false` closes it. Counters,
	 * not booleans: recall prefetches and background writers can overlap.
	 */
	public setMemoryActivity(kind: "recall" | "write", active: boolean): void {
		this.memoryActivityCounts[kind] = Math.max(0, this.memoryActivityCounts[kind] + (active ? 1 : -1))
		this.postMessageToWebview({
			type: "memoryActivity",
			memoryActivity: { ...this.memoryActivityCounts },
		}).catch(() => {})
	}

	/**
	 * Resolve the API profile pinned to `mode` (the "use a specific
	 * configuration for this mode" binding — the same source handleModeSwitch
	 * applies to foreground tasks). Returns undefined — meaning "use the
	 * current profile" — when no binding exists, the profile is an empty CLI
	 * placeholder (no apiProvider), the workspace locks its API config across
	 * modes, or resolution fails for any reason.
	 */
	public async getApiConfigurationForMode(
		mode: string,
	): Promise<{ apiConfiguration: ProviderSettings; name: string } | undefined> {
		try {
			if (this.context.workspaceState.get("lockApiConfigAcrossModes", false)) {
				return undefined
			}
			const configId = await this.providerSettingsManager.getModeConfigId(mode)
			if (!configId) {
				return undefined
			}
			const persistedProfile = await this.providerSettingsManager.getProfile({ id: configId })
			if (!persistedProfile.name || !persistedProfile.apiProvider) {
				return undefined
			}
			const { name, ...profile } = await this.providerSettingsManager.activateProfile({ id: configId })
			return { apiConfiguration: profile, name }
		} catch (error) {
			this.log(
				`[getApiConfigurationForMode] failed for mode "${mode}": ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			return undefined
		}
	}

	/**
	 * Await a background task's terminal state. Resolves `{ completed: true,
	 * lastMessage }` on `TaskCompleted` (attempt_completion) or `{ completed:
	 * false, abortReason }` on `TaskAborted`. Removes the registry entry,
	 * disposes a completed task, and then deletes its on-disk directory
	 * (aborted tasks keep theirs for post-mortem). An optional `signal` aborts
	 * the task early.
	 *
	 * Claim 3: `abortReason` is propagated so callers can distinguish a genuine
	 * provider failure (`"streaming_failed"` — worth retrying on a different
	 * handler) from turn-budget exhaustion (`"max_turns_reached"` — a weak
	 * model that didn't finish; retrying on an expensive foreground model will
	 * just exhaust the same budget and double cost) from user cancellation
	 * (`"user_cancelled"` — never retry). Without this distinction the memory
	 * runner retried on foreground for EVERY non-completion, doubling cost
	 * exactly where the feature aimed to save it.
	 */
	public awaitTaskCompletion(
		task: Task,
		options: { signal?: AbortSignal } = {},
	): Promise<{
		completed: boolean
		lastMessage?: string
		writtenPaths: string[]
		abortReason?: string
	}> {
		return new Promise((resolve) => {
			let settled = false

			const onSignalAbort = () => {
				void task.abortTask().catch(() => {})
			}

			const finish = (result: { completed: boolean; lastMessage?: string; abortReason?: string }) => {
				if (settled) return
				settled = true
				task.off(RooCodeEventName.TaskCompleted, onCompleted)
				task.off(RooCodeEventName.TaskAborted, onAborted)
				options.signal?.removeEventListener("abort", onSignalAbort)
				// Capture the set of files the task wrote/edited BEFORE disposing it
				// (dispose tears down the tracker). Resolve to absolute paths.
				let writtenPaths: string[] = []
				try {
					writtenPaths = (task.fileContextTracker?.getAndClearCheckpointPossibleFile?.() ?? []).map((p) =>
						path.isAbsolute(p) ? p : path.resolve(task.cwd, p),
					)
				} catch {
					// Non-fatal: no written-path reporting for this run.
				}
				this.backgroundTasks.delete(task.taskId)
				// Dispose a completed background task (aborted ones are already torn
				// down). `isBackground` makes this abort skip the memory writers.
				// Completed background tasks have no history item and are never
				// resumed — delete their on-disk directory once the dispose settles
				// (abortTask saves messages, which would re-create the directory).
				// Aborted/failed tasks keep their directory for post-mortem. No
				// ShadowCheckpointService cleanup is needed (background tasks are
				// created with enableCheckpoints: false).
				if (result.completed) {
					void task
						.abortTask(true)
						.catch(() => {})
						.then(() => this.cleanupBackgroundTaskFiles(task.taskId))
				}
				resolve({ ...result, writtenPaths })
			}

			const onCompleted = () => {
				// Last completion_result say carries the attempt_completion text.
				const last = [...task.clineMessages]
					.reverse()
					.find((m) => m.type === "say" && m.say === "completion_result")
				finish({ completed: true, lastMessage: last?.text })
			}
			// Capture the abortReason at abort time so the caller can classify
			// the failure (Claim 3). task.abortReason is set by TaskApiLoop
			// before abortTask() fires TaskAborted.
			const onAborted = () => finish({ completed: false, abortReason: task.abortReason })

			task.on(RooCodeEventName.TaskCompleted, onCompleted)
			task.on(RooCodeEventName.TaskAborted, onAborted)

			if (options.signal) {
				if (options.signal.aborted) onSignalAbort()
				else options.signal.addEventListener("abort", onSignalAbort, { once: true })
			}
		})
	}

	/**
	 * Best-effort deletion of a completed background task's on-disk directory.
	 * Failure is logged and never thrown — the await result is already settled.
	 */
	private cleanupBackgroundTaskFiles(taskId: string): void {
		void (async () => {
			try {
				const { getTaskDirectoryPath } = await import("../../utils/storage")
				const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
				const dirPath = await getTaskDirectoryPath(globalStoragePath, taskId)
				await fs.rm(dirPath, { recursive: true, force: true })
				this.log(`[cleanupBackgroundTaskFiles] removed task directory for ${taskId}`)
			} catch (error) {
				this.log(
					`[cleanupBackgroundTaskFiles] failed to remove task directory for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		})()
	}

	/**
	 * Surface a non-blocking toast for background-task outcomes (memory writes).
	 */
	public notifyBackgroundOutcome(message: string): void {
		void vscode.window.showInformationMessage(message)
	}

	/**
	 * The memory background-writer runner (extraction + dream), consumed by
	 * `TaskLifecycle.triggerMemoryBackgroundWriters` via `provider.memorySubTaskRunner`.
	 *
	 * Spawns a headless, write-sandboxed background task (in "code" mode so the
	 * read/write tools are available) against the given cwd, runs it autonomously
	 * with a turn cap, and returns the memory files it wrote. This is the wiring
	 * that flips memory writes ON — replacing the historical `noopSubTaskRunner`
	 * fallback. The `autoApprovalOverride` (see {@link memoryWriteSandbox}) confines
	 * writes to the memory directory, and `silentWrites` keeps the writes off-screen.
	 */
	public get memorySubTaskRunner(): SubTaskRunner {
		return async ({ cwd, systemPrompt, userPrompt, maxTurns, signal }) => {
			// The real Task builds its own system prompt (which already includes the
			// memory behavioral section), so fold the extraction/dream system prompt
			// into the task's initial message alongside the user prompt.
			const text = systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt
			const backgroundConfig = await this.resolveMemoryWriterApiConfiguration()
			this.setMemoryActivity("write", true)
			try {
				const outcome = await this.runMemorySubTask(text, cwd, maxTurns, signal, backgroundConfig)
				if (outcome.completed) {
					return { writtenPaths: filterMemoryWrittenPaths(outcome.writtenPaths, cwd) }
				}
				// Claim 3: classify the abort reason before retrying. The old
				// code retried on foreground for EVERY non-completion (when a
				// background profile was set and the user hadn't cancelled) —
				// but a weak background model that exhausts its turn budget
				// (max_turns_reached, typical for memory extraction) looks
				// identical to "provider offline" at the boolean boundary, so
				// it triggered a full re-run on the expensive foreground model
				// every time, doubling cost exactly where savings were the goal.
				//
				// Retry on foreground ONLY for a genuine provider failure
				// (streaming_failed) — the background model may be offline. Do
				// NOT retry on:
				//  - max_turns_reached: the weak model didn't finish in budget;
				//    the foreground model will likely also need more turns and
				//    the retry doubles cost. Accept the partial result.
				//  - user_cancelled (signal.aborted): never retry a cancel.
				//  - undefined/other abort reasons: unknown, don't risk a loop.
				const shouldRetry = backgroundConfig && !signal?.aborted && outcome.abortReason === "streaming_failed"
				if (shouldRetry) {
					this.log(
						"[memorySubTaskRunner] background profile failed (streaming_failed), retrying on foreground",
					)
					const retry = await this.runMemorySubTask(text, cwd, maxTurns, signal, undefined)
					// Claim 6: return the UNION of attempt #1 and attempt #2
					// writtenPaths (filtered). The old code returned only
					// attempt #2's paths, discarding attempt #1's on-disk
					// writes — so onSaved/onImproved toasts never fired for
					// files the first attempt wrote. The extraction cursor
					// advances independently, so this is "only" a reporting
					// regression, but a conscious one the diff didn't
					// compensate for. Dedupe by path in case both attempts
					// wrote the same file.
					const unionPaths = [...new Set([...outcome.writtenPaths, ...retry.writtenPaths])]
					return { writtenPaths: filterMemoryWrittenPaths(unionPaths, cwd) }
				}
				// Non-retryable abort: still report attempt #1's written paths
				// (Claim 6) so toasts fire for files the attempt did write
				// before aborting. The old code returned [] here, dropping them.
				return { writtenPaths: filterMemoryWrittenPaths(outcome.writtenPaths, cwd) }
			} finally {
				this.setMemoryActivity("write", false)
			}
		}
	}

	/**
	 * Helper extracted from {@linkcode memorySubTaskRunner} for retry support.
	 * Spawns a single headless memory-writer sub-task with the given
	 * `apiConfiguration` (undefined ⇒ foreground profile) and awaits its
	 * completion. Returns the raw `{ completed, writtenPaths, abortReason }`
	 * outcome so the caller can decide whether to retry on the foreground
	 * profile (and only for genuine provider failures — see Claim 3).
	 */
	private async runMemorySubTask(
		text: string,
		cwd: string,
		maxTurns: number,
		signal: AbortSignal | undefined,
		apiConfiguration: ProviderSettings | undefined,
	): Promise<{ completed: boolean; writtenPaths: string[]; abortReason?: string }> {
		const task = await this.createBackgroundTask(text, {
			taskMode: "code",
			workspacePath: cwd,
			maxAgentTurns: maxTurns,
			autoApprovalOverride: memoryWriteSandbox(cwd),
			silentWrites: true,
			apiConfiguration,
		})
		const { completed, writtenPaths, abortReason } = await this.awaitTaskCompletion(task, { signal })
		return { completed, writtenPaths, abortReason }
	}

	/**
	 * Resolve the configured memory-writer API profile. Returns undefined when
	 * no profile is configured or the configured id is stale — callers fall
	 * back to the foreground profile. Never throws.
	 */
	private async resolveMemoryWriterApiConfiguration(): Promise<ProviderSettings | undefined> {
		const id = this.getValue("memoryWriterApiConfigId")
		if (!id) return undefined
		try {
			const { name: _name, ...profile } = await this.providerSettingsManager.activateProfile({ id })
			return profile
		} catch (error) {
			this.log(
				`[memorySubTaskRunner] failed to load writer profile ${id}, falling back to foreground: ${error instanceof Error ? error.message : String(error)}`,
			)
			return undefined
		}
	}

	public async cancelTask(): Promise<void> {
		const task = this.getCurrentTask()

		if (!task) {
			return
		}

		console.log(`[cancelTask] cancelling task ${task.taskId}.${task.instanceId}`)

		let historyItem: HistoryItem | undefined
		try {
			const history = await this.getTaskWithId(task.taskId)
			historyItem = history.historyItem
		} catch (error) {
			// During task startup there is a short window where currentTask exists
			// but task history has not been persisted yet. Cancelling should still
			// abort safely; we just skip post-cancel rehydration in that case.
			if (error instanceof Error && error.message === "Task not found") {
				this.log(`[cancelTask] task history missing for ${task.taskId}; skipping rehydrate`)
			} else {
				throw error
			}
		}

		// Preserve parent and root task information for history item.
		// `let` because a delegated-parent detach below may clear them.
		let rootTask = task.rootTask
		let parentTask = task.parentTask

		// Mark this as a user-initiated cancellation so provider-only rehydration can occur
		task.abortReason = "user_cancelled"

		// Capture the current instance to detect if rehydrate already occurred elsewhere
		const originalInstanceId = task.instanceId

		// Immediately cancel the underlying HTTP request if one is in progress
		// This ensures the stream fails quickly rather than waiting for network timeout
		// Pass destroyClient=true to sever all HTTP connections and force client recreation.
		// This is essential for local models that may continue inference even after abort.
		task.cancelCurrentRequest(true)

		// Begin abort (non-blocking) — the abort runs concurrently while we
		// do a bounded wait for streaming to stop.  We do NOT set `abandoned`
		// before the wait: setting it prematurely would mark the task as
		// abandoned while the abort is still progressing, which can clobber a
		// to-be-successful cleanup.  Instead `abandoned` is set AFTER the
		// bounded wait concludes, regardless of whether the abort finished.
		task.abortTask()

		await pWaitFor(
			() =>
				this.getCurrentTask()! === undefined ||
				this.getCurrentTask()!.isStreaming === false ||
				this.getCurrentTask()!.didFinishAbortingStream ||
				// If only the first chunk is processed, then there's no
				// need to wait for graceful abort (closes edits, browser,
				// etc).
				this.getCurrentTask()!.isWaitingForFirstChunk,
			{
				timeout: 3_000,
			},
		).catch(() => {
			// The abort is still in progress (e.g. slow stream cleanup,
			// memory-writer drain on a non-user-cancel path).  This is NOT
			// a failure — the abort was initiated and will complete in the
			// background.  We log a warning instead of an error so the
			// task is not spuriously marked as failed.
			this.log("[cancelTask] abort still in progress after 3s bound — continuing")
		})

		// Mark the original instance as abandoned NOW — after the bounded
		// wait, so it never clobbers a still-progressing abort.  The abort
		// itself was already started above; `abandoned` just prevents
		// residual activity from the old instance after rehydrate.
		task.abandoned = true

		// Defensive safeguard: if current instance already changed, skip rehydrate
		const current = this.getCurrentTask()
		if (current && current.instanceId !== originalInstanceId) {
			this.log(
				`[cancelTask] Skipping rehydrate: current instance ${current.instanceId} != original ${originalInstanceId}`,
			)
			return
		}

		// Final race check before rehydrate to avoid duplicate rehydration
		{
			const currentAfterCheck = this.getCurrentTask()
			if (currentAfterCheck && currentAfterCheck.instanceId !== originalInstanceId) {
				this.log(
					`[cancelTask] Skipping rehydrate after final check: current instance ${currentAfterCheck.instanceId} != original ${originalInstanceId}`,
				)
				return
			}
		}

		if (!historyItem) {
			return
		}

		// If this is a delegated subtask, detach its parent so the parent does not
		// stay stuck in "delegated" awaiting a child that the user just cancelled.
		if (task.parentTaskId) {
			try {
				const { historyItem: parentHistory } = await this.getTaskWithId(task.parentTaskId)

				if (parentHistory?.status === "delegated" && parentHistory?.awaitingChildId === task.taskId) {
					await this.updateTaskHistory({
						...parentHistory,
						status: "active",
						awaitingChildId: undefined,
					})

					this.log(
						`[cancelTask] Detached delegated parent ${task.parentTaskId}: delegated → active (child ${task.taskId} cancelled)`,
					)
					parentTask = undefined
					rootTask = undefined
					// Clear any stale fail-closed entry from a prior failed cancel attempt.
					this.cancelledDelegationChildIds.delete(task.taskId)
				}
			} catch (error) {
				// Fail closed: if we cannot prove the parent was detached, make the
				// rehydrated child standalone so later completions cannot reopen a
				// stale delegated parent, even after a provider reload.
				parentTask = undefined
				rootTask = undefined
				this.cancelledDelegationChildIds.add(task.taskId)
				historyItem = {
					...historyItem,
					parentTaskId: undefined,
					rootTaskId: undefined,
				}
				try {
					await this.updateTaskHistory(historyItem)
				} catch (historyError) {
					this.log(
						`[cancelTask] Failed to persist standalone child state for ${task.taskId}: ${
							historyError instanceof Error ? historyError.message : String(historyError)
						}`,
					)
					throw historyError
				}
				this.log(
					`[cancelTask] Failed to detach delegated parent for ${task.taskId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
			}
		}

		// Clears task again, so we need to abortTask manually above.
		await this.createTaskWithHistoryItem({ ...historyItem, rootTask, parentTask })
	}

	/**
	 * Single source of truth for resetting the parallel-subagent panel at a
	 * task boundary: clears the in-memory registry and broadcasts an empty
	 * `subagentsUpdated` so the webview panel renders nothing for the new
	 * task. Called from every entry point that begins a fresh foreground
	 * task (`createTask` for a user-initiated top-level task, `clearTask`,
	 * and `createTaskWithHistoryItem` for a rehydrated root). Mid-task
	 * re-fan-out continues to use `SubagentRegistry.beginFanOut`.
	 *
	 * The broadcast is best-effort: if the webview is not yet mounted the
	 * post is dropped silently, and the next `postStateToWebview` will carry
	 * the now-empty `subagents` slice via the state payload anyway.
	 */
	private async resetSubagentPanel(): Promise<void> {
		this.subagentRegistry.clearAll()
		// `clearAll` already posts; this second explicit post is belt-and-
		// suspenders in case a subclass overrides the registry's post hook,
		// and keeps the contract that this method always broadcasts `[]`.
		await this.postMessageToWebview({
			type: "subagentsUpdated",
			sourceTaskId: this.getCurrentTask()?.taskId,
			subagents: [],
		})
	}

	/**
	 * Rehydrate the parallel-subagent panel for a parent task being restored
	 * from history. Reads `parallelChildIds` from the parent's history item
	 * (the persisted parent→child relation written by `run_parallel_tasks`),
	 * loads the matching terminal summaries from the parent's sidecar
	 * (`tasks/<parentId>/subagents.json`), and registers them so the panel
	 * renders the historical fan-out.
	 *
	 * Graceful degradation: if `parallelChildIds` is absent (pre-fix history
	 * item) or the sidecar is missing/corrupt, the panel stays empty — the
	 * task is NOT marked corrupt and no error is thrown.
	 *
	 * Posts a single `subagentsUpdated` carrying the restored list (and the
	 * current task id as `sourceTaskId`). Called after the parent Task is on
	 * the stack so `getCurrentTask()` matches the parent we just restored.
	 */
	private async rehydrateSubagents(historyItem: HistoryItem): Promise<void> {
		const parallelChildIds = historyItem.parallelChildIds
		if (!parallelChildIds || parallelChildIds.length === 0) {
			// Pre-fix history item or a task that never fanned out — nothing
			// to restore. The panel was already cleared by
			// `resetSubagentPanel` at the top of the rehydrate path.
			return
		}
		try {
			const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
			const { loadSubagentSummaries } = await import("../task-persistence/subagentSummariesStore")
			const summaries = await loadSubagentSummaries(globalStoragePath, historyItem.id)
			// Only keep summaries whose taskId is in the persisted
			// parent→child list. The sidecar and `parallelChildIds` are
			// written together, but a partially-written sidecar from a
			// crashed run could carry stale entries; this guard keeps the
			// panel honest.
			const allowed = new Set(parallelChildIds)
			const restored = summaries.filter((s) => allowed.has(s.taskId))
			this.subagentRegistry.restore(historyItem.id, restored)
			await this.postMessageToWebview({
				type: "subagentsUpdated",
				sourceTaskId: this.getCurrentTask()?.taskId,
				subagents: this.subagentRegistry.list(),
			})
		} catch (error) {
			// Sidecar loading is best-effort. A missing/corrupt sidecar must
			// never break rehydration of the parent task itself.
			this.log(
				`[rehydrateSubagents] Failed to restore subagents for task ${historyItem.id} (non-fatal): ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	// Clear the current task without treating it as a subtask.
	// This is used when the user cancels a task that is not a subtask.
	public async clearTask(): Promise<void> {
		// Reset the subagent panel before popping the stack so the broadcast
		// still carries the about-to-be-cleared task's id as `sourceTaskId`
		// (the webview scopes by currentTaskId; after the pop there is no
		// current task and the post would be dropped by the scope guard).
		await this.resetSubagentPanel()
		if (this.clineStack.length > 0) {
			const task = this.clineStack[this.clineStack.length - 1]
			console.log(`[clearTask] clearing task ${task.taskId}.${task.instanceId}`)
			await this.removeClineFromStack()
		}
	}

	public resumeTask(taskId: string): void {
		// Use the existing showTaskWithId method which handles both current and
		// historical tasks.
		this.showTaskWithId(taskId).catch((error) => {
			this.log(`Failed to resume task ${taskId}: ${error.message}`)
		})
	}

	// Modes

	public async getModes(): Promise<{ slug: string; name: string }[]> {
		try {
			const customModes = await this.customModesManager.getCustomModes()
			return [...DEFAULT_MODES, ...customModes].map(({ slug, name }) => ({ slug, name }))
		} catch (error) {
			return DEFAULT_MODES.map(({ slug, name }) => ({ slug, name }))
		}
	}

	public async getMode(): Promise<string> {
		const { mode } = await this.getState()
		return mode
	}

	public async setMode(mode: string): Promise<void> {
		await this.setValues({ mode })
	}

	// Provider Profiles

	public async getProviderProfiles(): Promise<{ name: string; provider?: string }[]> {
		const { listApiConfigMeta = [] } = await this.getState()
		return listApiConfigMeta.map((profile) => ({ name: profile.name, provider: profile.apiProvider }))
	}

	public async getProviderProfile(): Promise<string> {
		const { currentApiConfigName = "default" } = await this.getState()
		return currentApiConfigName
	}

	public async setProviderProfile(name: string): Promise<void> {
		await this.activateProviderProfile({ name })
	}

	// Telemetry

	private _appProperties?: StaticAppProperties
	private _gitProperties?: GitProperties

	private getAppProperties(): StaticAppProperties {
		if (!this._appProperties) {
			const packageJSON = this.context.extension?.packageJSON

			this._appProperties = {
				appName: packageJSON?.name ?? Package.name,
				appVersion: packageJSON?.version ?? Package.version,
				vscodeVersion: vscode.version,
				platform: process.platform,
				editorName: vscode.env.appName,
			}
		}

		return this._appProperties
	}

	public get appProperties(): StaticAppProperties {
		return this._appProperties ?? this.getAppProperties()
	}

	private getCloudProperties(): CloudAppProperties {
		let cloudIsAuthenticated: boolean | undefined

		try {
			if (CloudService.hasInstance()) {
				cloudIsAuthenticated = CloudService.instance.isAuthenticated()
			}
		} catch (error) {
			// Silently handle errors to avoid breaking telemetry collection.
			this.log(`[getTelemetryProperties] Failed to get cloud auth state: ${error}`)
		}

		return {
			cloudIsAuthenticated,
		}
	}

	private async getTaskProperties(): Promise<DynamicAppProperties & TaskProperties> {
		const { language = "en", mode, apiConfiguration } = await this.getState()

		const task = this.getCurrentTask()
		const todoList = task?.todoList
		let todos: { total: number; completed: number; inProgress: number; pending: number } | undefined

		if (todoList && todoList.length > 0) {
			todos = {
				total: todoList.length,
				completed: todoList.filter((todo) => todo.status === "completed").length,
				inProgress: todoList.filter((todo) => todo.status === "in_progress").length,
				pending: todoList.filter((todo) => todo.status === "pending").length,
			}
		}

		const apiProvider = apiConfiguration?.apiProvider

		return {
			language,
			mode,
			taskId: task?.taskId,
			parentTaskId: task?.parentTaskId,
			apiProvider: apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
			modelId: task?.api?.getModel().id,
			diffStrategy: task?.diffStrategy?.getName(),
			isSubtask: task ? !!task.parentTaskId : undefined,
			...(todos && { todos }),
		}
	}

	private async getGitProperties(): Promise<GitProperties> {
		if (!this._gitProperties) {
			this._gitProperties = await getWorkspaceGitInfo()
		}

		return this._gitProperties
	}

	public get gitProperties(): GitProperties | undefined {
		return this._gitProperties
	}

	public async getTelemetryProperties(): Promise<TelemetryProperties> {
		return {
			...this.getAppProperties(),
			...this.getCloudProperties(),
			...(await this.getTaskProperties()),
			...(await this.getGitProperties()),
		}
	}

	public get cwd() {
		return this.currentWorkspacePath || getWorkspacePath()
	}

	/**
	 * Worktree root sent with backfill uploads so the cloud web view can attribute
	 * an offline task to its project. Implements TelemetryPropertiesProvider; kept
	 * out of the per-event telemetry properties to avoid leaking an absolute path
	 * into every event.
	 */
	public getTelemetryWorkspacePath(): string | undefined {
		return this.cwd || undefined
	}

	/**
	 * Delegate parent task and open child task.
	 *
	 * - Enforce single-open invariant
	 * - Persist parent delegation metadata
	 * - Emit TaskDelegated (task-level; API forwards to provider/bridge)
	 * - Create child as sole active and switch mode to child's mode
	 */
	public async delegateParentAndOpenChild(params: {
		parentTaskId: string
		message: string
		initialTodos: TodoItem[]
		mode: string
	}): Promise<Task> {
		const { parentTaskId, message, initialTodos, mode } = params

		// Metadata-driven delegation is always enabled

		// 1) Get parent (must be current task)
		const parent = this.getCurrentTask()
		if (!parent) {
			throw new Error("[delegateParentAndOpenChild] No current task")
		}
		if (parent.taskId !== parentTaskId) {
			throw new Error(
				`[delegateParentAndOpenChild] Parent mismatch: expected ${parentTaskId}, current ${parent.taskId}`,
			)
		}
		// 2) Flush pending tool results to API history BEFORE disposing the parent.
		//    This is critical: when tools are called before new_task,
		//    their tool_result blocks are in userMessageContent but not yet saved to API history.
		//    If we don't flush them, the parent's API conversation will be incomplete and
		//    cause 400 errors when resumed (missing tool_result for tool_use blocks).
		//
		//    NOTE: We do NOT pass the assistant message here because the assistant message
		//    is already added to apiConversationHistory by the normal flow in
		//    recursivelyMakeClineRequests BEFORE tools start executing. We only need to
		//    flush the pending user message with tool_results.
		try {
			const flushSuccess = await parent.flushPendingToolResultsToHistory()

			if (!flushSuccess) {
				console.warn(`[delegateParentAndOpenChild] Flush failed for parent ${parentTaskId}, retrying...`)
				const retrySuccess = await parent.retrySaveApiConversationHistory()

				if (!retrySuccess) {
					console.error(
						`[delegateParentAndOpenChild] CRITICAL: Parent ${parentTaskId} API history not persisted to disk. Child return may produce stale state.`,
					)
					vscode.window.showWarningMessage(
						"Warning: Parent task state could not be saved. The parent task may lose recent context when resumed.",
					)
				}
			}
		} catch (error) {
			this.log(
				`[delegateParentAndOpenChild] Error flushing pending tool results (non-fatal): ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}

		// 3) Enforce single-open invariant by closing/disposing the parent first
		//    This ensures we never have >1 tasks open at any time during delegation.
		//    Await abort completion to ensure clean disposal and prevent unhandled rejections.
		try {
			await this.removeClineFromStack({ skipDelegationRepair: true })
		} catch (error) {
			this.log(
				`[delegateParentAndOpenChild] Error during parent disposal (non-fatal): ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			// Non-fatal: proceed with child creation even if parent cleanup had issues
		}

		// 3) Switch provider mode to child's requested mode BEFORE creating the child task
		//    This ensures the child's system prompt and configuration are based on the correct mode.
		//    The mode switch must happen before createTask() because the Task constructor
		//    initializes its mode from provider.getState() during initializeTaskMode().
		try {
			await this.handleModeSwitch(mode as any)
		} catch (e) {
			this.log(
				`[delegateParentAndOpenChild] handleModeSwitch failed for mode '${mode}': ${
					(e as Error)?.message ?? String(e)
				}`,
			)
		}

		// 4) Create child as sole active (parent reference preserved for lineage)
		// Pass initialStatus: "active" to ensure the child task's historyItem is created
		// with status from the start, avoiding race conditions where the task might
		// call attempt_completion before status is persisted separately.
		//
		// Pass startTask: false to prevent the child from beginning its task loop
		// (and persisting its own history_item.json via saveClineMessages →
		// updateTaskHistory) before we persist the parent's delegation
		// metadata in step 5. Without this, the child's fire-and-forget
		// startTask() races with step 5's atomicReadAndUpdate, and the last
		// writer to the parent's history_item.json overwrites the other's
		// changes — causing the parent's delegation fields to be lost.
		const child = await this.createTask(message, undefined, parent as any, {
			initialTodos,
			initialStatus: "active",
			startTask: false,
		})

		// 5) Persist parent delegation metadata BEFORE the child starts writing.
		//    atomicReadAndUpdate reads from the in-memory cache and writes back within a
		//    single lock acquisition — no concurrent writer can slip between the read and
		//    write, and the pure updater cannot re-enter the lock (no deadlock).
		//    Broadcast and cache invalidation happen outside the lock after it releases.
		try {
			// Mark self-originated so the shared store's onChange echo
			// (external:false) is suppressed for us — we send our own
			// targeted message below. Other providers sharing the store
			// still receive the echo and push their own targeted update.
			const taskHistoryStore = await this.getTaskHistoryStore()
			await taskHistoryStore.atomicReadAndUpdate(
				parentTaskId,
				(historyItem) => {
					const childIds = Array.from(new Set([...(historyItem.childIds ?? []), child.taskId]))
					return {
						...historyItem,
						status: "delegated",
						delegatedToId: child.taskId,
						awaitingChildId: child.taskId,
						childIds,
					}
				},
				this.taskHistoryOrigin,
			)
			this.recentTasksCache = undefined
			if (this.isViewLaunched) {
				const updatedItem = taskHistoryStore.get(parentTaskId)
				if (updatedItem) {
					await this.postMessageToWebview({ type: "taskHistoryItemUpdated", taskHistoryItem: updatedItem })
				}
			}
		} catch (err) {
			this.log(
				`[delegateParentAndOpenChild] Failed to persist parent metadata for ${parentTaskId} -> ${child.taskId}: ${
					(err as Error)?.message ?? String(err)
				}`,
			)
		}

		// 6) Start the child task now that parent metadata is safely persisted.
		child.start()

		// 7) Emit TaskDelegated (provider-level)
		try {
			this.emit(RooCodeEventName.TaskDelegated, parentTaskId, child.taskId)
		} catch {
			// non-fatal
		}

		return child
	}

	/**
	 * Attempt to re-attach a detached parent when its cancelled/resumed child later completes.
	 *
	 * Both `cancelTask` and `removeClineFromStack` deliberately detach the parent
	 * (status → "active", awaitingChildId → undefined) so the parent is not stuck
	 * waiting for a dead child. But if the child is later resumed and completes,
	 * nothing re-establishes delegation — so the child falls through to standalone
	 * completion instead of returning its result to the parent.
	 *
	 * This method re-stamps the parent `{status: "delegated", awaitingChildId: childTaskId}`
	 * ONLY when ALL five evidence conditions hold (see ai_plans/2026-07-12_delegated-child-return-after-cancel.md):
	 *   1. parentHistory.status === "active" (not completed; not already delegated to someone else);
	 *   2. parentHistory.awaitingChildId === undefined (no live delegation);
	 *   3. parentHistory.delegatedToId === childTaskId (the parent's LAST delegation was to THIS child);
	 *   4. parent is not currently open in the task stack (user is not actively working in it);
	 *   5. untouched-tail proof: the parent's persisted API messages still end frozen at the
	 *      delegation — the last `new_task` tool_use has NO tool_result answering it in any
	 *      later message (same backward scan as reopenParentFromDelegation).
	 *
	 * Returns true on successful re-attach, false otherwise (never throws).
	 */
	public async tryReattachDelegatedParent(parentTaskId: string, childTaskId: string): Promise<boolean> {
		try {
			// 1-3: Load parent history and check the three metadata conditions.
			const { historyItem: parentHistory } = await this.getTaskWithId(parentTaskId)

			if (parentHistory.status !== "active") {
				this.log(
					`[tryReattachDelegatedParent] Rejecting: parent ${parentTaskId} status is "${parentHistory.status}", not "active"`,
				)
				return false
			}

			if (parentHistory.awaitingChildId !== undefined) {
				this.log(
					`[tryReattachDelegatedParent] Rejecting: parent ${parentTaskId} already has awaitingChildId="${parentHistory.awaitingChildId}"`,
				)
				return false
			}

			if (parentHistory.delegatedToId !== childTaskId) {
				this.log(
					`[tryReattachDelegatedParent] Rejecting: parent ${parentTaskId} delegatedToId="${parentHistory.delegatedToId}" !== child "${childTaskId}"`,
				)
				return false
			}

			// 4: Parent must not be currently open in the task stack.
			const stackIds = this.getCurrentTaskStack()
			if (stackIds.includes(parentTaskId)) {
				this.log(
					`[tryReattachDelegatedParent] Rejecting: parent ${parentTaskId} is currently open in the task stack [${stackIds.join(", ")}]`,
				)
				return false
			}

			// 5: Untouched-tail proof — read the parent's persisted API messages and scan
			//    backward for the last `new_task` tool_use, then verify NO later message
			//    contains a `tool_result` with that tool_use_id.
			let parentApiMessages: any[] = []
			try {
				parentApiMessages = (await readApiMessages({
					taskId: parentTaskId,
					globalStoragePath: this.contextProxy.globalStorageUri.fsPath,
				})) as any[]
			} catch (readErr) {
				this.log(
					`[tryReattachDelegatedParent] Rejecting: failed to read parent API messages for ${parentTaskId}: ${
						readErr instanceof Error ? readErr.message : String(readErr)
					}`,
				)
				return false
			}

			if (!Array.isArray(parentApiMessages)) {
				this.log(`[tryReattachDelegatedParent] Rejecting: parent ${parentTaskId} API messages is not an array`)
				return false
			}

			// Same backward scan as reopenParentFromDelegation (~line 3827-3837).
			let toolUseId: string | undefined
			let toolUseIndex = -1
			for (let i = parentApiMessages.length - 1; i >= 0; i--) {
				const msg = parentApiMessages[i]
				if (msg.role === "assistant" && Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "tool_use" && block.name === "new_task") {
							toolUseId = block.id
							toolUseIndex = i
							break
						}
					}
					if (toolUseId) break
				}
			}

			if (!toolUseId) {
				this.log(
					`[tryReattachDelegatedParent] Rejecting: no new_task tool_use found in parent ${parentTaskId} API history (cannot prove frozen state)`,
				)
				return false
			}

			// Scan ALL messages AFTER the tool_use for a matching tool_result.
			for (let i = toolUseIndex; i < parentApiMessages.length; i++) {
				const msg = parentApiMessages[i]
				if (msg.role === "user" && Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
							this.log(
								`[tryReattachDelegatedParent] Rejecting: parent ${parentTaskId} already has a tool_result for new_task tool_use_id="${toolUseId}" (parent was resumed)`,
							)
							return false
						}
					}
				}
			}

			// All five conditions hold — re-attach.
			await this.updateTaskHistory({
				...parentHistory,
				status: "delegated",
				awaitingChildId: childTaskId,
			})

			this.log(
				`[tryReattachDelegatedParent] Re-attached parent ${parentTaskId} to child ${childTaskId} (status: active → delegated, awaitingChildId: undefined → ${childTaskId})`,
			)
			return true
		} catch (err) {
			this.log(
				`[tryReattachDelegatedParent] Error re-attaching parent ${parentTaskId} to child ${childTaskId}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			)
			return false
		}
	}

	/**
	 * Reopen parent task from delegation with write-back and events.
	 */
	public async reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
	}): Promise<boolean> {
		const { parentTaskId, childTaskId, completionResultSummary } = params
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath

		// 1) Load parent from history and current persisted messages
		const { historyItem } = await this.getTaskWithId(parentTaskId)

		// Guard: re-validate delegation state after the async approval gap.
		// cancelTask() or removeClineFromStack() may have already detached the parent
		// (status → "active", awaitingChildId → undefined) while the user was
		// approving the subtask finish. Routing output back now would corrupt an
		// unrelated task.
		//
		// `awaitingChildId` is the authoritative signal and must still point at this child;
		// a genuine detach clears it. We intentionally do NOT require status === "delegated"
		// (and instead only reject status === "completed"): a late background usage-drain save
		// on the disposed parent can clobber status "delegated" → "active" while preserving
		// awaitingChildId. This mirrors the AttemptCompletionTool gate so delegateToParent does
		// not get a false `didReopen === false`. See ai_plans/2026-06-08_delegated-subtask-no-return.md.
		if (
			this.cancelledDelegationChildIds.has(childTaskId) ||
			historyItem.awaitingChildId !== childTaskId ||
			historyItem.status === "completed"
		) {
			this.log(
				`[reopenParentFromDelegation] Aborting: parent ${parentTaskId} is no longer delegated to child ${childTaskId} ` +
					`(status=${historyItem.status}, awaitingChildId=${historyItem.awaitingChildId})`,
			)
			return false
		}

		let parentClineMessages: ClineMessage[] = []
		try {
			parentClineMessages = await readTaskMessages({
				taskId: parentTaskId,
				globalStoragePath,
			})
		} catch {
			parentClineMessages = []
		}

		let parentApiMessages: any[] = []
		try {
			parentApiMessages = (await readApiMessages({
				taskId: parentTaskId,
				globalStoragePath,
			})) as any[]
		} catch {
			parentApiMessages = []
		}

		// 2) Inject synthetic records: UI subtask_result and update API tool_result
		const ts = Date.now()

		// Defensive: ensure arrays
		if (!Array.isArray(parentClineMessages)) parentClineMessages = []
		if (!Array.isArray(parentApiMessages)) parentApiMessages = []

		const subtaskUiMessage: ClineMessage = {
			type: "say",
			say: "subtask_result",
			text: completionResultSummary,
			ts,
		}
		const lastParentClineMessage = parentClineMessages.at(-1)
		if (
			lastParentClineMessage?.type !== "say" ||
			lastParentClineMessage.say !== "subtask_result" ||
			lastParentClineMessage.text !== completionResultSummary
		) {
			parentClineMessages.push(subtaskUiMessage)
		}
		await saveTaskMessages({ messages: parentClineMessages, taskId: parentTaskId, globalStoragePath })

		// Find the tool_use_id from the last assistant message's new_task tool_use
		let toolUseId: string | undefined
		for (let i = parentApiMessages.length - 1; i >= 0; i--) {
			const msg = parentApiMessages[i]
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "tool_use" && block.name === "new_task") {
						toolUseId = block.id
						break
					}
				}
				if (toolUseId) break
			}
		}

		// Preferred: if the parent history contains the native tool_use for new_task,
		// inject a matching tool_result for the Anthropic message contract:
		// user → assistant (tool_use) → user (tool_result)
		if (toolUseId) {
			// Check if the last message is already a user message with a tool_result for this tool_use_id
			// (in case this is a retry or the history was already updated)
			const lastMsg = parentApiMessages[parentApiMessages.length - 1]
			let alreadyHasToolResult = false
			if (lastMsg?.role === "user" && Array.isArray(lastMsg.content)) {
				for (const block of lastMsg.content) {
					if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
						// Update the existing tool_result content
						block.content = `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`
						alreadyHasToolResult = true
						break
					}
				}
			}

			// If no existing tool_result found, create a NEW user message with the tool_result
			if (!alreadyHasToolResult) {
				parentApiMessages.push({
					role: "user",
					content: [
						{
							type: "tool_result" as const,
							tool_use_id: toolUseId,
							content: `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`,
						},
					],
					ts,
				})
			}

			// Validate the newly injected tool_result against the preceding assistant message.
			// This ensures the tool_result's tool_use_id matches a tool_use in the immediately
			// preceding assistant message (Anthropic API requirement).
			const lastMessage = parentApiMessages[parentApiMessages.length - 1]
			if (lastMessage?.role === "user") {
				const validatedMessage = validateAndFixToolResultIds(lastMessage, parentApiMessages.slice(0, -1))
				parentApiMessages[parentApiMessages.length - 1] = validatedMessage
			}
		} else {
			// If there is no corresponding tool_use in the parent API history, we cannot emit a
			// tool_result. Fall back to a plain user text note so the parent can still resume.
			const fallbackText = `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`
			const lastParentApiMessage = parentApiMessages.at(-1)
			const alreadyHasFallback =
				lastParentApiMessage?.role === "user" &&
				Array.isArray(lastParentApiMessage.content) &&
				lastParentApiMessage.content.some(
					(block: { type?: string; text?: string }) => block.type === "text" && block.text === fallbackText,
				)
			if (!alreadyHasFallback) {
				parentApiMessages.push({
					role: "user",
					content: [
						{
							type: "text" as const,
							text: fallbackText,
						},
					],
					ts,
				})
			}
		}

		await saveApiMessages({ messages: parentApiMessages as any, taskId: parentTaskId, globalStoragePath })

		// 3) Close child instance if still open (single-open-task invariant).
		//    This MUST happen BEFORE updating the child's status to "completed" because
		//    removeClineFromStack() → abortTask(true) → saveClineMessages() writes
		//    the historyItem with initialStatus (typically "active"), which would
		//    overwrite a "completed" status set earlier.
		const current = this.getCurrentTask()
		if (current?.taskId === childTaskId) {
			// This method explicitly persists the parent's active state below, so the
			// generic delegated→active repair in removeClineFromStack would be redundant.
			await this.removeClineFromStack({ skipDelegationRepair: true })
		}

		// 4) Update child metadata to "completed" status.
		//    This runs after the abort so it overwrites the stale "active" status
		//    that saveClineMessages() may have written during step 3.
		try {
			const { historyItem: childHistory } = await this.getTaskWithId(childTaskId)
			await this.updateTaskHistory({
				...childHistory,
				status: "completed",
			})
		} catch (err) {
			this.log(
				`[reopenParentFromDelegation] Failed to persist child completed status for ${childTaskId}: ${
					(err as Error)?.message ?? String(err)
				}`,
			)
		}

		// 5) Update parent metadata and persist BEFORE emitting completion event
		const childIds = Array.from(new Set([...(historyItem.childIds ?? []), childTaskId]))
		const updatedHistory: typeof historyItem = {
			...historyItem,
			status: "active",
			completedByChildId: childTaskId,
			completionResultSummary,
			awaitingChildId: undefined,
			childIds,
		}
		await this.updateTaskHistory(updatedHistory)

		// 6) Emit TaskDelegationCompleted (provider-level)
		try {
			this.emit(RooCodeEventName.TaskDelegationCompleted, parentTaskId, childTaskId, completionResultSummary)
		} catch {
			// non-fatal
		}

		// 7) Reopen the parent from history as the sole active task (restores saved mode)
		//    IMPORTANT: startTask=false to suppress resume-from-history ask scheduling
		const parentInstance = await this.createTaskWithHistoryItem(updatedHistory, { startTask: false })

		// 8) Inject restored histories into the in-memory instance before resuming
		if (parentInstance) {
			try {
				await parentInstance.overwriteClineMessages(parentClineMessages)
			} catch {
				// non-fatal
			}
			try {
				await parentInstance.overwriteApiConversationHistory(parentApiMessages as any)
			} catch {
				// non-fatal
			}

			// Auto-resume parent without ask("resume_task")
			await parentInstance.resumeAfterDelegation()
		}

		// 9) Emit TaskDelegationResumed (provider-level)
		try {
			this.emit(RooCodeEventName.TaskDelegationResumed, parentTaskId, childTaskId)
		} catch {
			// non-fatal
		}

		this.cancelledDelegationChildIds.delete(childTaskId)
		return true
	}

	/**
	 * Convert a file path to a webview-accessible URI
	 * This method safely converts file paths to URIs that can be loaded in the webview
	 *
	 * @param filePath - The absolute file path to convert
	 * @returns The webview URI string, or the original file URI if conversion fails
	 * @throws {Error} When webview is not available
	 * @throws {TypeError} When file path is invalid
	 */
	public convertToWebviewUri(filePath: string): string {
		try {
			const fileUri = vscode.Uri.file(filePath)

			// Check if we have a webview available
			if (this.view?.webview) {
				const webviewUri = this.view.webview.asWebviewUri(fileUri)
				return webviewUri.toString()
			}

			// Specific error for no webview available
			const error = new Error("No webview available for URI conversion")
			console.error(error.message)
			// Fallback to file URI if no webview available
			return fileUri.toString()
		} catch (error) {
			// More specific error handling
			if (error instanceof TypeError) {
				console.error("Invalid file path provided for URI conversion:", error)
			} else {
				console.error("Failed to convert to webview URI:", error)
			}
			// Return file URI as fallback
			return vscode.Uri.file(filePath).toString()
		}
	}
}
