// cd src && npx vitest run core/context-management/ledger/__tests__/buildLedger.spec.ts

import type { TodoItem } from "@roo-code/types"

import { ApiMessage } from "../../../task-persistence/apiMessages"
import { formatResponse } from "../../../prompts/responses"

import { buildContextLedger, MAX_LEDGER_OPEN_ERRORS } from "../buildLedger"

let counter = 0

function toolPair(
	toolName: string,
	input: Record<string, unknown>,
	resultContent: string,
	options: { isError?: boolean } = {},
): [ApiMessage, ApiMessage] {
	counter += 1
	const useId = `tool-${counter}`
	return [
		{ role: "assistant", content: [{ type: "tool_use", id: useId, name: toolName, input }], ts: counter },
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: useId, content: resultContent, is_error: options.isError }],
			ts: counter,
		},
	]
}

function task(text = "Fix the failing auth tests"): ApiMessage {
	return { role: "user", content: text, ts: 0 }
}

/** The `tool_use_id` of the single tool_result block in a message built by `toolPair`. */
function toolUseIdOf(message: ApiMessage): string {
	const block = Array.isArray(message.content) ? message.content[0] : undefined
	if (!block || typeof block === "string" || block.type !== "tool_result") {
		throw new Error("expected a tool_result block")
	}
	return block.tool_use_id
}

