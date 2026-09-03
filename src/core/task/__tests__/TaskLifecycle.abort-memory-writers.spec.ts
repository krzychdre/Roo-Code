// npx vitest run core/task/__tests__/TaskLifecycle.abort-memory-writers.spec.ts

// Regression test for the Stop-button regression introduced with the memory
// background writers. `ClineProvider.cancelTask()` sets
// `task.abortReason = "user_cancelled"` and then calls `abortTask()`. Before
// the fix, `abortTask()`:
//   1. fired `triggerMemoryBackgroundWriters()` — which spawns a headless
//      sub-task that sends a FRESH LLM request, putting the inference engine
//      right back to work the moment the user pressed Stop, and
//   2. awaited `drainPendingExtraction(60_000)` — the stream loop awaits
//      `abortTask()` (TaskApiLoop.handleStreamError), so the drain held
//      `isStreaming === true` past cancelTask's 3s pWaitFor and froze the UI.
//
// The fix skips both when `abortReason === "user_cancelled"`. Non-cancelled
// aborts keep the previous behavior.

import { describe, it, expect, vi, beforeEach } from "vitest"

import { TaskLifecycle, type TaskLifecycleAccess } from "../TaskLifecycle"

vi.mock("../../memory", () => ({
	executeExtractMemories: vi.fn().mockResolvedValue(undefined),
	executeAutoDream: vi.fn().mockResolvedValue(undefined),
	drainPendingExtraction: vi.fn().mockResolvedValue(undefined),
	drainPendingDreams: vi.fn().mockResolvedValue(undefined),
	renderTranscript: vi.fn().mockReturnValue(""),
	// The trigger gates on the master switch before doing any work; keep it
	// open here so the writer spies below actually get called.
	isAutoMemoryEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string, opts?: Record<string, unknown>) => {
		const count = opts?.count
		return count !== undefined ? `${key} ${count}` : key
	}),
}))

import { executeExtractMemories, executeAutoDream, drainPendingExtraction, drainPendingDreams } from "../../memory"
import { logger } from "../../../utils/logging"

function buildAccessStub(overrides: Partial<TaskLifecycleAccess> = {}): TaskLifecycleAccess {
	const provider = {
		memorySubTaskRunner: vi.fn(),
		getValue: vi.fn().mockReturnValue(undefined),
		getTaskHistory: vi.fn().mockResolvedValue([]),
		notifyBackgroundOutcome: vi.fn(),
	}

	const access: Partial<TaskLifecycleAccess> = {
		taskId: "task-1",
		instanceId: "inst-1",
		isInitialized: true,
		abort: false,
		abandoned: false,
		abortReason: undefined,
		isBackground: false,
		parentTaskId: undefined,
		clineMessages: [],
		apiConversationHistory: [],
		consecutiveNoToolUseCount: 0,
		consecutiveNoAssistantMessagesCount: 0,
		cwd: "/tmp/task-cwd",
		providerRef: { deref: () => provider } as unknown as TaskLifecycleAccess["providerRef"],
		emit: vi.fn() as unknown as TaskLifecycleAccess["emit"],
		emitFinalTokenUsageUpdate: vi.fn(),
		cancelCurrentRequest: vi.fn(),
		history: {
			saveClineMessages: vi.fn().mockResolvedValue(undefined),
		} as unknown as TaskLifecycleAccess["history"],
		...overrides,
	}
	return access as TaskLifecycleAccess
}

