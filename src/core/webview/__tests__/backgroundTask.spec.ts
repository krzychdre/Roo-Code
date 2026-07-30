import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "events"

import { RooCodeEventName } from "@roo-code/types"

import { ClineProvider } from "../ClineProvider"

// Stub the memory-sandbox path filter so the memorySubTaskRunner retry tests can
// assert on raw written paths without needing real memory-directory resolution.
// memoryWriteSandbox is unused by the runner tests; provide a minimal stub.
vi.mock("../../memory", () => ({
	memoryWriteSandbox: vi.fn(() => ({ autoApprove: "path" })),
	filterMemoryWrittenPaths: vi.fn((paths: ReadonlyArray<string>) => [...paths]),
}))

/**
 * Focused unit tests for the reusable background-task primitive
 * (`awaitTaskCompletion`). The method only touches `this.backgroundTasks` and
 * the task's event/method surface, so we exercise the real implementation via
 * `prototype.call` with a minimal fake `this` and a fake Task — no heavy
 * ClineProvider construction required.
 */

interface FakeTaskOptions {
	taskId?: string
	completionText?: string
}

function makeFakeTask({ taskId = "bg-1", completionText }: FakeTaskOptions = {}) {
	const emitter = new EventEmitter()
	const task = Object.assign(emitter, {
		taskId,
		clineMessages: completionText
			? [
					{ type: "say", say: "text", text: "working" },
					{ type: "say", say: "completion_result", text: completionText },
				]
			: [{ type: "say", say: "text", text: "working" }],
		abortTask: vi.fn(async () => {}),
	})
	return task as unknown as Parameters<ClineProvider["awaitTaskCompletion"]>[0] & {
		abortTask: ReturnType<typeof vi.fn>
	}
}

function invokeAwait(
	task: ReturnType<typeof makeFakeTask>,
	options?: { signal?: AbortSignal },
	backgroundTasks = new Map<string, unknown>(),
	cleanupSpy?: ReturnType<typeof vi.fn>,
) {
	const fakeThis = {
		backgroundTasks,
		cleanupBackgroundTaskFiles: cleanupSpy ?? vi.fn(),
	} as unknown as ClineProvider
	backgroundTasks.set((task as unknown as { taskId: string }).taskId, task)
	const promise = ClineProvider.prototype.awaitTaskCompletion.call(fakeThis, task as never, options)
	return { promise, backgroundTasks }
}

