import * as os from "os"
import * as path from "path"

import { worktreeService } from "@roo-code/core"
import {
	DEFAULT_PARALLEL_TASKS_MAX_CONCURRENCY,
	isParallelTasksEnabled,
	RooCodeEventName,
	type HistoryItem,
	type SubagentSummary,
} from "@roo-code/types"

import { Task, type AutoApprovalOverride } from "../task/Task"
import { buildSubagentApprovalPolicy, type ApprovalState } from "../task/subagentApproval"
import { queuedSubagentId } from "../webview/SubagentRegistry"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"

/** One requested subtask. */
export interface ParallelSubtask {
	message: string
	mode?: string | null
}

/** A subtask after validation/normalization (mode resolved to a concrete slug). */
export interface NormalizedSubtask {
	message: string
	mode: string
}

interface RunParallelTasksParams {
	subtasks: ParallelSubtask[]
	maxConcurrency?: number | null
}

/** Outcome of a single subtask run, used for the aggregated report. */
export interface ParallelSubtaskResult {
	index: number
	mode: string
	status: "completed" | "failed" | "cancelled"
	worktreePath?: string
	branch?: string
	message?: string
	error?: string
	/** Worktree + branch removed because nothing reviewable was produced. */
	cleaned?: boolean
}

const DEFAULT_MODE = "code"
const DEFAULT_MAX_CONCURRENCY = DEFAULT_PARALLEL_TASKS_MAX_CONCURRENCY

/**
 * Modes that are never allowed for a parallel subtask. Subtasks are small
 * one-shot jobs; architecture/planning and orchestration are serious,
 * long-horizon work that belongs in the parent task itself.
 */
export const DISALLOWED_SUBTASK_MODES = ["architect", "orchestrator"] as const
/** Turn cap per subagent — a runaway backstop, generous enough for real work. */
export const SUBAGENT_MAX_TURNS = 50

/**
 * Validate & normalize the raw tool args. Returns either normalized subtasks +
 * concurrency, or an error string describing what's wrong.
 *
 * `maxConcurrencyCap` is the user's configured hard limit
 * (`parallelTasksMaxConcurrency`): the model-supplied `maxConcurrency` may
 * lower concurrency below it but never exceed it.
 */
export function validateParallelParams(
	params: Partial<RunParallelTasksParams> | undefined,
	maxConcurrencyCap: number = DEFAULT_MAX_CONCURRENCY,
): { ok: true; subtasks: NormalizedSubtask[]; maxConcurrency: number } | { ok: false; error: string } {
	const raw = params?.subtasks
	if (!Array.isArray(raw) || raw.length === 0) {
		return { ok: false, error: "run_parallel_tasks requires a non-empty `subtasks` array." }
	}
	if (raw.length < 2) {
		return {
			ok: false,
			error:
				"run_parallel_tasks requires AT LEAST 2 subtasks — its whole value is running several independent " +
				"jobs at the same time. For a single job, do the work directly in this task (or delegate it via " +
				"new_task if it needs a different specialist mode).",
		}
	}
	const subtasks: NormalizedSubtask[] = []
	for (let i = 0; i < raw.length; i++) {
		const message = raw[i]?.message
		if (typeof message !== "string" || message.trim().length === 0) {
			return { ok: false, error: `Subtask #${i + 1} is missing a non-empty \`message\`.` }
		}
		const mode = raw[i]?.mode || DEFAULT_MODE
		if ((DISALLOWED_SUBTASK_MODES as readonly string[]).includes(mode)) {
			return {
				ok: false,
				error:
					`Subtask #${i + 1} uses mode "${mode}", which is not allowed for parallel subtasks. ` +
					`Parallel subtasks are small one-shot jobs (answering a question in ask mode, web research, ` +
					`a small scoped code edit, running tests) — do the ${mode} work yourself in this task and ` +
					`fan out only the small independent pieces.`,
			}
		}
		subtasks.push({ message, mode })
	}
	const cap =
		Number.isFinite(maxConcurrencyCap) && maxConcurrencyCap >= 1
			? Math.floor(maxConcurrencyCap)
			: DEFAULT_MAX_CONCURRENCY
	let maxConcurrency = params?.maxConcurrency ?? Math.min(DEFAULT_MAX_CONCURRENCY, cap)
	// Below 2 is treated as invalid, not honored: "parallel with concurrency 1"
	// defeats the tool's purpose, so a nonsensical request falls back to the
	// default instead of degrading the fan-out to a sequential queue.
	if (typeof maxConcurrency !== "number" || !Number.isFinite(maxConcurrency) || maxConcurrency < 2) {
		maxConcurrency = Math.min(DEFAULT_MAX_CONCURRENCY, cap)
	}
	return { ok: true, subtasks, maxConcurrency: Math.min(Math.floor(maxConcurrency), cap, subtasks.length) }
}

