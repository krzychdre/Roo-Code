// npx vitest run core/webview/__tests__/rehydrateSubagents.spec.ts

import type { HistoryItem } from "@roo-code/types"

import { ClineProvider } from "../ClineProvider"

const loadSubagentSummaries = vi.fn()

vi.mock("../../task-persistence/subagentSummariesStore", () => ({
	loadSubagentSummaries: (...args: unknown[]) => loadSubagentSummaries(...args),
}))

/**
 * `rehydrateSubagents` restores the parallel-subagent panel when a task is
 * reopened from history. It had no coverage of its own, which is how the
 * provider doubles in the resume specs came to be missing it entirely — the
 * only thing that ever exercised it was those tests, indirectly, and they broke
 * with "is not a function" rather than with anything about subagents.
 */
describe("ClineProvider.rehydrateSubagents", () => {
	function makeFakeThis(overrides: Record<string, unknown> = {}) {
		return {
			contextProxy: { globalStorageUri: { fsPath: "/tmp/storage" } },
			subagentRegistry: {
				restore: vi.fn(),
				list: vi.fn().mockReturnValue([{ taskId: "child-a" }]),
			},
			getCurrentTask: vi.fn().mockReturnValue({ taskId: "parent-1" }),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			...overrides,
		}
	}

	const historyItem = (parallelChildIds?: string[]) =>
		({ id: "parent-1", parallelChildIds }) as unknown as HistoryItem

	const rehydrate = (fakeThis: unknown, item: HistoryItem) =>
		(ClineProvider.prototype as any).rehydrateSubagents.call(fakeThis, item)

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("does nothing for a task that never fanned out", async () => {
		const fakeThis = makeFakeThis()

		await rehydrate(fakeThis, historyItem(undefined))

		expect(loadSubagentSummaries).not.toHaveBeenCalled()
		expect(fakeThis.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("does nothing for an empty child list", async () => {
		const fakeThis = makeFakeThis()

		await rehydrate(fakeThis, historyItem([]))

		expect(loadSubagentSummaries).not.toHaveBeenCalled()
	})

	it("restores the children the task actually spawned, and posts them", async () => {
		loadSubagentSummaries.mockResolvedValue([{ taskId: "child-a" }, { taskId: "child-b" }])
		const fakeThis = makeFakeThis()

		await rehydrate(fakeThis, historyItem(["child-a", "child-b"]))

		expect(loadSubagentSummaries).toHaveBeenCalledWith("/tmp/storage", "parent-1")
		expect(fakeThis.subagentRegistry.restore).toHaveBeenCalledWith("parent-1", [
			{ taskId: "child-a" },
			{ taskId: "child-b" },
		])
		expect(fakeThis.postMessageToWebview).toHaveBeenCalledWith({
			type: "subagentsUpdated",
			sourceTaskId: "parent-1",
			subagents: [{ taskId: "child-a" }],
		})
	})

	it("drops a summary the parent never listed, so a half-written sidecar cannot invent rows", async () => {
		loadSubagentSummaries.mockResolvedValue([{ taskId: "child-a" }, { taskId: "child-from-a-crashed-run" }])
		const fakeThis = makeFakeThis()

		await rehydrate(fakeThis, historyItem(["child-a"]))

		expect(fakeThis.subagentRegistry.restore).toHaveBeenCalledWith("parent-1", [{ taskId: "child-a" }])
	})

	it("survives an unreadable sidecar — restoring the parent must not depend on it", async () => {
		loadSubagentSummaries.mockRejectedValue(new Error("ENOENT"))
		const fakeThis = makeFakeThis()

		await expect(rehydrate(fakeThis, historyItem(["child-a"]))).resolves.toBeUndefined()
		expect(fakeThis.log).toHaveBeenCalledWith(expect.stringContaining("[rehydrateSubagents]"))
		expect(fakeThis.postMessageToWebview).not.toHaveBeenCalled()
	})
})
