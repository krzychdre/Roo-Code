import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"

import { EventEmitter } from "events"
import * as fs from "fs/promises"
import { mkdtempSync, rmSync } from "fs"
import * as path from "path"
import * as os from "os"

// Storage root for every fake provider in this file. Created eagerly so the
// synchronous `makeFakeProvider` helper can carve out a subdirectory per
// provider, and removed once the suite finishes.
const tmpStorageRoot = mkdtempSync(path.join(os.tmpdir(), "rpt-storage-"))
afterAll(() => {
	rmSync(tmpStorageRoot, { recursive: true, force: true })
})

import { RooCodeEventName } from "@roo-code/types"

// Mock worktreeService before importing the tool. vi.hoisted ensures the
// mock functions are available when the hoisted vi.mock factory runs.
const { mockCheckGitRepo, mockCreateWorktree, mockHasUncommittedChanges, mockBranchHasCommits, mockDeleteWorktree } =
	vi.hoisted(() => ({
		mockCheckGitRepo: vi.fn().mockResolvedValue(true),
		mockCreateWorktree: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
		mockHasUncommittedChanges: vi.fn().mockResolvedValue(false),
		mockBranchHasCommits: vi.fn().mockResolvedValue(false),
		mockDeleteWorktree: vi.fn().mockResolvedValue({ success: true, message: "removed" }),
	}))
vi.mock("@roo-code/core", () => ({
	worktreeService: {
		checkGitRepo: mockCheckGitRepo,
		createWorktree: mockCreateWorktree,
		hasUncommittedChanges: mockHasUncommittedChanges,
		branchHasCommits: mockBranchHasCommits,
		deleteWorktree: mockDeleteWorktree,
	},
}))

// `vscode` is pulled in transitively via `subagentSummariesStore` →
// `utils/storage` (`getStorageBasePath` reads vscode.workspace config).
// Mock it so the positive sidecar-write test can use a real temp dir as the
// storage base (empty custom path → default path = globalStoragePath arg).
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue(""),
		}),
	},
	window: { showErrorMessage: vi.fn() },
}))

