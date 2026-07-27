import type { ExtensionMessage, SubagentStatus, SubagentSummary } from "@roo-code/types"

/** Cap on the terminal-state message carried in a summary (transport size). */
const FINAL_MESSAGE_MAX_CHARS = 4000

const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> = new Set(["completed", "failed", "cancelled"])

/**
 * Deterministic placeholder id for a subtask registered at fan-out time,
 * before its child Task exists (queued behind the concurrency limit or still
 * creating its worktree). Replaced by the real taskId via {@link
 * SubagentRegistry.register}.
 */
export function queuedSubagentId(parentTaskId: string, index: number): string {
	return `queued:${parentTaskId}:${index}`
}

/**
 * In-memory registry of parallel background subagents (`run_parallel_tasks`
 * children), the source of truth for the webview subagents panel.
 *
 * Holds one lightweight {@link SubagentSummary} per subtask of the most recent
 * fan-out per parent, plus the set of subagents whose live message tail the
 * webview is currently subscribed to. Every mutation pushes the full summary
 * list to the webview (`subagentsUpdated`) — the list is small (fan-outs are
 * a handful of subtasks) and full pushes keep the webview merge trivial.
 *
 * `subagentsUpdated` carries a `sourceTaskId` equal to the foreground task
 * that owns the registry at post time. The webview scopes by
 * `currentTaskId`: a late terminal update from a just-abandoned task cannot
 * pollute the new task's panel even if the registry has not been cleared yet.
 *
 * Memory-writer background tasks never register here, so they stay invisible.
 */
export class SubagentRegistry {
	private summaries = new Map<string, SubagentSummary>()
	private watched = new Set<string>()

	/**
	 * @param post Broadcast an extension message to the webview.
	 * @param currentTaskIdProvider Returns the current foreground task id at
	 *   post time (may be `undefined` during startup). Stamped onto
	 *   `subagentsUpdated` as `sourceTaskId` so the webview can scope updates
	 *   by `currentTaskId` (defense-in-depth: late terminal updates from a
	 *   just-abandoned parent are dropped before reaching the panel).
	 */
	constructor(
		private readonly post: (message: ExtensionMessage) => void,
		private readonly currentTaskIdProvider: () => string | undefined = () => undefined,
	) {}

	/**
	 * Snapshot of every currently-registered summary, in panel order. The
	 * returned array is a deep-enough copy (each entry is a fresh object
	 * spread) so a caller persisting it cannot be racing with a later
	 * mutation that swaps fields in place. Used by `run_parallel_tasks` to
	 * write the sidecar after the fan-out settles.
	 */
	snapshot(): SubagentSummary[] {
		return this.list().map((summary) => ({ ...summary }))
	}

	/**
	 * Start a new fan-out for `parentTaskId`: drop the previous fan-out's
	 * entries (and their watch flags) so the panel only ever shows the live
	 * generation.
	 */
	beginFanOut(parentTaskId: string): void {
		let changed = false
		for (const [taskId, summary] of this.summaries) {
			if (summary.parentTaskId === parentTaskId) {
				this.summaries.delete(taskId)
				this.watched.delete(taskId)
				changed = true
			}
		}
		if (changed) {
			this.postUpdate()
		}
	}

	/**
	 * Reset the registry entirely and broadcast an empty panel. Called by
	 * `ClineProvider` at every entry point that begins a fresh foreground
	 * task (new task, clearTask, rehydrate from history) so subagents from a
	 * previous task never leak into the new one.
	 *
	 * Unlike {@link beginFanOut} (which scopes to one parent and preserves
	 * detached fan-outs still running for other parents), this drops every
	 * entry. It is the right call only at task boundaries where the previous
	 * foreground task is gone; mid-task re-fan-out continues to use
	 * `beginFanOut`.
	 */
	clearAll(): void {
		if (this.summaries.size === 0 && this.watched.size === 0) {
			return
		}
		this.summaries.clear()
		this.watched.clear()
		this.postUpdate()
	}

	/**
	 * Re-populate the registry from persisted summaries (rehydration from
	 * history). Existing entries for the same parent are dropped first so
	 * rehydrating the same task idempotently replaces rather than duplicates.
	 * Entries are inserted as-is (status already terminal); the panel renders
	 * them like a finished fan-out. Does NOT broadcast — the caller is
	 * responsible for posting the matching `subagentsUpdated` after the
	 * parent task is on the stack, so the webview's `currentTaskId` is set
	 * before the message arrives.
	 */
	restore(parentTaskId: string, summaries: SubagentSummary[]): void {
		// Drop any live or stale entries for this parent first (idempotent
		// re-rehydrate of the same task should not double the panel).
		for (const [taskId, summary] of this.summaries) {
			if (summary.parentTaskId === parentTaskId) {
				this.summaries.delete(taskId)
				this.watched.delete(taskId)
			}
		}
		for (const summary of summaries) {
			// Only restore entries that actually belong to this parent; the
			// sidecar is written by us and should never mix parents, but the
			// guard is cheap and keeps a corrupt sidecar from polluting the
			// panel with rows from another task.
			if (summary.parentTaskId === parentTaskId) {
				this.summaries.set(summary.taskId, { ...summary })
			}
		}
	}