/**
 * Run `items` through `worker` with at most `limit` running concurrently,
 * preserving input order in the returned results. A worker that throws yields
 * that slot's rejection via `onError` (never rejects the pool).
 */
export async function runWithConcurrency<T, R>(
	items: ReadonlyArray<T>,
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length)
	let next = 0
	const runNext = async (): Promise<void> => {
		const current = next++
		if (current >= items.length) return
		results[current] = await worker(items[current], current)
		await runNext()
	}
	const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => runNext())
	await Promise.all(runners)
	return results
}

/** Render the per-subtask outcomes into a single delimited tool result. */
export function formatParallelResults(results: ReadonlyArray<ParallelSubtaskResult>): string {
	const completed = results.filter((r) => r.status === "completed").length
	const failed = results.filter((r) => r.status === "failed").length
	const cancelled = results.filter((r) => r.status === "cancelled").length

	const summaryParts = [`${completed} completed`, `${failed} failed`]
	if (cancelled > 0) summaryParts.push(`${cancelled} cancelled`)
	const lines: string[] = [
		`Ran ${results.length} parallel subtask(s): ${summaryParts.join(", ")}.`,
		"Worktrees with changes are kept for review; empty ones were removed. Nothing was merged.",
		"",
	]
	for (const r of results) {
		lines.push(`### Subtask ${r.index + 1} — ${r.status.toUpperCase()} (${r.mode} mode)`)
		if (r.cleaned) {
			lines.push("- worktree: cleaned up (no changes)")
		} else if (r.worktreePath) {
			lines.push(`- worktree: ${r.worktreePath}${r.branch ? ` (branch: ${r.branch})` : ""}`)
		}
		if (r.status === "completed") {
			lines.push("", r.message?.trim() || "(no result message)")
		} else if (r.status === "cancelled") {
			lines.push("", "Cancelled before completion.")
		} else {
			lines.push("", `Failed: ${r.error ?? "unknown error"}`)
		}
		lines.push("", "---", "")
	}
	return lines.join("\n").trimEnd()
}

/** Deterministic worktree dir + branch for a given parent task and subtask index. */
export function worktreeNamesFor(
	cwd: string,
	parentTaskId: string,
	index: number,
): { worktreePath: string; branch: string } {
	const project = path.basename(cwd) || "project"
	const shortId = parentTaskId.slice(0, 8)
	const tag = `${project}-${shortId}-${index + 1}`
	return {
		worktreePath: path.join(os.homedir(), ".roo", "worktrees", tag),
		branch: `worktree/parallel-${shortId}-${index + 1}`,
	}
}

/**
 * Remove a subtask's worktree + branch when nothing reviewable was produced.
 * Non-forced remove is a second safety net: git refuses uncommitted changes.
 */
async function cleanupSubtaskWorktreeIfEmpty({
	cwd,
	worktreePath,
	branch,
}: {
	cwd: string
	worktreePath: string
	branch: string
}): Promise<boolean> {
	try {
		if (await worktreeService.hasUncommittedChanges(worktreePath)) return false
		if (await worktreeService.branchHasCommits(cwd, branch)) return false
		const removed = await worktreeService.deleteWorktree(cwd, worktreePath)
		return removed.success
	} catch {
		return false
	}
}

/** Registry surface the fan-out reports lifecycle changes to (webview panel). */
export interface SubtaskRegistry {
	beginFanOut(parentTaskId: string): void
	registerQueued(summary: {
		parentTaskId: string
		index: number
		mode: string
		description: string
		tokensIn: number
		tokensOut: number
		totalCost: number
		startedAt: number
		lastActivityAt: number
	}): void
	markTerminal(taskId: string, status: "completed" | "failed" | "cancelled", finalMessage?: string): void
	get(taskId: string): { status: string } | undefined
	/** Snapshot of every registered summary in panel order (for sidecar persistence). */
	snapshot(): SubagentSummary[]
}