// Mock formatResponse to keep output predictable.
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Error: ${msg}`),
	},
}))

import {
	validateParallelParams,
	runWithConcurrency,
	formatParallelResults,
	worktreeNamesFor,
	runParallelTasksTool,
	type ParallelSubtaskResult,
} from "../RunParallelTasksTool"
import { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"

// ---------------------------------------------------------------------------
// Helpers for execute() tests
// ---------------------------------------------------------------------------

/**
 * A minimal fake provider that records calls and lets tests control outcomes.
 * Now exposes the persistence surface (`atomicReadAndUpdateHistoryItem` +
 * `globalStoragePath`) required by `run_parallel_tasks`' new sidecar/relation
 * persistence. `atomicReadAndUpdateHistoryItem` records every call and
 * mutates an in-memory record so tests can assert what was persisted.
 */
function makeFakeProvider(state: Record<string, unknown> = {}) {
	const children: FakeChild[] = []
	// In-memory HistoryItem store keyed by task id. Tests seed entries for
	// the parent task; `atomicReadAndUpdateHistoryItem` reads + writes here.
	const historyItems = new Map<string, Record<string, unknown>>()
	const atomicReadAndUpdateHistoryItem = vi
		.fn()
		.mockImplementation(async (taskId: string, updater: (c: any) => any) => {
			const current = historyItems.get(taskId) ?? {
				id: taskId,
				number: 1,
				ts: 0,
				task: "parent",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}
			const updated = updater(current)
			historyItems.set(taskId, updated)
			return updated
		})
	const subagentRegistry = {
		beginFanOut: vi.fn(),
		registerQueued: vi.fn(),
		markTerminal: vi.fn(),
		get: vi.fn().mockReturnValue(undefined),
		snapshot: vi.fn().mockReturnValue([]),
	}
	const provider = {
		children,
		historyItems,
		createBackgroundTask: vi.fn().mockImplementation(() => {
			const child = new FakeChild()
			children.push(child)
			return Promise.resolve(child)
		}),
		awaitTaskCompletion: vi
			.fn()
			.mockImplementation((child: FakeChild, options: { signal?: AbortSignal }) => child.await(options)),
		getState: vi.fn().mockResolvedValue({
			autoApprovalEnabled: true,
			alwaysAllowExecute: false,
			allowedCommands: [],
			deniedCommands: [],
			...state,
		}),
		subagentRegistry,
		getLiveTaskInstance: vi.fn().mockReturnValue(undefined),
		atomicReadAndUpdateHistoryItem,
		// A per-provider temp dir, so the best-effort sidecar write that every
		// fan-out performs hits the real fs without polluting the workspace.
		// An empty string here would resolve to a *relative* path and create
		// `src/tasks/<parentTaskId>/subagents.json` in the repo.
		globalStoragePath: mkdtempSync(path.join(tmpStorageRoot, "provider-")),
	}
	return provider as unknown as {
		children: FakeChild[]
		historyItems: Map<string, Record<string, unknown>>
		createBackgroundTask: ReturnType<typeof vi.fn>
		awaitTaskCompletion: ReturnType<typeof vi.fn>
		getState: ReturnType<typeof vi.fn>
		subagentRegistry: {
			beginFanOut: ReturnType<typeof vi.fn>
			registerQueued: ReturnType<typeof vi.fn>
			markTerminal: ReturnType<typeof vi.fn>
			snapshot: ReturnType<typeof vi.fn>
		}
		getLiveTaskInstance: ReturnType<typeof vi.fn>
		atomicReadAndUpdateHistoryItem: ReturnType<typeof vi.fn>
		globalStoragePath: string
	}
}

/** A stub Task-like object returned by createBackgroundTask. */
class FakeChild {
	taskId = `child-${Math.random().toString(36).slice(2, 8)}`
	abortTask = vi.fn().mockResolvedValue(undefined)
	await(options: { signal?: AbortSignal }): Promise<{
		completed: boolean
		lastMessage?: string
		writtenPaths: string[]
	}> {
		return new Promise((resolve) => {
			let settled = false
			const done = (completed: boolean) => {
				if (settled) return
				settled = true
				resolve({ completed, writtenPaths: [] })
			}
			// If a signal is provided and it aborts, resolve as not-completed.
			if (options.signal) {
				if (options.signal.aborted) {
					done(false)
					return
				}
				options.signal.addEventListener("abort", () => done(false), { once: true })
			}
			// Default: never resolves unless signal fires or child.complete() is called.
			// Tests that want the normal path will call child.complete().
			this._resolveNormal = () => done(true)
		})
	}
	_resolveNormal: (() => void) | null = null
	complete() {
		this._resolveNormal?.()
	}
}

/** A minimal fake parent Task: an EventEmitter with the fields execute() reads. */
function makeFakeParentTask(provider: unknown, overrides: Record<string, unknown> = {}): Task {
	const bus = new EventEmitter() as unknown as Task
	const task = Object.assign(bus, {
		taskId: "parent-12345678",
		cwd: "/home/user/myproj",
		abort: false,
		consecutiveMistakeCount: 0,
		recordToolError: vi.fn(),
		didToolFailInCurrentTurn: false,
		providerRef: { deref: () => provider },
	}) as Task
	return Object.assign(task, overrides) as Task
}

function makeCallbacks(overrides: Partial<ToolCallbacks> = {}): ToolCallbacks & {
	pushToolResult: ReturnType<typeof vi.fn>
	askApproval: ReturnType<typeof vi.fn>
	handleError: ReturnType<typeof vi.fn>
} {
	return {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
		...overrides,
	} as unknown as ToolCallbacks & {
		pushToolResult: ReturnType<typeof vi.fn>
		askApproval: ReturnType<typeof vi.fn>
		handleError: ReturnType<typeof vi.fn>
	}
}

// ---------------------------------------------------------------------------
// Pure helper tests (existing)
// ---------------------------------------------------------------------------

describe("RunParallelTasksTool helpers", () => {
	describe("validateParallelParams", () => {
		it("rejects missing / empty subtasks", () => {
			expect(validateParallelParams(undefined)).toEqual({ ok: false, error: expect.any(String) })
			expect(validateParallelParams({ subtasks: [] })).toEqual({ ok: false, error: expect.any(String) })
		})

		it("rejects a single-subtask fan-out with corrective steering", () => {
			const r = validateParallelParams({ subtasks: [{ message: "just one job" }] })
			expect(r.ok).toBe(false)
			if (!r.ok) {
				expect(r.error).toContain("AT LEAST 2")
				expect(r.error).toContain("new_task")
			}
		})

		it("rejects a subtask without a message", () => {
			const r = validateParallelParams({ subtasks: [{ message: "  " } as never, { message: "ok" }] })
			expect(r.ok).toBe(false)
		})

		it("normalizes mode to 'code' by default and clamps concurrency to subtask count", () => {
			const r = validateParallelParams({
				subtasks: [{ message: "a" }, { message: "b", mode: "debug" }],
				maxConcurrency: 10,
			})
			expect(r).toEqual({
				ok: true,
				subtasks: [
					{ message: "a", mode: "code" },
					{ message: "b", mode: "debug" },
				],
				maxConcurrency: 2, // clamped to subtasks.length
			})
		})

		it("defaults concurrency to 3 for invalid values", () => {
			const many = Array.from({ length: 5 }, (_, i) => ({ message: `m${i}` }))
			expect(validateParallelParams({ subtasks: many, maxConcurrency: 0 })).toMatchObject({
				maxConcurrency: 3,
			})
			expect(validateParallelParams({ subtasks: many, maxConcurrency: null })).toMatchObject({
				maxConcurrency: 3,
			})
		})

		it("rejects architect/orchestrator subtask modes with a corrective error", () => {
			for (const mode of ["architect", "orchestrator"]) {
				const r = validateParallelParams({
					subtasks: [{ message: "plan the system", mode }, { message: "ok" }],
				})
				expect(r.ok).toBe(false)
				if (!r.ok) {
					expect(r.error).toContain(`"${mode}"`)
					expect(r.error).toContain("one-shot")
				}
			}
			// Lightweight modes stay allowed.
			expect(
				validateParallelParams({
					subtasks: [
						{ message: "q", mode: "ask" },
						{ message: "r", mode: "ask" },
					],
				}).ok,
			).toBe(true)
		})

		it("clamps the requested concurrency to the user's configured cap", () => {
			const many = Array.from({ length: 10 }, (_, i) => ({ message: `m${i}` }))
			expect(validateParallelParams({ subtasks: many, maxConcurrency: 8 }, 2)).toMatchObject({
				maxConcurrency: 2,
			})
			// The model may lower concurrency below the cap — but never under 2
			// (a sequential "parallel" run is nonsense; invalid → default).
			expect(validateParallelParams({ subtasks: many, maxConcurrency: 2 }, 4)).toMatchObject({
				maxConcurrency: 2,
			})
			expect(validateParallelParams({ subtasks: many, maxConcurrency: 1 }, 4)).toMatchObject({
				maxConcurrency: 3,
			})
			// Default request under a cap tighter than the built-in default.
			expect(validateParallelParams({ subtasks: many }, 2)).toMatchObject({ maxConcurrency: 2 })
			// A nonsensical cap falls back to the built-in default.
			expect(validateParallelParams({ subtasks: many, maxConcurrency: 8 }, 0)).toMatchObject({
				maxConcurrency: 3,
			})
		})
	})

	describe("runWithConcurrency", () => {
		it("runs every item, preserving input order in results", async () => {
			const out = await runWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10)
			expect(out).toEqual([10, 20, 30, 40])
		})

		it("never exceeds the concurrency limit", async () => {
			let active = 0
			let peak = 0
			await runWithConcurrency(
				Array.from({ length: 8 }, (_, i) => i),
				3,
				async (i) => {
					active++
					peak = Math.max(peak, active)
					await new Promise((r) => setTimeout(r, 5))
					active--
					return i
				},
			)
			expect(peak).toBeLessThanOrEqual(3)
			expect(peak).toBeGreaterThan(1)
		})
	})

	describe("formatParallelResults", () => {
		it("summarizes counts and renders each subtask block", () => {
			const results: ParallelSubtaskResult[] = [
				{
					index: 0,
					mode: "code",
					status: "completed",
					worktreePath: "/wt/a",
					branch: "worktree/parallel-x-1",
					message: "did the thing",
				},
				{ index: 1, mode: "debug", status: "failed", worktreePath: "/wt/b", error: "boom" },
			]
			const out = formatParallelResults(results)
			expect(out).toContain("1 completed, 1 failed")
			expect(out).toContain("### Subtask 1: COMPLETED (code mode)")
			expect(out).toContain("did the thing")
			expect(out).toContain("### Subtask 2: FAILED (debug mode)")
			expect(out).toContain("Failed: boom")
		})

		it("omits cancelled clause when there are no cancellations", () => {
			const results: ParallelSubtaskResult[] = [
				{ index: 0, mode: "code", status: "completed", message: "ok" },
				{ index: 1, mode: "code", status: "failed", error: "boom" },
			]
			const out = formatParallelResults(results)
			expect(out).toContain("1 completed, 1 failed")
			expect(out).not.toContain("cancelled")
		})

		it("includes cancelled count and per-subtask CANCELLED block", () => {
			const results: ParallelSubtaskResult[] = [
				{ index: 0, mode: "code", status: "completed", message: "ok" },
				{
					index: 1,
					mode: "code",
					status: "cancelled",
					worktreePath: "/wt/b",
					branch: "worktree/parallel-x-2",
				},
			]
			const out = formatParallelResults(results)
			expect(out).toContain("1 completed, 0 failed, 1 cancelled")
			expect(out).toContain("### Subtask 2: CANCELLED (code mode)")
			expect(out).toContain("Cancelled before completion.")
			expect(out).toContain("worktree: /wt/b")
		})

		it("shows 'cleaned up (no changes)' for cleaned subtasks", () => {
			const results: ParallelSubtaskResult[] = [
				{
					index: 0,
					mode: "code",
					status: "completed",
					worktreePath: "/wt/a",
					branch: "worktree/parallel-x-1",
					message: "done",
					cleaned: true,
				},
			]
			const out = formatParallelResults(results)
			expect(out).toContain("cleaned up (no changes)")
			expect(out).not.toContain("/wt/a")
		})
	})

	describe("worktreeNamesFor", () => {
		it("derives deterministic worktree path + branch from parent id and index", () => {
			const a = worktreeNamesFor("/home/u/myproj", "abcdef1234567890", 0)
			const b = worktreeNamesFor("/home/u/myproj", "abcdef1234567890", 0)
			expect(a).toEqual(b) // deterministic
			expect(a.branch).toBe("worktree/parallel-abcdef12-1")
			expect(a.worktreePath).toContain("myproj-abcdef12-1")
		})
	})
})

// ---------------------------------------------------------------------------
// execute() integration tests
// ---------------------------------------------------------------------------

describe("RunParallelTasksTool.execute", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockCheckGitRepo.mockResolvedValue(true)
		mockCreateWorktree.mockResolvedValue({ success: true, message: "ok" })
		mockHasUncommittedChanges.mockResolvedValue(false)
		mockBranchHasCommits.mockResolvedValue(false)
		mockDeleteWorktree.mockResolvedValue({ success: true, message: "removed" })
	})

	it("cap below 2 (feature Off): refused before validation/approval", async () => {
		const provider = makeFakeProvider({ parallelTasksMaxConcurrency: 1 })
		const parent = makeFakeParentTask(provider)
		const callbacks = makeCallbacks()

		await runParallelTasksTool.execute(
			{ subtasks: [{ message: "task A" }, { message: "task B" }] },
			parent,
			callbacks,
		)

		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(provider.createBackgroundTask).not.toHaveBeenCalled()
		const result = callbacks.pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("disabled")
		expect(result).toContain("new_task")
	})

	it("background caller (subtask): refused — no nested fan-outs", async () => {
		const provider = makeFakeProvider()
		const parent = makeFakeParentTask(provider, { isBackground: true, recordToolError: vi.fn() })
		const callbacks = makeCallbacks()

		await runParallelTasksTool.execute(
			{ subtasks: [{ message: "nested" }, { message: "nested 2" }] },
			parent,
			callbacks,
		)

		expect(mockCreateWorktree).not.toHaveBeenCalled()
		expect(provider.createBackgroundTask).not.toHaveBeenCalled()
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		const result = callbacks.pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("not available inside a parallel subtask")
	})

	it("pre-aborted parent: starts nothing, no worktree created", async () => {
		const provider = makeFakeProvider()
		const parent = makeFakeParentTask(provider, { abort: true })
		const callbacks = makeCallbacks()

		await runParallelTasksTool.execute(
			{ subtasks: [{ message: "do thing" }, { message: "other thing" }] },
			parent,
			callbacks,
		)

		expect(mockCreateWorktree).not.toHaveBeenCalled()
		expect(provider.createBackgroundTask).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		const result = callbacks.pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("cancelled")
	})

	it("normal path: 2 subtasks complete, report has no cancelled text", async () => {
		const provider = makeFakeProvider()
		const parent = makeFakeParentTask(provider)
		const callbacks = makeCallbacks()

		// Start execute; it will be pending on awaitTaskCompletion.
		const execPromise = runParallelTasksTool.execute(
			{ subtasks: [{ message: "task A" }, { message: "task B" }] },
			parent,
			callbacks,
		)

		// Wait for both children to be spawned.
		await vi.waitFor(() => expect(provider.children.length).toBe(2))
		provider.children.forEach((c) => c.complete())
		await execPromise

		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		const report = callbacks.pushToolResult.mock.calls[0][0] as string
		expect(report).toContain("2 parallel subtask(s)")
		expect(report).toContain("2 completed")
		expect(report).not.toContain("cancelled")
	})

	it("cancel propagation: parent emits TaskAborted mid-run, both subtasks CANCELLED", async () => {
		const provider = makeFakeProvider()
		const parent = makeFakeParentTask(provider)
		const callbacks = makeCallbacks()

		const execPromise = runParallelTasksTool.execute(
			{ subtasks: [{ message: "task A" }, { message: "task B" }] },
			parent,
			callbacks,
		)

		// Wait for both children to be spawned.
		await vi.waitFor(() => expect(provider.children.length).toBe(2))

		// An explicit user cancel: abortReason is set before the abort event
		// (matching ClineProvider.cancelTask) — this fires the AbortController.
		;(parent as any).abortReason = "user_cancelled"
		parent.emit(RooCodeEventName.TaskAborted)

		await execPromise

		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		const report = callbacks.pushToolResult.mock.calls[0][0] as string
		expect(report).toContain("CANCELLED")
		// Both subtasks should be cancelled.
		const cancelledMatches = report.match(/CANCELLED/g)
		expect(cancelledMatches).toHaveLength(2)
		expect(report).toContain("2 cancelled")
	})

	it("abandonment abort (no user_cancelled) DETACHES: children keep running and finish", async () => {
		const provider = makeFakeProvider()
		const parent = makeFakeParentTask(provider)
		const callbacks = makeCallbacks()

		const execPromise = runParallelTasksTool.execute(
			{ subtasks: [{ message: "task A" }, { message: "task B" }] },
			parent,
			callbacks,
		)

		await vi.waitFor(() => expect(provider.children.length).toBe(2))

		// Abandonment (task switch / in-place rehydrate): TaskAborted fires
		// WITHOUT abortReason = "user_cancelled" — the fan-out must survive.
		parent.emit(RooCodeEventName.TaskAborted)
		provider.children.forEach((c) => expect(c.abortTask).not.toHaveBeenCalled())

		provider.children.forEach((c) => c.complete())
		await execPromise

		const report = callbacks.pushToolResult.mock.calls[0][0] as string
		expect(report).toContain("2 completed")
		expect(report).not.toContain("CANCELLED")
	})

	it("detached fan-out queues its report into the live rehydrated parent instance", async () => {
		const provider = makeFakeProvider()
		const addMessage = vi.fn()
		provider.getLiveTaskInstance.mockReturnValue({ messageQueueService: { addMessage } })
		const parent = makeFakeParentTask(provider)
		const callbacks = makeCallbacks()

		const execPromise = runParallelTasksTool.execute(
			{ subtasks: [{ message: "task A" }, { message: "task B" }] },
			parent,
			callbacks,
		)

		await vi.waitFor(() => expect(provider.children.length).toBe(2))
		// Parent abandoned mid-run (rehydrated elsewhere).
		;(parent as any).abandoned = true
		parent.emit(RooCodeEventName.TaskAborted)
		provider.children.forEach((c) => c.complete())
		await execPromise

		expect(provider.getLiveTaskInstance).toHaveBeenCalledWith("parent-12345678")
		expect(addMessage).toHaveBeenCalledOnce()
		const queued = addMessage.mock.calls[0][0] as string
		expect(queued).toContain("finished while this task was paused")
		expect(queued).toContain("2 completed")
	})

	it("user-cancelled fan-out does NOT queue a report into the rehydrated instance", async () => {
		const provider = makeFakeProvider()
		const addMessage = vi.fn()
		provider.getLiveTaskInstance.mockReturnValue({ messageQueueService: { addMessage } })
		const parent = makeFakeParentTask(provider)
		const callbacks = makeCallbacks()

		const execPromise = runParallelTasksTool.execute(
			{ subtasks: [{ message: "task A" }, { message: "task B" }] },
			parent,
			callbacks,
		)

		await vi.waitFor(() => expect(provider.children.length).toBe(2))
		;(parent as any).abort = true
		;(parent as any).abortReason = "user_cancelled"
		parent.emit(RooCodeEventName.TaskAborted)
		await execPromise

		// Cancelled on purpose: no auto-resume injection.
		expect(addMessage).not.toHaveBeenCalled()
	})

	it("cleans up the TaskAborted listener after execution", async () => {
		const provider = makeFakeProvider()
		const parent = makeFakeParentTask(provider)
		const callbacks = makeCallbacks()

		const execPromise = runParallelTasksTool.execute(
			{ subtasks: [{ message: "task A" }, { message: "task B" }] },
			parent,
			callbacks,
		)

		await vi.waitFor(() => expect(provider.children.length).toBe(2))
		provider.children.forEach((c) => c.complete())
		await execPromise

		// Listener count for TaskAborted should be zero after execution.
		const emitter = parent as unknown as EventEmitter
		expect(emitter.listenerCount(RooCodeEventName.TaskAborted)).toBe(0)
	})

	it("passes a real approval policy (not blanket approve) to createBackgroundTask", async () => {
		// State: no commands auto-approved, so a command ask should be denied.
		const provider = makeFakeProvider({ autoApprovalEnabled: true, alwaysAllowExecute: false })
		const parent = makeFakeParentTask(provider)
		const callbacks = makeCallbacks()

		const execPromise = runParallelTasksTool.execute(
			{ subtasks: [{ message: "task A" }, { message: "task B" }] },
			parent,
			callbacks,
		)

		await vi.waitFor(() => expect(provider.children.length).toBe(2))
		provider.children.forEach((c) => c.complete())
		await execPromise

		expect(provider.createBackgroundTask).toHaveBeenCalledTimes(2)
		const opts = provider.createBackgroundTask.mock.calls[0][1] as {
			autoApprovalOverride?: (ask: string, text?: string, isProtected?: boolean) => Promise<string>
		}
		expect(typeof opts.autoApprovalOverride).toBe("function")

		// Read-only tool ask → approve (policy recognises reads as safe).
		const readOnlyTool = JSON.stringify({ tool: "readFile", path: "/anywhere" })
		expect(await opts.autoApprovalOverride!("tool", readOnlyTool, false)).toBe("approve")

		// Command ask with no allowed commands → undefined (delegates to
		// checkAutoApproval which returns "ask" when alwaysAllowExecute is
		// false; the ask then surfaces interactively in the subagents panel,
		// bounded by the TaskAskSay fallback which denies it unanswered).
		expect(await opts.autoApprovalOverride!("command", "rm -rf /tmp", false)).toBeUndefined()
	})

	// ---------------------------------------------------------------------------
	// parallelChildIds + subagents.json sidecar persistence
	// ---------------------------------------------------------------------------

	describe("parallel-subagent persistence", () => {
		it("records each child's taskId in the parent HistoryItem.parallelChildIds", async () => {
			const provider = makeFakeProvider()
			// Seed a parent HistoryItem so atomicReadAndUpdate has a record
			// to read; the fake provider auto-creates one if absent, but
			// seeding lets us assert the field was added, not created fresh.
			provider.historyItems.set("parent-12345678", {
				id: "parent-12345678",
				number: 1,
				ts: 0,
				task: "parent",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			})
			const parent = makeFakeParentTask(provider)
			const callbacks = makeCallbacks()

			const execPromise = runParallelTasksTool.execute(
				{ subtasks: [{ message: "task A" }, { message: "task B" }] },
				parent,
				callbacks,
			)

			await vi.waitFor(() => expect(provider.children.length).toBe(2))
			// Each child is spawned; the persistence call happens right
			// after createBackgroundTask, so by the time both children exist
			// both parallelChildIds writes should have fired.
			await vi.waitFor(() => expect(provider.atomicReadAndUpdateHistoryItem).toHaveBeenCalledTimes(2))
			provider.children.forEach((c) => c.complete())
			await execPromise

			const parentItem = provider.historyItems.get("parent-12345678") as Record<string, unknown>
			expect(parentItem.parallelChildIds).toBeDefined()
			const recorded = parentItem.parallelChildIds as string[]
			expect(recorded).toHaveLength(2)
			// Order: the first child spawned is recorded first. Both child
			// ids must be present (deduped).
			expect(recorded).toEqual(expect.arrayContaining([provider.children[0].taskId, provider.children[1].taskId]))
		})

		it("dedupes parallelChildIds (no duplicates even if the updater is called twice for the same id)", async () => {
			const provider = makeFakeProvider()
			const parent = makeFakeParentTask(provider)
			const callbacks = makeCallbacks()

			const execPromise = runParallelTasksTool.execute(
				{ subtasks: [{ message: "task A" }, { message: "task B" }] },
				parent,
				callbacks,
			)
			await vi.waitFor(() => expect(provider.children.length).toBe(2))
			provider.children.forEach((c) => c.complete())
			await execPromise

			// Two distinct children → two distinct ids, no duplicates.
			const parentItem = provider.historyItems.get("parent-12345678") as Record<string, unknown>
			const recorded = parentItem.parallelChildIds as string[]
			expect(recorded).toHaveLength(2)
			expect(new Set(recorded).size).toBe(2)

			// The updater itself uses Array.from(new Set(...)), so even a
			// pre-existing duplicate in the record is collapsed.
			const calls = provider.atomicReadAndUpdateHistoryItem.mock.calls as Array<[string, (c: any) => any]>
			const [, updater] = calls[0]
			const withDup = {
				id: "parent-12345678",
				number: 1,
				ts: 0,
				task: "p",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				parallelChildIds: ["dup", "dup"],
			} as any
			const after = updater(withDup)
			expect((after.parallelChildIds as string[]).filter((x) => x === "dup")).toHaveLength(1)
		})

		it("does NOT set status: delegated / awaitingChildId on the parent (parallel, not foreground delegation)", async () => {
			const provider = makeFakeProvider()
			provider.historyItems.set("parent-12345678", {
				id: "parent-12345678",
				number: 1,
				ts: 0,
				task: "parent",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "active",
			})
			const parent = makeFakeParentTask(provider)
			const callbacks = makeCallbacks()

			const execPromise = runParallelTasksTool.execute(
				{ subtasks: [{ message: "task A" }, { message: "task B" }] },
				parent,
				callbacks,
			)
			await vi.waitFor(() => expect(provider.children.length).toBe(2))
			provider.children.forEach((c) => c.complete())
			await execPromise

			const parentItem = provider.historyItems.get("parent-12345678") as Record<string, unknown>
			expect(parentItem.status).toBe("active")
			expect(parentItem.awaitingChildId).toBeUndefined()
			expect(parentItem.delegatedToId).toBeUndefined()
		})

		it("writes the subagents.json sidecar after the fan-out settles", async () => {
			const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rpt-sidecar-"))
			const provider = makeFakeProvider()
			provider.globalStoragePath = tmpRoot
			provider.subagentRegistry.snapshot.mockReturnValue([
				{
					taskId: "child-x",
					parentTaskId: "parent-12345678",
					index: 0,
					mode: "code",
					description: "task A",
					status: "completed",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					startedAt: 1,
					lastActivityAt: 2,
				},
			])
			const parent = makeFakeParentTask(provider)
			const callbacks = makeCallbacks()

			const execPromise = runParallelTasksTool.execute(
				{ subtasks: [{ message: "task A" }, { message: "task B" }] },
				parent,
				callbacks,
			)
			await vi.waitFor(() => expect(provider.children.length).toBe(2))
			provider.children.forEach((c) => c.complete())
			await execPromise

			// The sidecar is written at <tmpRoot>/tasks/<parentTaskId>/subagents.json
			const sidecarPath = path.join(tmpRoot, "tasks", "parent-12345678", "subagents.json")
			const exists = await fs
				.access(sidecarPath)
				.then(() => true)
				.catch(() => false)
			expect(exists).toBe(true)
			const raw = await fs.readFile(sidecarPath, "utf8")
			const parsed = JSON.parse(raw)
			expect(Array.isArray(parsed)).toBe(true)
			expect(parsed[0].taskId).toBe("child-x")
		})

		it("survives a sidecar write failure (best-effort, does not throw)", async () => {
			// Make globalStoragePath point at a FILE, not a directory, so
			// `getTaskDirectoryPath`'s `mkdir(<file>/tasks/<id>)` fails with
			// ENOTDIR. This deterministically exercises the best-effort error
			// handling in `persistSubagentSummariesSidecar` without invoking
			// real cross-process lock-file paths (which would hang on
			// unwritable dirs like /proc).
			const blocker = await fs.mkdtemp(path.join(os.tmpdir(), "rpt-block-"))
			const blockerFile = path.join(blocker, "i-am-a-file")
			await fs.writeFile(blockerFile, "", "utf8")
			const provider = makeFakeProvider()
			provider.globalStoragePath = blockerFile
			provider.subagentRegistry.snapshot.mockReturnValue([])
			const parent = makeFakeParentTask(provider)
			const callbacks = makeCallbacks()

			const execPromise = runParallelTasksTool.execute(
				{ subtasks: [{ message: "task A" }, { message: "task B" }] },
				parent,
				callbacks,
			)
			await vi.waitFor(() => expect(provider.children.length).toBe(2))
			provider.children.forEach((c) => c.complete())
			await execPromise

			// The sidecar write failed (ENOTDIR), but the tool still
			// completes normally and pushes its report.
			expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
			const report = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(report).toContain("2 completed")
		})

		it("survives an atomicReadAndUpdateHistoryItem failure (best-effort)", async () => {
			const provider = makeFakeProvider()
			provider.atomicReadAndUpdateHistoryItem.mockRejectedValue(new Error("store down"))
			const parent = makeFakeParentTask(provider)
			const callbacks = makeCallbacks()

			const execPromise = runParallelTasksTool.execute(
				{ subtasks: [{ message: "task A" }, { message: "task B" }] },
				parent,
				callbacks,
			)
			await vi.waitFor(() => expect(provider.children.length).toBe(2))
			provider.children.forEach((c) => c.complete())
			await execPromise

			// The fan-out completes despite the persistence failure; only
			// historical rehydration of this run would be affected.
			expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		})
	})

	// ---------------------------------------------------------------------------
	// Worktree cleanup tests
	// ---------------------------------------------------------------------------

	describe("worktree cleanup", () => {
		it("completed subtask with no changes and no commits → cleaned up", async () => {
			const provider = makeFakeProvider()
			const parent = makeFakeParentTask(provider)
			const callbacks = makeCallbacks()

			const execPromise = runParallelTasksTool.execute(
				{ subtasks: [{ message: "task A" }, { message: "task B" }] },
				parent,
				callbacks,
			)

			await vi.waitFor(() => expect(provider.children.length).toBe(2))
			provider.children.forEach((c) => c.complete())
			await execPromise

			expect(mockHasUncommittedChanges).toHaveBeenCalled()
			expect(mockBranchHasCommits).toHaveBeenCalled()
			expect(mockDeleteWorktree).toHaveBeenCalledWith(
				"/home/user/myproj",
				expect.stringContaining("myproj-parent-1"),
			)
			const report = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(report).toContain("cleaned up (no changes)")
			expect(report).toContain("2 completed")
		})

		it("completed subtask WITH commits → worktree kept", async () => {
			mockBranchHasCommits.mockResolvedValue(true)
			const provider = makeFakeProvider()
			const parent = makeFakeParentTask(provider)
			const callbacks = makeCallbacks()

			const execPromise = runParallelTasksTool.execute(
				{ subtasks: [{ message: "task A" }, { message: "task B" }] },
				parent,
				callbacks,
			)

			await vi.waitFor(() => expect(provider.children.length).toBe(2))
			provider.children.forEach((c) => c.complete())
			await execPromise

			expect(mockDeleteWorktree).not.toHaveBeenCalled()
			const report = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(report).not.toContain("cleaned up")
			expect(report).toContain("worktree:")
		})

		it("failed subtask with uncommitted changes → NOT deleted", async () => {
			mockHasUncommittedChanges.mockResolvedValue(true)
			const provider = makeFakeProvider()
			const parent = makeFakeParentTask(provider)
			const callbacks = makeCallbacks()

			const execPromise = runParallelTasksTool.execute(
				{ subtasks: [{ message: "task A" }, { message: "task B" }] },
				parent,
				callbacks,
			)

			await vi.waitFor(() => expect(provider.children.length).toBe(2))
			// Don't call complete() — child will resolve as not-completed when signal fires.
			// Instead, user-cancel the parent to make the child resolve.
			;(parent as any).abortReason = "user_cancelled"
			parent.emit(RooCodeEventName.TaskAborted)
			await execPromise

			expect(mockDeleteWorktree).not.toHaveBeenCalled()
			const report = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(report).not.toContain("cleaned up")
		})

		it("failed subtask clean + commitless → deleted", async () => {
			const provider = makeFakeProvider()
			const parent = makeFakeParentTask(provider)
			const callbacks = makeCallbacks()

			const execPromise = runParallelTasksTool.execute(
				{ subtasks: [{ message: "task A" }, { message: "task B" }] },
				parent,
				callbacks,
			)

			await vi.waitFor(() => expect(provider.children.length).toBe(2))
			;(parent as any).abortReason = "user_cancelled"
			parent.emit(RooCodeEventName.TaskAborted)
			await execPromise

			expect(mockDeleteWorktree).toHaveBeenCalled()
			const report = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(report).toContain("cleaned up (no changes)")
		})

		it("deleteWorktree returning success:false → cleaned falsy, no throw", async () => {
			mockDeleteWorktree.mockResolvedValue({ success: false, message: "busy" })
			const provider = makeFakeProvider()
			const parent = makeFakeParentTask(provider)
			const callbacks = makeCallbacks()

			const execPromise = runParallelTasksTool.execute(
				{ subtasks: [{ message: "task A" }, { message: "task B" }] },
				parent,
				callbacks,
			)

			await vi.waitFor(() => expect(provider.children.length).toBe(2))
			provider.children.forEach((c) => c.complete())
			await execPromise

			// Should not throw, status still completed.
			const report = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(report).toContain("2 completed")
			expect(report).not.toContain("cleaned up")
			expect(report).toContain("worktree:")
		})
	})
})
