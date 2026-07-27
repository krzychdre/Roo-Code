import type { ExtensionMessage, SubagentSummary } from "@roo-code/types"

import { SubagentRegistry, queuedSubagentId } from "../SubagentRegistry"

function makeSummary(overrides: Partial<SubagentSummary> = {}): SubagentSummary {
	return {
		taskId: "task-1",
		parentTaskId: "parent-1",
		index: 0,
		mode: "ask",
		description: "subtask description",
		status: "running",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		startedAt: 1,
		lastActivityAt: 1,
		...overrides,
	}
}

describe("SubagentRegistry", () => {
	let posted: ExtensionMessage[]
	let registry: SubagentRegistry

	beforeEach(() => {
		posted = []
		registry = new SubagentRegistry((message) => posted.push(message))
	})

	it("posts subagentsUpdated with the full list on register", () => {
		registry.register(makeSummary())
		expect(posted).toHaveLength(1)
		expect(posted[0].type).toBe("subagentsUpdated")
		expect(posted[0].subagents).toHaveLength(1)
		expect(posted[0].subagents?.[0].taskId).toBe("task-1")
	})

	it("replaces the queued placeholder for the same (parent, index) slot", () => {
		registry.registerQueued({
			parentTaskId: "parent-1",
			index: 0,
			mode: "ask",
			description: "d",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			startedAt: 1,
			lastActivityAt: 1,
		})
		expect(registry.get(queuedSubagentId("parent-1", 0))?.status).toBe("queued")

		registry.register(makeSummary())
		expect(registry.has(queuedSubagentId("parent-1", 0))).toBe(false)
		expect(registry.list()).toHaveLength(1)
		expect(registry.get("task-1")?.status).toBe("running")
	})

	it("carries a watch flag from the placeholder to the real task id", () => {
		registry.registerQueued({
			parentTaskId: "parent-1",
			index: 0,
			mode: "ask",
			description: "d",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			startedAt: 1,
			lastActivityAt: 1,
		})
		registry.watch(queuedSubagentId("parent-1", 0))
		registry.register(makeSummary())
		expect(registry.isWatched("task-1")).toBe(true)
		expect(registry.isWatched(queuedSubagentId("parent-1", 0))).toBe(false)
	})

	it("beginFanOut drops only the given parent's entries and their watch flags", () => {
		registry.register(makeSummary({ taskId: "a", parentTaskId: "p1" }))
		registry.register(makeSummary({ taskId: "b", parentTaskId: "p2" }))
		registry.watch("a")
		registry.beginFanOut("p1")
		expect(registry.has("a")).toBe(false)
		expect(registry.isWatched("a")).toBe(false)
		expect(registry.has("b")).toBe(true)
	})

	it("setLiveStatus toggles running/awaiting_input but never resurrects a terminal entry", () => {
		registry.register(makeSummary())
		registry.setLiveStatus("task-1", "awaiting_input")
		expect(registry.get("task-1")?.status).toBe("awaiting_input")
		registry.markTerminal("task-1", "completed")
		registry.setLiveStatus("task-1", "running")
		expect(registry.get("task-1")?.status).toBe("completed")
	})

	it("markTerminal: first terminal wins, except failed → cancelled refinement", () => {
		registry.register(makeSummary())
		registry.markTerminal("task-1", "failed")
		registry.markTerminal("task-1", "completed")
		expect(registry.get("task-1")?.status).toBe("failed")
		registry.markTerminal("task-1", "cancelled")
		expect(registry.get("task-1")?.status).toBe("cancelled")
	})

	it("markTerminal fills finalMessage later without changing a terminal status", () => {
		registry.register(makeSummary())
		registry.markTerminal("task-1", "completed")
		registry.markTerminal("task-1", "completed", "the result")
		expect(registry.get("task-1")?.status).toBe("completed")
		expect(registry.get("task-1")?.finalMessage).toBe("the result")
	})

	it("truncates oversized final messages", () => {
		registry.register(makeSummary())
		registry.markTerminal("task-1", "completed", "x".repeat(5000))
		const finalMessage = registry.get("task-1")?.finalMessage ?? ""
		expect(finalMessage.length).toBeLessThanOrEqual(4001)
		expect(finalMessage.endsWith("…")).toBe(true)
	})

	it("update ignores unknown ids and does not post", () => {
		registry.update("nope", { tokensIn: 5 })
		expect(posted).toHaveLength(0)
	})

	it("list orders by parent then index", () => {
		registry.register(makeSummary({ taskId: "b", parentTaskId: "p1", index: 1 }))
		registry.register(makeSummary({ taskId: "a", parentTaskId: "p1", index: 0 }))
		expect(registry.list().map((s) => s.taskId)).toEqual(["a", "b"])
	})

	describe("clearAll", () => {
		it("drops every entry and watch flag, and posts an empty list", () => {
			registry.register(makeSummary({ taskId: "a", parentTaskId: "p1" }))
			registry.register(makeSummary({ taskId: "b", parentTaskId: "p2", index: 1 }))
			registry.watch("a")
			posted.length = 0

			registry.clearAll()

			expect(registry.list()).toEqual([])
			expect(registry.has("a")).toBe(false)
			expect(registry.has("b")).toBe(false)
			expect(registry.isWatched("a")).toBe(false)
			expect(posted).toHaveLength(1)
			expect(posted[0].type).toBe("subagentsUpdated")
			expect(posted[0].subagents).toEqual([])
		})

		it("is a no-op (no post) when the registry is already empty", () => {
			posted.length = 0
			registry.clearAll()
			expect(posted).toHaveLength(0)
		})

		it("does not interfere with beginFanOut's per-parent semantics", () => {
			// clearAll is global; beginFanOut stays scoped. After clearAll,
			// a fresh fan-out for a new parent registers cleanly.
			registry.register(makeSummary({ taskId: "old", parentTaskId: "p1" }))
			registry.clearAll()
			posted.length = 0

			registry.register(makeSummary({ taskId: "new", parentTaskId: "p2" }))
			expect(registry.list().map((s) => s.taskId)).toEqual(["new"])
			expect(posted[0].subagents).toHaveLength(1)
		})
	})

	describe("snapshot", () => {
		it("returns a copy of every summary in panel order", () => {
			registry.register(makeSummary({ taskId: "b", parentTaskId: "p1", index: 1 }))
			registry.register(makeSummary({ taskId: "a", parentTaskId: "p1", index: 0 }))
			const snap = registry.snapshot()
			expect(snap.map((s) => s.taskId)).toEqual(["a", "b"])
		})

		it("returns fresh objects so mutating a snapshot does not affect the registry", () => {
			registry.register(makeSummary({ taskId: "a", parentTaskId: "p1" }))
			const snap = registry.snapshot()
			snap[0].taskId = "mutated"
			expect(registry.get("a")?.taskId).toBe("a")
		})
	})

	describe("restore", () => {
		it("re-populates the registry from persisted summaries without posting", () => {
			posted.length = 0
			registry.restore("p1", [
				makeSummary({ taskId: "c1", parentTaskId: "p1", index: 0, status: "completed" }),
				makeSummary({ taskId: "c2", parentTaskId: "p1", index: 1, status: "failed" }),
			])
			expect(registry.list().map((s) => s.taskId)).toEqual(["c1", "c2"])
			// restore does NOT post — the caller is responsible for the
			// matching subagentsUpdated after the parent task is on the stack.
			expect(posted).toHaveLength(0)
		})

		it("drops existing entries for the same parent first (idempotent re-rehydrate)", () => {
			registry.register(makeSummary({ taskId: "old", parentTaskId: "p1", index: 0 }))
			registry.restore("p1", [makeSummary({ taskId: "new", parentTaskId: "p1", index: 0 })])
			expect(registry.has("old")).toBe(false)
			expect(registry.list().map((s) => s.taskId)).toEqual(["new"])
		})

		it("ignores summaries that belong to a different parent (corrupt sidecar guard)", () => {
			registry.restore("p1", [
				makeSummary({ taskId: "good", parentTaskId: "p1", index: 0 }),
				makeSummary({ taskId: "bad", parentTaskId: "p2", index: 0 }),
			])
			expect(registry.list().map((s) => s.taskId)).toEqual(["good"])
		})

		it("is a no-op for an empty list", () => {
			registry.register(makeSummary({ taskId: "a", parentTaskId: "p1" }))
			posted.length = 0
			registry.restore("p1", [])
			// Empty restore still drops existing entries for the parent
			// (idempotent re-rehydrate with no persisted children).
			expect(registry.has("a")).toBe(false)
			expect(posted).toHaveLength(0)
		})
	})

	describe("sourceTaskId stamping", () => {
		it("stamps the current task id from the provider on every post", () => {
			const localPosted: ExtensionMessage[] = []
			const scoped = new SubagentRegistry(
				(msg) => localPosted.push(msg),
				() => "current-task-id",
			)
			scoped.register(makeSummary())
			expect(localPosted[0].sourceTaskId).toBe("current-task-id")
		})

		it("leaves sourceTaskId undefined when no current task provider is wired", () => {
			// Default constructor arg: legacy/older wiring. The webview
			// treats undefined sourceTaskId as "accept unconditionally" so
			// the reset path still works.
			posted.length = 0
			registry.register(makeSummary())
			expect(posted[0].sourceTaskId).toBeUndefined()
		})
	})
})