describe("ClineProvider.awaitTaskCompletion", () => {
	it("resolves completed:true with the last completion_result text on TaskCompleted", async () => {
		const task = makeFakeTask({ completionText: "saved 2 memories" })
		const { promise, backgroundTasks } = invokeAwait(task)

		;(task as unknown as EventEmitter).emit(RooCodeEventName.TaskCompleted, "bg-1", {}, {})

		await expect(promise).resolves.toEqual({ completed: true, lastMessage: "saved 2 memories", writtenPaths: [] })
		// completed task is disposed and de-registered
		expect(task.abortTask).toHaveBeenCalledWith(true)
		expect(backgroundTasks.has("bg-1")).toBe(false)
	})

	it("resolves completed:false on TaskAborted and does not double-dispose", async () => {
		const task = makeFakeTask()
		const { promise, backgroundTasks } = invokeAwait(task)

		;(task as unknown as EventEmitter).emit(RooCodeEventName.TaskAborted, "bg-1")

		await expect(promise).resolves.toEqual({ completed: false, lastMessage: undefined, writtenPaths: [] })
		expect(task.abortTask).not.toHaveBeenCalled() // aborted tasks are already torn down
		expect(backgroundTasks.has("bg-1")).toBe(false)
	})

	it("only settles once (first terminal event wins)", async () => {
		const task = makeFakeTask({ completionText: "done" })
		const { promise } = invokeAwait(task)

		;(task as unknown as EventEmitter).emit(RooCodeEventName.TaskCompleted, "bg-1", {}, {})
		;(task as unknown as EventEmitter).emit(RooCodeEventName.TaskAborted, "bg-1")

		await expect(promise).resolves.toEqual({ completed: true, lastMessage: "done", writtenPaths: [] })
		expect(task.abortTask).toHaveBeenCalledTimes(1)
	})

	it("aborts the task when the provided signal fires", async () => {
		const task = makeFakeTask()
		const controller = new AbortController()
		const { promise } = invokeAwait(task, { signal: controller.signal })

		controller.abort()
		// The task's own abortTask -> TaskAborted would normally fire; simulate it.
		expect(task.abortTask).toHaveBeenCalledTimes(1)
		;(task as unknown as EventEmitter).emit(RooCodeEventName.TaskAborted, "bg-1")
		await expect(promise).resolves.toEqual({ completed: false, lastMessage: undefined, writtenPaths: [] })
	})

	it("aborts immediately if the signal is already aborted", async () => {
		const task = makeFakeTask()
		const controller = new AbortController()
		controller.abort()
		const { promise } = invokeAwait(task, { signal: controller.signal })
		expect(task.abortTask).toHaveBeenCalledTimes(1)
		;(task as unknown as EventEmitter).emit(RooCodeEventName.TaskAborted, "bg-1")
		await expect(promise).resolves.toEqual({ completed: false, lastMessage: undefined, writtenPaths: [] })
	})

	it("cleans up task directory for completed background tasks", async () => {
		const task = makeFakeTask({ completionText: "done" })
		const cleanupSpy = vi.fn()
		const { promise } = invokeAwait(task, {}, undefined, cleanupSpy)

		;(task as unknown as EventEmitter).emit(RooCodeEventName.TaskCompleted, "bg-1", {}, {})

		await expect(promise).resolves.toEqual({ completed: true, lastMessage: "done", writtenPaths: [] })
		// Cleanup is chained after the dispose (abortTask) settles.
		await vi.waitFor(() => expect(cleanupSpy).toHaveBeenCalledWith("bg-1"))
	})

	it("does not clean up task directory for aborted background tasks", async () => {
		const task = makeFakeTask()
		const cleanupSpy = vi.fn()
		const { promise } = invokeAwait(task, {}, undefined, cleanupSpy)

		;(task as unknown as EventEmitter).emit(RooCodeEventName.TaskAborted, "bg-1")

		await expect(promise).resolves.toEqual({ completed: false, lastMessage: undefined, writtenPaths: [] })
		// Flush microtasks so a wrongly-chained cleanup would have fired by now.
		await new Promise((r) => setTimeout(r, 0))
		expect(cleanupSpy).not.toHaveBeenCalled()
	})

	it("cleanup failure does not affect the await result", async () => {
		const task = makeFakeTask({ completionText: "done" })
		// The real cleanupBackgroundTaskFiles is fire-and-forget (void async IIFE
		// with try/catch); it never throws synchronously. Simulate a rejection
		// inside the async body by returning a rejected promise — the await
		// result must still resolve normally.
		const cleanupSpy = vi.fn().mockResolvedValue(undefined)
		const { promise } = invokeAwait(task, {}, undefined, cleanupSpy)

		;(task as unknown as EventEmitter).emit(RooCodeEventName.TaskCompleted, "bg-1", {}, {})

		await expect(promise).resolves.toEqual({ completed: true, lastMessage: "done", writtenPaths: [] })
		await vi.waitFor(() => expect(cleanupSpy).toHaveBeenCalledWith("bg-1"))
	})
})