/** Provider surface needed by a single subtask worker. */
interface SubtaskProvider {
	createBackgroundTask(
		text: string,
		options: {
			taskMode?: string
			workspacePath?: string
			maxAgentTurns?: number
			autoApprovalOverride?: AutoApprovalOverride
			silentWrites?: boolean
			subagentInfo?: { parentTaskId: string; index: number; description: string }
		},
	): Promise<Task>
	awaitTaskCompletion(
		task: Task,
		options: { signal?: AbortSignal },
	): Promise<{ completed: boolean; lastMessage?: string; writtenPaths: string[] }>
	getState(): Promise<ApprovalState & { parallelTasksMaxConcurrency?: number }>
	subagentRegistry: SubtaskRegistry
	getLiveTaskInstance(taskId: string): { messageQueueService: { addMessage(text: string): unknown } } | undefined
	/**
	 * Atomically read the parent's `HistoryItem`, apply `updater`, and write
	 * it back. Used to record `parallelChildIds` as each child is spawned.
	 * Mirrors `TaskHistoryStore.atomicReadAndUpdate`; the tool never imports
	 * the store directly so the fan-out stays testable with a fake provider.
	 */
	atomicReadAndUpdateHistoryItem(taskId: string, updater: (current: HistoryItem) => HistoryItem): Promise<HistoryItem>
	/**
	 * Absolute path of the extension global storage directory (the parent of
	 * `tasks/<id>/`). Used to resolve the `subagents.json` sidecar path.
	 */
	readonly globalStoragePath: string
}

/** Truncate a subtask message for panel display. */
export function subagentDescription(message: string): string {
	const firstLine = message.split("\n", 1)[0] ?? message
	return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
}

/** Arguments for {@link runOneSubtask}. */
interface RunOneSubtaskArgs {
	provider: SubtaskProvider
	cwd: string
	parentTaskId: string
	subtask: NormalizedSubtask
	index: number
	signal: AbortSignal
}

/**
 * Run a single subtask: create its worktree, spawn a headless child, and await
 * completion. Checks `signal.aborted` before each side-effecting step so that
 * a parent abort cancels pending workers without orphaning children.
 */
async function runOneSubtask({
	provider,
	cwd,
	parentTaskId,
	subtask,
	index,
	signal,
}: RunOneSubtaskArgs): Promise<ParallelSubtaskResult> {
	const { worktreePath, branch } = worktreeNamesFor(cwd, parentTaskId, index)
	const registry = provider.subagentRegistry
	// Until the child Task exists, panel updates target the queued placeholder.
	let registryId = queuedSubagentId(parentTaskId, index)

	if (signal.aborted) {
		registry.markTerminal(registryId, "cancelled")
		return { index, mode: subtask.mode, status: "cancelled" }
	}

	try {
		const created = await worktreeService.createWorktree(cwd, {
			path: worktreePath,
			branch,
			createNewBranch: true,
		})
		if (!created.success) {
			const error = `worktree creation failed: ${created.message}`
			registry.markTerminal(registryId, "failed", error)
			return { index, mode: subtask.mode, status: "failed", error }
		}

		if (signal.aborted) {
			registry.markTerminal(registryId, "cancelled")
			return await finalize(cwd, { index, mode: subtask.mode, status: "cancelled", worktreePath, branch })
		}

		const child = await provider.createBackgroundTask(subtask.message, {
			taskMode: subtask.mode,
			workspacePath: worktreePath,
			maxAgentTurns: SUBAGENT_MAX_TURNS,
			// Subagents follow the user's auto-approval settings; worktree
			// writes and reads are pre-approved; anything that would ask the
			// user is denied (a headless child has no user to ask).
			autoApprovalOverride: buildSubagentApprovalPolicy({
				getState: () => provider.getState(),
				worktreePath,
			}),
			subagentInfo: { parentTaskId, index, description: subagentDescription(subtask.message) },
		})
		registryId = child.taskId
		// Persist the parent→child relation on the parent's HistoryItem so
		// rehydration from history can discover this fan-out's children.
		// Mirror of `delegateParentAndOpenChild`'s `atomicReadAndUpdate`, but
		// WITHOUT setting `status: "delegated"` / `awaitingChildId` — the
		// parent is NOT delegated to a parallel subagent, it waits inline on
		// the tool result. Best-effort: a failure to persist the relation
		// must not break the fan-out (the sidecar write below and the live
		// panel still work; only rehydration of this run would be affected).
		await persistParallelChildId(provider, parentTaskId, child.taskId)
		const outcome = await provider.awaitTaskCompletion(child, { signal })

		// Cancellation shows up two ways: the fan-out signal (parent aborted)
		// or a per-subagent cancel from the panel (registry already terminal
		// "cancelled" via the cancelSubagent handler).
		const wasCancelledIndividually = registry.get(registryId)?.status === "cancelled"
		if (!outcome.completed && (signal.aborted || wasCancelledIndividually)) {
			registry.markTerminal(registryId, "cancelled")
			return await finalize(cwd, { index, mode: subtask.mode, status: "cancelled", worktreePath, branch })
		}
		const error = outcome.completed ? undefined : "subtask aborted before completion"
		registry.markTerminal(
			registryId,
			outcome.completed ? "completed" : "failed",
			outcome.completed ? outcome.lastMessage : error,
		)
		return await finalize(cwd, {
			index,
			mode: subtask.mode,
			status: outcome.completed ? "completed" : "failed",
			worktreePath,
			branch,
			message: outcome.lastMessage,
			error,
		})
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		registry.markTerminal(registryId, "failed", errorMessage)
		return await finalize(cwd, {
			index,
			mode: subtask.mode,
			status: "failed",
			worktreePath,
			branch,
			error: errorMessage,
		})
	}
}