	/** Alias with intent: a parent task is gone — remove its fan-out entries. */
	clearForParent(parentTaskId: string): void {
		this.beginFanOut(parentTaskId)
	}

	/**
	 * Register a queued placeholder for subtask `index` before its child Task
	 * exists. No-op if an entry with that placeholder id is already present.
	 */
	registerQueued(summary: Omit<SubagentSummary, "taskId" | "status">): void {
		const taskId = queuedSubagentId(summary.parentTaskId, summary.index)
		if (this.summaries.has(taskId)) {
			return
		}
		this.summaries.set(taskId, { ...summary, taskId, status: "queued" })
		this.postUpdate()
	}

	/**
	 * Register a live subagent. Replaces the queued placeholder for the same
	 * (parent, index) slot, carrying a watch flag over so a tail opened on the
	 * placeholder keeps streaming once the child starts.
	 */
	register(summary: SubagentSummary): void {
		const placeholderId = queuedSubagentId(summary.parentTaskId, summary.index)
		if (this.summaries.delete(placeholderId) && this.watched.delete(placeholderId)) {
			this.watched.add(summary.taskId)
		}
		this.summaries.set(summary.taskId, summary)
		this.postUpdate()
	}

	/** Merge `patch` into an existing summary; unknown ids are ignored. */
	update(taskId: string, patch: Partial<Omit<SubagentSummary, "taskId">>): void {
		const existing = this.summaries.get(taskId)
		if (!existing) {
			return
		}
		this.summaries.set(taskId, { ...existing, ...patch, taskId, lastActivityAt: Date.now() })
		this.postUpdate()
	}

	/**
	 * Non-terminal status transition ("running" ⇄ "awaiting_input"). Ignored
	 * once the subagent is terminal — late TaskActive/TaskInteractive events
	 * from a torn-down child must not resurrect it.
	 */
	setLiveStatus(taskId: string, status: Extract<SubagentStatus, "running" | "awaiting_input">): void {
		const existing = this.summaries.get(taskId)
		if (!existing || TERMINAL_STATUSES.has(existing.status)) {
			return
		}
		if (existing.status !== status) {
			this.update(taskId, { status })
		}
	}

	/**
	 * Terminal transition. First terminal status wins — with one refinement:
	 * a generic "failed" (from the TaskAborted listener) may be upgraded to
	 * "cancelled" when the fan-out later learns the abort was a cancellation.
	 * A `finalMessage` fills in whenever the slot is still empty.
	 */
	markTerminal(
		taskId: string,
		status: Extract<SubagentStatus, "completed" | "failed" | "cancelled">,
		finalMessage?: string,
	): void {
		const existing = this.summaries.get(taskId)
		if (!existing) {
			return
		}
		const truncated =
			finalMessage && finalMessage.length > FINAL_MESSAGE_MAX_CHARS
				? `${finalMessage.slice(0, FINAL_MESSAGE_MAX_CHARS)}…`
				: finalMessage
		if (TERMINAL_STATUSES.has(existing.status)) {
			const refinesToCancelled = existing.status === "failed" && status === "cancelled"
			const fillsFinalMessage = !existing.finalMessage && truncated
			if (refinesToCancelled || fillsFinalMessage) {
				this.update(taskId, {
					status: refinesToCancelled ? status : existing.status,
					finalMessage: existing.finalMessage ?? truncated,
				})
			}
			return
		}
		this.update(taskId, { status, finalMessage: truncated ?? existing.finalMessage })
	}

	get(taskId: string): SubagentSummary | undefined {
		return this.summaries.get(taskId)
	}

	has(taskId: string): boolean {
		return this.summaries.has(taskId)
	}

	/** Panel ordering: fan-out registration order (parent, then index). */
	list(): SubagentSummary[] {
		return [...this.summaries.values()].sort(
			(a, b) => a.parentTaskId.localeCompare(b.parentTaskId) || a.index - b.index,
		)
	}

	watch(taskId: string): void {
		this.watched.add(taskId)
	}

	unwatch(taskId: string): void {
		this.watched.delete(taskId)
	}

	/** Consulted by TaskHistory before streaming a background task's messages. */
	isWatched(taskId: string): boolean {
		return this.watched.has(taskId)
	}

	private postUpdate(): void {
		this.post({
			type: "subagentsUpdated",
			sourceTaskId: this.currentTaskIdProvider(),
			subagents: this.list(),
		})
	}
}