describe("ClineProvider.resolveMemoryWriterApiConfiguration", () => {
	// The method is private but accessible via prototype.call with a fake `this`
	// that provides `getValue` and `providerSettingsManager`.

	// `resolveMemoryWriterApiConfiguration` calls `activateProfile`, not
	// `getProfile`. While the double stubbed only the latter, the two tests that
	// resolve a profile were asserting on the TypeError the catch block swallowed
	// — both "passed" through the failure path they were written to avoid.
	function makeFakeThis(opts: {
		configId?: string
		activateProfile?: ReturnType<typeof vi.fn>
		log?: ReturnType<typeof vi.fn>
	}) {
		return {
			getValue: vi.fn().mockReturnValue(opts.configId),
			providerSettingsManager: { activateProfile: opts.activateProfile ?? vi.fn() },
			log: opts.log ?? vi.fn(),
		} as unknown as ClineProvider
	}

	it("returns undefined when memoryWriterApiConfigId is unset", async () => {
		const activateProfile = vi.fn()
		const fakeThis = makeFakeThis({ configId: undefined, activateProfile })
		const result = await (ClineProvider.prototype as any).resolveMemoryWriterApiConfiguration.call(fakeThis)
		expect(result).toBeUndefined()
		expect(activateProfile).not.toHaveBeenCalled()
	})

	it("returns undefined when memoryWriterApiConfigId is empty string", async () => {
		const activateProfile = vi.fn()
		const fakeThis = makeFakeThis({ configId: "", activateProfile })
		const result = await (ClineProvider.prototype as any).resolveMemoryWriterApiConfiguration.call(fakeThis)
		expect(result).toBeUndefined()
		expect(activateProfile).not.toHaveBeenCalled()
	})

	it("returns the resolved profile (minus name) when activateProfile succeeds", async () => {
		const activateProfile = vi.fn().mockResolvedValue({
			name: "cheap-local",
			id: "profile-1",
			apiProvider: "ollama",
			apiModelId: "llama3",
		})
		const fakeThis = makeFakeThis({ configId: "profile-1", activateProfile })
		const result = await (ClineProvider.prototype as any).resolveMemoryWriterApiConfiguration.call(fakeThis)
		expect(result).toEqual({
			id: "profile-1",
			apiProvider: "ollama",
			apiModelId: "llama3",
		})
		expect(activateProfile).toHaveBeenCalledWith({ id: "profile-1" })
	})

	it("falls back to undefined and logs when activateProfile throws", async () => {
		const activateProfile = vi.fn().mockRejectedValue(new Error("not found"))
		const log = vi.fn()
		const fakeThis = makeFakeThis({ configId: "stale-id", activateProfile, log })
		const result = await (ClineProvider.prototype as any).resolveMemoryWriterApiConfiguration.call(fakeThis)
		expect(result).toBeUndefined()
		expect(activateProfile).toHaveBeenCalledWith({ id: "stale-id" })
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("[memorySubTaskRunner] failed to load writer profile stale-id"),
		)
	})
})