describe("TaskLifecycle.abortTask — memory writers vs user cancel", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("does NOT fire memory writers and does NOT drain when abortReason is user_cancelled", async () => {
		const access = buildAccessStub({ abortReason: "user_cancelled" })
		const lifecycle = new TaskLifecycle(access)

		await lifecycle.abortTask()

		expect(executeExtractMemories).not.toHaveBeenCalled()
		expect(executeAutoDream).not.toHaveBeenCalled()
		expect(drainPendingExtraction).not.toHaveBeenCalled()
		expect(drainPendingDreams).not.toHaveBeenCalled()
		expect(access.abort).toBe(true)
	})

	it("fires memory writers and drains on a non-cancelled abort", async () => {
		const access = buildAccessStub()
		const lifecycle = new TaskLifecycle(access)

		await lifecycle.abortTask()

		expect(executeExtractMemories).toHaveBeenCalledTimes(1)
		expect(executeAutoDream).toHaveBeenCalledTimes(1)
		expect(drainPendingExtraction).toHaveBeenCalledTimes(1)
		expect(drainPendingDreams).toHaveBeenCalledTimes(1)
	})

	it("catches and logs rejected writer triggers instead of leaking unhandled rejections", async () => {
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {})
		try {
			vi.mocked(executeExtractMemories).mockRejectedValueOnce(new Error("memory paths not initialized"))
			vi.mocked(executeAutoDream).mockRejectedValueOnce(new Error("memory paths not initialized"))
			const access = buildAccessStub()
			const lifecycle = new TaskLifecycle(access)

			await lifecycle.abortTask()
			// Give the rejected fire-and-forget promises a macrotask to settle.
			await new Promise((resolve) => setTimeout(resolve, 0))

			// Both triggers rejected; both rejections must have been caught + logged.
			expect(errorSpy).toHaveBeenCalledTimes(2)
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("memory paths not initialized"))
		} finally {
			errorSpy.mockRestore()
		}
	})

	it("keeps skipping writers for abandoned aborts (pre-existing behavior)", async () => {
		const access = buildAccessStub()
		const lifecycle = new TaskLifecycle(access)

		await lifecycle.abortTask(true)

		expect(executeExtractMemories).not.toHaveBeenCalled()
		expect(executeAutoDream).not.toHaveBeenCalled()
		// Drain still runs for abandoned aborts — that path covers extension
		// shutdown, where orphaning in-flight extraction is the concern.
		expect(drainPendingExtraction).toHaveBeenCalledTimes(1)
		expect(drainPendingDreams).toHaveBeenCalledTimes(1)
		expect(access.abandoned).toBe(true)
	})
})

describe("TaskLifecycle.abortTask — background tasks skip writers and drain", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("does NOT fire memory writers and does NOT drain when isBackground is true", async () => {
		const access = buildAccessStub({ isBackground: true })
		const lifecycle = new TaskLifecycle(access)

		await lifecycle.abortTask()

		expect(executeExtractMemories).not.toHaveBeenCalled()
		expect(executeAutoDream).not.toHaveBeenCalled()
		expect(drainPendingExtraction).not.toHaveBeenCalled()
		expect(drainPendingDreams).not.toHaveBeenCalled()
		expect(access.abort).toBe(true)
	})

	it("does NOT fire memory writers or drain when isBackground is true even if not user-cancelled", async () => {
		// Belt-and-suspenders: isBackground guard must be independent of
		// the isUserCancelled guard. A background task aborted via
		// maxAgentTurns has no abortReason set, so the isUserCancelled
		// check alone would let writers fire.
		const access = buildAccessStub({ isBackground: true, abortReason: undefined })
		const lifecycle = new TaskLifecycle(access)

		await lifecycle.abortTask()

		expect(executeExtractMemories).not.toHaveBeenCalled()
		expect(executeAutoDream).not.toHaveBeenCalled()
		expect(drainPendingExtraction).not.toHaveBeenCalled()
		expect(drainPendingDreams).not.toHaveBeenCalled()
	})

	it("fires memory writers and drains when isBackground is false (foreground regression guard)", async () => {
		const access = buildAccessStub({ isBackground: false })
		const lifecycle = new TaskLifecycle(access)

		await lifecycle.abortTask()

		expect(executeExtractMemories).toHaveBeenCalledTimes(1)
		expect(executeAutoDream).toHaveBeenCalledTimes(1)
		expect(drainPendingExtraction).toHaveBeenCalledTimes(1)
		expect(drainPendingDreams).toHaveBeenCalledTimes(1)
	})
})

