// cd src && npx vitest run core/context-management/ledger/__tests__/buildLedger.spec.ts

import type { TodoItem } from "@roo-code/types"

import { ApiMessage } from "../../../task-persistence/apiMessages"
import { formatResponse } from "../../../prompts/responses"

import {
	buildContextLedger,
	LEDGER_GOAL_MAX_CHARS,
	MAX_LEDGER_OPEN_ERRORS,
	MAX_LEDGER_USER_INSTRUCTIONS,
} from "../buildLedger"

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

	it("unwraps the <user_message> shape this fork actually emits", () => {
		// `TaskLifecycle.startTask` wraps the task statement in <user_message>, not <task>; the
		// tags used to be carried into the goal fact and to eat its budget.
		const raw =
			"<user_message>\nRename the widget\n</user_message>\n<environment_details>noise</environment_details>"
		const ledger = buildContextLedger([{ role: "user", content: raw, ts: 0 }])
		expect(ledger.goal?.text).toBe("Rename the widget")
	})

	it("keeps the end of a long request, where the constraints live", () => {
		// Head-only truncation at 400 chars dropped a median of 3,348 chars from 63% of real
		// requests — reliably including the trailing "and do not ..." clause.
		const raw = `Refactor the uploader. ${"Background context that is not the instruction. ".repeat(80)}Do NOT touch the tests.`
		const ledger = buildContextLedger([{ role: "user", content: raw, ts: 0 }])

		expect(ledger.goal!.text.length).toBeLessThanOrEqual(LEDGER_GOAL_MAX_CHARS)
		expect(ledger.goal!.text).toContain("Refactor the uploader.")
		expect(ledger.goal!.text).toContain("Do NOT touch the tests.")
		expect(ledger.goal!.text).toContain("chars omitted")
	})

	it("leaves a request that fits verbatim", () => {
		const raw = `Refactor the uploader. ${"Some detail. ".repeat(50)}Do not touch the tests.`
		const ledger = buildContextLedger([{ role: "user", content: raw, ts: 0 }])

		expect(raw.length).toBeGreaterThan(400)
		expect(ledger.goal?.text).toBe(raw.replace(/\s+/g, " ").trim())
	})

	it("ignores tool-result-only turns when looking for the goal", () => {
		const [assistant, result] = toolPair("read_file", { path: "a.ts" }, "contents")
		const ledger = buildContextLedger([result, assistant, task("The real goal")])
		expect(ledger.goal?.text).toBe("The real goal")
	})

	it("records what the user said after the task started", () => {
		// The dominant real shape: the answer to ask_followup_question comes back inside a
		// tool_result, not as a turn of its own.
		const [ask, answer] = toolPair(
			"ask_followup_question",
			{ question: "which package manager?" },
			"<user_message>\nuse pnpm, never npm\n</user_message>",
		)
		const ledger = buildContextLedger([task("<user_message>Set up CI</user_message>"), ask, answer])

		expect(ledger.goal?.text).toBe("Set up CI")
		expect(ledger.userInstructions.map((f) => f.text)).toEqual(["use pnpm, never npm"])
		// The result carrying it must survive microcompaction along with the fact.
		expect(ledger.criticalToolUseIds.has(toolUseIdOf(answer))).toBe(true)
	})

	it("does not repeat the task statement as an instruction", () => {
		const ledger = buildContextLedger([task("<user_message>Set up CI</user_message>")])
		expect(ledger.goal?.text).toBe("Set up CI")
		expect(ledger.userInstructions).toEqual([])
	})

	it("records a mid-task instruction typed as its own turn", () => {
		const messages: ApiMessage[] = [
			task("First, the request"),
			{ role: "assistant", content: [{ type: "text", text: "working" }], ts: 1 },
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "[TASK RESUMPTION] The user has sent a message:\n<user_message>\nactually, target RKE2 not k3s\n</user_message>",
					},
				],
				ts: 2,
			},
		]
		expect(buildContextLedger(messages).userInstructions.map((f) => f.text)).toEqual([
			"actually, target RKE2 not k3s",
		])
	})

	it("records the note attached to a denial", () => {
		const messages: ApiMessage[] = [
			task(),
			...toolPair(
				"execute_command",
				{ command: "pip install ruff" },
				formatResponse.toolDeniedWithFeedback("no system-wide python packages"),
			),
		]
		const ledger = buildContextLedger(messages)
		expect(ledger.userInstructions.map((f) => f.text)).toEqual(["no system-wide python packages"])
		// It is still a denial, so it stays an open error too — the two facts say different things.
		expect(ledger.openErrors).toHaveLength(1)
	})

	it("collapses a repeated instruction onto its latest occurrence", () => {
		const messages: ApiMessage[] = [task()]
		for (let i = 0; i < 3; i++) {
			messages.push(
				...toolPair("ask_followup_question", { question: `q${i}` }, "<user_message>use pnpm</user_message>"),
			)
		}
		messages.push(
			...toolPair("ask_followup_question", { question: "last" }, "<user_message>and skip e2e</user_message>"),
		)

		expect(buildContextLedger(messages).userInstructions.map((f) => f.text)).toEqual(["use pnpm", "and skip e2e"])
	})

	it("keeps the newest instructions but renders them in the order they were said", () => {
		const messages: ApiMessage[] = [task()]
		for (let i = 0; i < MAX_LEDGER_USER_INSTRUCTIONS + 3; i++) {
			messages.push(
				...toolPair("ask_followup_question", { question: `q${i}` }, `<user_message>rule ${i}</user_message>`),
			)
		}
		const texts = buildContextLedger(messages).userInstructions.map((f) => f.text)

		expect(texts).toHaveLength(MAX_LEDGER_USER_INSTRUCTIONS)
		// Oldest dropped, and the last thing the user said reads last.
		expect(texts[0]).toBe("rule 3")
		expect(texts[texts.length - 1]).toBe(`rule ${MAX_LEDGER_USER_INSTRUCTIONS + 2}`)
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
