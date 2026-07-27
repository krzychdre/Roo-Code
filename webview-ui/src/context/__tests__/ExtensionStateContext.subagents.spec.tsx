/**
 * Focused tests for the parallel-subagent panel slice in ExtensionStateContext:
 * - the `subagentsUpdated` `sourceTaskId` scope guard (Part D)
 * - the `clearSubagents` callback (Part A webview belt-and-suspenders)
 *
 * The scope guard drops a `subagentsUpdated` push whose `sourceTaskId` does
 * not match the current foreground task (so a late terminal update from a
 * just-abandoned parent cannot pollute the new task's panel), while still
 * accepting reset broadcasts (`sourceTaskId` undefined or an empty list).
 */
import { render, screen, act } from "@/utils/test-utils"

import type { SubagentSummary } from "@roo-code/types"

import { ExtensionStateContextProvider, useExtensionState } from "../ExtensionStateContext"

const makeSummary = (overrides: Partial<SubagentSummary> = {}): SubagentSummary => ({
	taskId: "child-1",
	parentTaskId: "parent-1",
	index: 0,
	mode: "code",
	description: "do thing",
	status: "completed",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	startedAt: 1,
	lastActivityAt: 2,
	...overrides,
})

/** Component that exposes the subagents slice + clearSubagents for assertions. */
const SubagentsTestComponent = () => {
	const { subagents, clearSubagents, currentTaskId } = useExtensionState()
	return (
		<div>
			<div data-testid="subagents">{JSON.stringify(subagents)}</div>
			<div data-testid="current-task-id">{JSON.stringify(currentTaskId ?? null)}</div>
			<button data-testid="clear-subagents-button" onClick={() => clearSubagents()}>
				Clear Subagents
			</button>
		</div>
	)
}

/** Dispatch a synthetic `message` event on window, mimicking the extension host. */
function postExtensionMessage(payload: Record<string, unknown>) {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: payload }))
	})
}

describe("ExtensionStateContext — subagents slice", () => {
	describe("clearSubagents", () => {
		it("clears the subagents slice on demand", () => {
			render(
				<ExtensionStateContextProvider>
					<SubagentsTestComponent />
				</ExtensionStateContextProvider>,
			)

			// Seed subagents via an unscoped push (sourceTaskId undefined →
			// accepted unconditionally).
			postExtensionMessage({
				type: "subagentsUpdated",
				subagents: [makeSummary({ taskId: "c1" })],
			})
			expect(JSON.parse(screen.getByTestId("subagents").textContent!)).toHaveLength(1)

			act(() => {
				screen.getByTestId("clear-subagents-button").click()
			})

			expect(JSON.parse(screen.getByTestId("subagents").textContent!)).toEqual([])
		})
	})

	describe("subagentsUpdated sourceTaskId scope guard", () => {
		it("accepts an unscoped push (sourceTaskId undefined) — legacy/reset path", () => {
			render(
				<ExtensionStateContextProvider>
					<SubagentsTestComponent />
				</ExtensionStateContextProvider>,
			)
			postExtensionMessage({
				type: "subagentsUpdated",
				// No sourceTaskId: the webview treats this as "accept
				// unconditionally" so the reset path keeps working even
				// before the new task id is known.
				subagents: [makeSummary({ taskId: "c1" })],
			})
			expect(JSON.parse(screen.getByTestId("subagents").textContent!)).toHaveLength(1)
		})

		it("accepts a reset broadcast (empty list) regardless of sourceTaskId mismatch", () => {
			render(
				<ExtensionStateContextProvider>
					<SubagentsTestComponent />
				</ExtensionStateContextProvider>,
			)
			// Seed first.
			postExtensionMessage({
				type: "subagentsUpdated",
				subagents: [makeSummary({ taskId: "c1" })],
			})
			expect(JSON.parse(screen.getByTestId("subagents").textContent!)).toHaveLength(1)

			// A reset broadcast with a mismatched sourceTaskId still clears
			// the panel — clearing is always the intent regardless of sender.
			postExtensionMessage({
				type: "subagentsUpdated",
				sourceTaskId: "some-other-task",
				subagents: [],
			})
			expect(JSON.parse(screen.getByTestId("subagents").textContent!)).toEqual([])
		})

		it("accepts a push whose sourceTaskId matches currentTaskId", () => {
			render(
				<ExtensionStateContextProvider>
					<SubagentsTestComponent />
				</ExtensionStateContextProvider>,
			)
			// Establish the current task id via a state push. The state
			// merge sets currentTaskId from the partial state payload.
			postExtensionMessage({
				type: "state",
				state: { currentTaskId: "current-task-id" },
			})
			expect(screen.getByTestId("current-task-id").textContent).toBe(JSON.stringify("current-task-id"))

			postExtensionMessage({
				type: "subagentsUpdated",
				sourceTaskId: "current-task-id",
				subagents: [makeSummary({ taskId: "c1" })],
			})
			expect(JSON.parse(screen.getByTestId("subagents").textContent!)).toHaveLength(1)
		})

		it("drops a non-empty push whose sourceTaskId does not match currentTaskId", () => {
			render(
				<ExtensionStateContextProvider>
					<SubagentsTestComponent />
				</ExtensionStateContextProvider>,
			)
			// Seed an initial non-empty list (unscoped → accepted).
			postExtensionMessage({
				type: "subagentsUpdated",
				subagents: [makeSummary({ taskId: "c1" })],
			})
			// Set the current task id.
			postExtensionMessage({
				type: "state",
				state: { currentTaskId: "current-task-id" },
			})

			// A late terminal update from a JUST-ABANDONED parent (different
			// sourceTaskId, non-empty list) must NOT pollute the new task's
			// panel. The existing entries are preserved (the push is dropped,
			// not a reset).
			postExtensionMessage({
				type: "subagentsUpdated",
				sourceTaskId: "abandoned-old-task",
				subagents: [makeSummary({ taskId: "late-child" })],
			})
			const after = JSON.parse(screen.getByTestId("subagents").textContent!)
			expect(after).toHaveLength(1)
			expect(after[0].taskId).toBe("c1") // the seeded entry, not "late-child"
		})

		it("drops a non-empty push when currentTaskId is set but sourceTaskId is from another task", () => {
			render(
				<ExtensionStateContextProvider>
					<SubagentsTestComponent />
				</ExtensionStateContextProvider>,
			)
			postExtensionMessage({
				type: "state",
				state: { currentTaskId: "current-task-id" },
			})
			postExtensionMessage({
				type: "subagentsUpdated",
				sourceTaskId: "other-task",
				subagents: [makeSummary({ taskId: "c1" }), makeSummary({ taskId: "c2", index: 1 })],
			})
			// Dropped: panel stays empty (initial state).
			expect(JSON.parse(screen.getByTestId("subagents").textContent!)).toEqual([])
		})
	})
})