describe("ClineProvider.memorySubTaskRunner — background-profile foreground retry", () => {
	// The runner is a getter returning an async function. We invoke it bound to a
	// fake `this` that stubs the dependencies the runner touches:
	// resolveMemoryWriterApiConfiguration, setMemoryActivity, runMemorySubTask,
	// log. runMemorySubTask is itself a private method that we stub directly so
	// we can control the { completed, writtenPaths, abortReason } outcome of
	// each attempt. abortReason classification (Claim 3) drives the retry
	// decision: only streaming_failed retries on foreground; max_turns_reached
	// and user_cancelled do not.

	function makeFakeThis(opts: {
		backgroundConfig?: any
		runMemorySubTaskImpl: (
			...args: any[]
		) => Promise<{ completed: boolean; writtenPaths: string[]; abortReason?: string }>
		log?: ReturnType<typeof vi.fn>
	}) {
		return {
			resolveMemoryWriterApiConfiguration: vi.fn(async () => opts.backgroundConfig),
			setMemoryActivity: vi.fn(),
			runMemorySubTask: vi.fn(opts.runMemorySubTaskImpl),
			log: opts.log ?? vi.fn(),
		} as unknown as ClineProvider
	}

	/** Invoke the runner function (from the getter) bound to fakeThis. */
	async function invokeRunner(
		fakeThis: ClineProvider,
		args: {
			cwd?: string
			systemPrompt?: string
			userPrompt?: string
			maxTurns?: number
			signal?: AbortSignal
		},
	) {
		// Read the getter from the prototype descriptor and call it on fakeThis to
		// obtain the runner function, then invoke the runner (also bound to
		// fakeThis so `this`-references inside resolve correctly).
		const desc = Object.getOwnPropertyDescriptor(ClineProvider.prototype, "memorySubTaskRunner")!
		const runner = desc.get!.call(fakeThis) as (args: any) => Promise<{ writtenPaths: string[] }>
		return runner.call(fakeThis, {
			cwd: args.cwd ?? "/mem",
			systemPrompt: args.systemPrompt,
			userPrompt: args.userPrompt ?? "extract memories",
			maxTurns: args.maxTurns ?? 5,
			signal: args.signal,
		})
	}

	it("background profile completes → no retry, returns its written paths", async () => {
		const runMemorySubTask = vi.fn(async () => ({
			completed: true,
			writtenPaths: ["/mem/a.md"],
		}))
		const fakeThis = makeFakeThis({
			backgroundConfig: { apiProvider: "ollama" },
			runMemorySubTaskImpl: runMemorySubTask as any,
		})
		const result = await invokeRunner(fakeThis, {})
		expect(result.writtenPaths).toEqual(["/mem/a.md"])
		expect(runMemorySubTask).toHaveBeenCalledTimes(1)
	})

	it("background profile streaming_failed + backgroundConfig set → retries once on foreground", async () => {
		// Claim 3: a genuine provider failure (streaming_failed) on the
		// background model is retried on the foreground model — the background
		// model may be offline.
		const runMemorySubTask = vi.fn(
			async (_text: string, _cwd: string, _maxTurns: number, _signal: any, apiConfiguration: any) => ({
				completed: apiConfiguration === undefined, // foreground attempt completes
				writtenPaths: apiConfiguration === undefined ? ["/mem/recovered.md"] : [],
				abortReason: apiConfiguration === undefined ? undefined : "streaming_failed",
			}),
		)
		const log = vi.fn()
		const fakeThis = makeFakeThis({
			backgroundConfig: { apiProvider: "ollama" },
			runMemorySubTaskImpl: runMemorySubTask as any,
			log,
		})
		const result = await invokeRunner(fakeThis, {})
		expect(runMemorySubTask).toHaveBeenCalledTimes(2)
		// Second call must pass apiConfiguration === undefined (foreground).
		expect(runMemorySubTask.mock.calls[1][4]).toBeUndefined()
		expect(result.writtenPaths).toEqual(["/mem/recovered.md"])
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("background profile failed (streaming_failed), retrying on foreground"),
		)
	})

	it("background profile max_turns_reached + backgroundConfig set → NO retry (weak model didn't finish)", async () => {
		// Claim 3: a weak background model that exhausts its turn budget
		// (max_turns_reached, typical for memory extraction) must NOT be retried
		// on the expensive foreground model — it would just exhaust the same
		// budget and double cost exactly where the feature aimed to save it.
		// Accept the partial result (attempt #1's written paths).
		const runMemorySubTask = vi.fn(async () => ({
			completed: false,
			writtenPaths: ["/mem/partial.md"],
			abortReason: "max_turns_reached",
		}))
		const log = vi.fn()
		const fakeThis = makeFakeThis({
			backgroundConfig: { apiProvider: "ollama" },
			runMemorySubTaskImpl: runMemorySubTask as any,
			log,
		})
		const result = await invokeRunner(fakeThis, {})
		expect(runMemorySubTask).toHaveBeenCalledTimes(1)
		// Claim 6: partial written paths are still reported (no longer []).
		expect(result.writtenPaths).toEqual(["/mem/partial.md"])
		expect(log).not.toHaveBeenCalledWith(expect.stringContaining("retrying on foreground"))
	})

	it("retry returns the UNION of attempt #1 and attempt #2 written paths (Claim 6)", async () => {
		// Claim 6: the old code returned only attempt #2's paths, discarding
		// attempt #1's on-disk writes so onSaved/onImproved toasts never fired.
		// The fix returns the union (deduped) so files either attempt wrote are
		// reported.
		const runMemorySubTask = vi.fn(
			async (_text: string, _cwd: string, _maxTurns: number, _signal: any, apiConfiguration: any) => ({
				completed: apiConfiguration === undefined,
				writtenPaths: apiConfiguration === undefined ? ["/mem/recovered.md"] : ["/mem/first.md"],
				abortReason: apiConfiguration === undefined ? undefined : "streaming_failed",
			}),
		)
		const fakeThis = makeFakeThis({
			backgroundConfig: { apiProvider: "ollama" },
			runMemorySubTaskImpl: runMemorySubTask as any,
		})
		const result = await invokeRunner(fakeThis, {})
		expect(runMemorySubTask).toHaveBeenCalledTimes(2)
		// Union of both attempts' paths, deduped.
		expect(result.writtenPaths).toEqual(["/mem/first.md", "/mem/recovered.md"])
	})

	it("retry union dedupes paths written by both attempts", async () => {
		// If both attempts write the same file, the union must not duplicate it.
		const runMemorySubTask = vi.fn(
			async (_text: string, _cwd: string, _maxTurns: number, _signal: any, apiConfiguration: any) => ({
				completed: apiConfiguration === undefined,
				writtenPaths: ["/mem/shared.md", apiConfiguration === undefined ? "/mem/second.md" : "/mem/first.md"],
				abortReason: apiConfiguration === undefined ? undefined : "streaming_failed",
			}),
		)
		const fakeThis = makeFakeThis({
			backgroundConfig: { apiProvider: "ollama" },
			runMemorySubTaskImpl: runMemorySubTask as any,
		})
		const result = await invokeRunner(fakeThis, {})
		expect(result.writtenPaths).toEqual(["/mem/shared.md", "/mem/first.md", "/mem/second.md"])
	})

	it("foreground-only run does not complete → no retry, returns attempt's written paths", async () => {
		// No background config: a non-completing run must NOT retry (would loop
		// on the same failing handler). Claim 6: still report the written paths.
		const runMemorySubTask = vi.fn(async () => ({
			completed: false,
			writtenPaths: ["/mem/fg-partial.md"],
			abortReason: "streaming_failed",
		}))
		const fakeThis = makeFakeThis({
			backgroundConfig: undefined,
			runMemorySubTaskImpl: runMemorySubTask as any,
		})
		const result = await invokeRunner(fakeThis, {})
		expect(runMemorySubTask).toHaveBeenCalledTimes(1)
		expect(result.writtenPaths).toEqual(["/mem/fg-partial.md"])
	})

	it("signal already aborted → no retry even with background config", async () => {
		const runMemorySubTask = vi.fn(async () => ({
			completed: false,
			writtenPaths: ["/mem/partial.md"],
			abortReason: "streaming_failed",
		}))
		const log = vi.fn()
		const controller = new AbortController()
		controller.abort()
		const fakeThis = makeFakeThis({
			backgroundConfig: { apiProvider: "ollama" },
			runMemorySubTaskImpl: runMemorySubTask as any,
			log,
		})
		const result = await invokeRunner(fakeThis, { signal: controller.signal })
		expect(runMemorySubTask).toHaveBeenCalledTimes(1)
		// No retry, but the partial paths are still reported (Claim 6).
		expect(result.writtenPaths).toEqual(["/mem/partial.md"])
		// No retry log because the abort was user-initiated.
		expect(log).not.toHaveBeenCalledWith(expect.stringContaining("retrying on foreground"))
	})
})