describe("TaskLifecycle.triggerMemoryBackgroundWriters — visibility toasts", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("onSaved(2, ...) calls notifyBackgroundOutcome with a string containing '2'", async () => {
		const access = buildAccessStub()
		const lifecycle = new TaskLifecycle(access)

		lifecycle.triggerMemoryBackgroundWriters()

		expect(executeExtractMemories).toHaveBeenCalledTimes(1)
		const opts = (executeExtractMemories as ReturnType<typeof vi.fn>).mock.calls[0][0]
		opts.onSaved(2, [])

		const provider = access.providerRef.deref() as unknown as { notifyBackgroundOutcome: ReturnType<typeof vi.fn> }
		expect(provider.notifyBackgroundOutcome).toHaveBeenCalledTimes(1)
		expect(provider.notifyBackgroundOutcome.mock.calls[0][0]).toContain("2")
	})

	it("passes task history from TaskHistoryStore to auto-dream", async () => {
		const access = buildAccessStub()
		const provider = access.providerRef.deref() as unknown as {
			getTaskHistory: ReturnType<typeof vi.fn>
		}
		provider.getTaskHistory.mockResolvedValue([{ id: "stored-task", ts: 1234 }])

		new TaskLifecycle(access).triggerMemoryBackgroundWriters()
		await vi.waitFor(() => expect(executeAutoDream).toHaveBeenCalledTimes(1))

		const opts = (executeAutoDream as ReturnType<typeof vi.fn>).mock.calls[0][0]
		expect(opts.taskHistory).toEqual([{ lastModified: 1234 }])
	})

	it("onSaved(0, []) does not call notifyBackgroundOutcome", async () => {
		const access = buildAccessStub()
		const lifecycle = new TaskLifecycle(access)

		lifecycle.triggerMemoryBackgroundWriters()

		const opts = (executeExtractMemories as ReturnType<typeof vi.fn>).mock.calls[0][0]
		opts.onSaved(0, [])

		const provider = access.providerRef.deref() as unknown as { notifyBackgroundOutcome: ReturnType<typeof vi.fn> }
		expect(provider.notifyBackgroundOutcome).not.toHaveBeenCalled()
	})

	it("onImproved(3, ...) calls notifyBackgroundOutcome with a string containing '3'", async () => {
		const access = buildAccessStub()
		const lifecycle = new TaskLifecycle(access)

		lifecycle.triggerMemoryBackgroundWriters()

		await vi.waitFor(() => expect(executeAutoDream).toHaveBeenCalledTimes(1))
		const opts = (executeAutoDream as ReturnType<typeof vi.fn>).mock.calls[0][0]
		opts.onImproved(3)

		const provider = access.providerRef.deref() as unknown as { notifyBackgroundOutcome: ReturnType<typeof vi.fn> }
		expect(provider.notifyBackgroundOutcome).toHaveBeenCalledTimes(1)
		expect(provider.notifyBackgroundOutcome.mock.calls[0][0]).toContain("3")
	})

	it("onImproved(0) does not call notifyBackgroundOutcome", async () => {
		const access = buildAccessStub()
		const lifecycle = new TaskLifecycle(access)

		lifecycle.triggerMemoryBackgroundWriters()
		await vi.waitFor(() => expect(executeAutoDream).toHaveBeenCalledTimes(1))

		const opts = (executeAutoDream as ReturnType<typeof vi.fn>).mock.calls[0][0]
		opts.onImproved(0)

		const provider = access.providerRef.deref() as unknown as { notifyBackgroundOutcome: ReturnType<typeof vi.fn> }
		expect(provider.notifyBackgroundOutcome).not.toHaveBeenCalled()
	})
})