describe("buildContextLedger", () => {
	beforeEach(() => {
		counter = 0
	})

	it("derives the goal from the first user message", () => {
		const ledger = buildContextLedger([task("Add a retry to the uploader")])
		expect(ledger.goal?.text).toBe("Add a retry to the uploader")
	})

	it("strips environment details and reminders from the goal", () => {
		const raw = [
			"<task>Rename the widget</task>",
			"<environment_details># VSCode Visible Files\nsrc/a.ts\nsrc/b.ts</environment_details>",
		].join("\n")
		const ledger = buildContextLedger([{ role: "user", content: raw, ts: 0 }])
		expect(ledger.goal?.text).toBe("Rename the widget")
	})

	it("ignores tool-result-only turns when looking for the goal", () => {
		const [assistant, result] = toolPair("read_file", { path: "a.ts" }, "contents")
		const ledger = buildContextLedger([result, assistant, task("The real goal")])
		expect(ledger.goal?.text).toBe("The real goal")
	})

	it("records the todo list as decisions", () => {
		const todos: TodoItem[] = [
			{ id: "1", content: "Reproduce the bug", status: "completed" },
			{ id: "2", content: "Patch the parser", status: "in_progress" },
		]
		const ledger = buildContextLedger([task()], { todos })
		expect(ledger.decisions.map((d) => d.text)).toEqual([
			"[completed] Reproduce the bug",
			"[in_progress] Patch the parser",
		])
	})

	it("records file changes once per path, keeping the latest tool", () => {
		const messages: ApiMessage[] = [
			task(),
			...toolPair("write_to_file", { path: "src/a.ts" }, "ok"),
			...toolPair("apply_diff", { path: "src/a.ts" }, "ok"),
			...toolPair("apply_patch", { path: "src/b.ts" }, "ok"),
		]
		const ledger = buildContextLedger(messages)
		expect(ledger.fileChanges.map((f) => f.text)).toEqual(["src/a.ts (apply_diff)", "src/b.ts (apply_patch)"])
	})

	it("does not record a file change when the write failed", () => {
		const messages: ApiMessage[] = [task(), ...toolPair("write_to_file", { path: "src/a.ts" }, "Error: EACCES")]
		expect(buildContextLedger(messages).fileChanges).toEqual([])
	})

	it("keeps a failure open until a later success on the SAME subject", () => {
		const messages: ApiMessage[] = [
			task(),
			...toolPair("apply_diff", { path: "src/a.ts" }, formatResponse.toolError("no match")),
			// A success on a different file must not close it.
			...toolPair("apply_diff", { path: "src/other.ts" }, "ok"),
		]
		const ledger = buildContextLedger(messages)
		expect(ledger.openErrors).toHaveLength(1)
		expect(ledger.openErrors[0].subject).toBe("src/a.ts")

		const resolved = buildContextLedger([...messages, ...toolPair("apply_diff", { path: "src/a.ts" }, "ok")])
		expect(resolved.openErrors).toEqual([])
	})

	it("treats a user denial as an open error", () => {
		const messages: ApiMessage[] = [
			task(),
			...toolPair("execute_command", { command: "rm -rf build" }, formatResponse.toolDenied()),
		]
		const ledger = buildContextLedger(messages)
		expect(ledger.openErrors[0].text).toContain("denied by user")
	})

	it("caps open errors at the newest ones", () => {
		const messages: ApiMessage[] = [task()]
		for (let i = 0; i < MAX_LEDGER_OPEN_ERRORS + 5; i++) {
			messages.push(...toolPair("read_file", { path: `src/f${i}.ts` }, `Error: missing ${i}`))
		}
		const ledger = buildContextLedger(messages)
		expect(ledger.openErrors).toHaveLength(MAX_LEDGER_OPEN_ERRORS)
		// Newest first: the last file pushed must be present, the first must not.
		expect(ledger.openErrors[0].subject).toBe(`src/f${MAX_LEDGER_OPEN_ERRORS + 4}.ts`)
		expect(ledger.openErrors.some((e) => e.subject === "src/f0.ts")).toBe(false)
	})

	it("records only the latest outcome per validation command", () => {
		const messages: ApiMessage[] = [
			task(),
			...toolPair("execute_command", { command: "npm test" }, "1 failed"),
			...toolPair("execute_command", { command: "ls -la" }, "a b c"),
			...toolPair("execute_command", { command: "npm test" }, "12 passed"),
		]
		const ledger = buildContextLedger(messages)
		expect(ledger.validations).toHaveLength(1)
		expect(ledger.validations[0].text).toBe("npm test → passed")
	})

	it("marks a failing validation without closing it as passed", () => {
		const messages: ApiMessage[] = [
			task(),
			...toolPair("execute_command", { command: "npm test" }, "Error: 3 tests failed"),
		]
		const ledger = buildContextLedger(messages)
		expect(ledger.validations[0].text).toBe("npm test → error")
		expect(ledger.openErrors[0].subject).toBe("npm test")
	})

	it("collects read paths as artifacts, newest first, deduplicated", () => {
		const messages: ApiMessage[] = [
			task(),
			...toolPair("read_file", { path: "src/a.ts" }, "aaa"),
			...toolPair("read_file", { path: "src/b.ts" }, "bbb"),
			...toolPair("read_file", { path: "src/a.ts" }, "aaa again"),
		]
		const ledger = buildContextLedger(messages)
		expect(ledger.artifacts.map((a) => a.text)).toEqual(["src/a.ts", "src/b.ts"])
	})

	it("marks errors, validations and file changes as critical — but not plain reads", () => {
		const [readUse, readResult] = toolPair("read_file", { path: "src/big.ts" }, "x".repeat(50_000))
		const [errUse, errResult] = toolPair("apply_diff", { path: "src/a.ts" }, formatResponse.toolError("nope"))
		const [testUse, testResult] = toolPair("execute_command", { command: "npm test" }, "ok")
		const ledger = buildContextLedger([task(), readUse, readResult, errUse, errResult, testUse, testResult])

		expect(ledger.criticalToolUseIds.has(toolUseIdOf(errResult))).toBe(true)
		expect(ledger.criticalToolUseIds.has(toolUseIdOf(testResult))).toBe(true)
		expect(ledger.criticalToolUseIds.has(toolUseIdOf(readResult))).toBe(false)
	})

	it("ignores tool results whose tool_use is missing", () => {
		const orphan: ApiMessage = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "ghost", content: "Error: gone" }],
			ts: 1,
		}
		const ledger = buildContextLedger([task(), orphan])
		expect(ledger.openErrors).toEqual([])
	})

	it("skips messages hidden by a condense summary", () => {
		const [hiddenUse, hiddenResult] = toolPair("apply_diff", { path: "src/old.ts" }, "Error: stale")
		hiddenUse.condenseParent = "c1"
		hiddenResult.condenseParent = "c1"
		const summary: ApiMessage = {
			role: "assistant",
			content: [{ type: "text", text: "summary" }],
			isSummary: true,
			condenseId: "c1",
			ts: 5,
		}
		const ledger = buildContextLedger([task(), hiddenUse, hiddenResult, summary])
		expect(ledger.openErrors).toEqual([])
	})

	it("returns an empty ledger for an empty history", () => {
		const ledger = buildContextLedger([])
		expect(ledger.goal).toBeUndefined()
		expect(ledger.facts).toEqual([])
		expect(ledger.criticalToolUseIds.size).toBe(0)
	})
})