/** Attach cleanup outcome to a terminal subtask result. */
async function finalize(cwd: string, result: ParallelSubtaskResult): Promise<ParallelSubtaskResult> {
	const { worktreePath, branch } = result
	if (!worktreePath || !branch) return result
	const cleaned = await cleanupSubtaskWorktreeIfEmpty({ cwd, worktreePath, branch })
	return cleaned ? { ...result, cleaned: true } : result
}

/**
 * Best-effort persistence of the parent→child relation for a parallel
 * fan-out: appends `childTaskId` to the parent HistoryItem's
 * `parallelChildIds` (deduped, order-preserving) via the provider's atomic
 * read-modify-write. Never throws — a failure is logged and the fan-out
 * continues (only historical rehydration of this run would be affected; the
 * live panel and tool result are independent).
 */
async function persistParallelChildId(
	provider: SubtaskProvider,
	parentTaskId: string,
	childTaskId: string,
): Promise<void> {
	try {
		await provider.atomicReadAndUpdateHistoryItem(parentTaskId, (current) => ({
			...current,
			parallelChildIds: Array.from(new Set([...(current.parallelChildIds ?? []), childTaskId])),
		}))
	} catch (error) {
		// Non-fatal: the live fan-out and panel still work. Only rehydration
		// from history of this specific run would lack the child relation.
		console.warn(
			`[run_parallel_tasks] Failed to persist parallelChildIds for parent ${parentTaskId} (child ${childTaskId}): ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
}

/**
 * Best-effort persistence of the terminal subagent summaries to the parent
 * task's sidecar (`tasks/<parentTaskId>/subagents.json`). Called once after
 * the whole fan-out settles so rehydration can repopulate the panel without
 * re-reading each child's messages. Never throws — a missing/corrupt sidecar
 * only means the historical panel stays empty for this run.
 */
async function persistSubagentSummariesSidecar(provider: SubtaskProvider, parentTaskId: string): Promise<void> {
	try {
		const { saveSubagentSummaries } = await import("../task-persistence/subagentSummariesStore")
		const summaries = provider.subagentRegistry.snapshot()
		await saveSubagentSummaries(provider.globalStoragePath, parentTaskId, summaries)
	} catch (error) {
		// Non-fatal: see persistParallelChildId. The live panel is unaffected.
		console.warn(
			`[run_parallel_tasks] Failed to persist subagents sidecar for parent ${parentTaskId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
}

export class RunParallelTasksTool extends BaseTool<"run_parallel_tasks"> {
	readonly name = "run_parallel_tasks" as const

	async execute(params: RunParallelTasksParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// No nested fan-outs: a subtask is a small one-shot job. The tool
			// is already stripped from background tasks' tool lists; this
			// guards hallucinated calls and prompt-listed protocols.
			if (task.isBackground) {
				task.recordToolError("run_parallel_tasks")
				pushToolResult(
					formatResponse.toolError(
						"run_parallel_tasks is not available inside a parallel subtask. Subtasks are " +
							"one-shot jobs and cannot spawn further subtasks: do the work directly in this " +
							"task and finish with attempt_completion so the parent task can continue.",
					),
				)
				return
			}

			const provider = task.providerRef.deref()
			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			// The user's configured hard cap bounds whatever concurrency the
			// model asked for; below 2 it disables the feature entirely.
			const maxConcurrencyCap =
				(await provider.getState()).parallelTasksMaxConcurrency ?? DEFAULT_PARALLEL_TASKS_MAX_CONCURRENCY
			if (!isParallelTasksEnabled(maxConcurrencyCap)) {
				task.recordToolError("run_parallel_tasks")
				pushToolResult(
					formatResponse.toolError(
						"run_parallel_tasks is disabled: the user's 'Max parallel subagents' setting is Off. " +
							"Do the work directly in this task, or delegate it via new_task if it needs a " +
							"different specialist mode.",
					),
				)
				return
			}

			const validated = validateParallelParams(params, maxConcurrencyCap)
			if (!validated.ok) {
				task.consecutiveMistakeCount++
				task.recordToolError("run_parallel_tasks")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(validated.error))
				return
			}
			task.consecutiveMistakeCount = 0

			const cwd = task.cwd
			if (!(await worktreeService.checkGitRepo(cwd))) {
				pushToolResult(
					formatResponse.toolError(
						"run_parallel_tasks requires a git repository (each subtask runs in its own worktree). " +
							"The current workspace is not a git repo.",
					),
				)
				return
			}

			const { subtasks, maxConcurrency } = validated
			const approvalMessage = JSON.stringify({
				tool: "runParallelTasks",
				count: subtasks.length,
				maxConcurrency,
				subtasks: subtasks.map((s) => ({ mode: s.mode, message: s.message })),
			})
			const didApprove = await askApproval("tool", approvalMessage)
			if (!didApprove) return

			if (task.abort) {
				pushToolResult(formatResponse.toolError("run_parallel_tasks cancelled."))
				return
			}

			// Seed the webview subagents panel: previous fan-out entries for
			// this parent are dropped, every subtask appears immediately as
			// "queued" and transitions as its worker picks it up.
			const fanOutStartedAt = Date.now()
			provider.subagentRegistry.beginFanOut(task.taskId)
			for (let i = 0; i < subtasks.length; i++) {
				provider.subagentRegistry.registerQueued({
					parentTaskId: task.taskId,
					index: i,
					mode: subtasks[i].mode,
					description: subagentDescription(subtasks[i].message),
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					startedAt: fanOutStartedAt,
					lastActivityAt: fanOutStartedAt,
				})
			}

			const controller = new AbortController()
			const onParentAborted = () => {
				// Only an EXPLICIT user cancel cascades to the children.
				// Abandonment aborts (task switch via history, in-place
				// rehydrate on cancel of another op, streaming-failure
				// rehydrate) detach the fan-out instead: the children keep
				// running, stay visible in the panel (individually
				// cancellable), and the report is delivered to the parent's
				// rehydrated instance below.
				if (task.abortReason === "user_cancelled") {
					controller.abort()
				}
			}
			task.on(RooCodeEventName.TaskAborted, onParentAborted)
			try {
				const results = await runWithConcurrency(subtasks, maxConcurrency, (subtask, index) =>
					runOneSubtask({
						provider,
						cwd,
						parentTaskId: task.taskId,
						subtask,
						index,
						signal: controller.signal,
					}),
				)
				const report = formatParallelResults(results)
				if ((task.abort || task.abandoned) && task.abortReason !== "user_cancelled") {
					// The original tool context is dead (parent was abandoned
					// mid-fan-out). Queue the report into the live rehydrated
					// instance of the same task: its pending resume_task ask
					// drains the queue, so the orchestrator auto-resumes with
					// the results the moment they are ready.
					provider
						.getLiveTaskInstance(task.taskId)
						?.messageQueueService.addMessage(
							`All parallel subtasks launched by run_parallel_tasks finished while this task was paused. Results:\n\n${report}`,
						)
				}
				pushToolResult(report)
				// Persist the terminal subagent summaries to the parent's
				// sidecar so rehydration from history can repopulate the
				// panel. Best-effort: never throws (see helper). Done after
				// the report is pushed so a sidecar write failure cannot
				// block the tool result. Runs in both the normal and the
				// abandoned-parent paths — the rehydrated parent needs the
				// summaries either way.
				await persistSubagentSummariesSidecar(provider, task.taskId)
			} finally {
				task.off(RooCodeEventName.TaskAborted, onParentAborted)
			}
		} catch (error) {
			await handleError("running parallel tasks", error)
		}
	}

	override async handlePartial(_task: Task, _block: ToolUse<"run_parallel_tasks">): Promise<void> {
		// No streaming card — the fan-out only acts once args are complete.
	}
}

export const runParallelTasksTool = new RunParallelTasksTool()
