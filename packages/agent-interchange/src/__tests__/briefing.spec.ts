import { collectFacts, renderBriefing } from "../briefing.js"
import { extractActions } from "../tools.js"
import { renderTranscript } from "../transcript.js"
import type { InterchangeMessage, Session } from "../types.js"

const claudeMessages: InterchangeMessage[] = [
	{
		role: "user",
		ts: 1,
		blocks: [
			{
				type: "text",
				text: "Make the retry logic deterministic.\n<system-reminder>ignore me</system-reminder>",
			},
		],
	},
	{
		role: "assistant",
		ts: 2,
		blocks: [
			{ type: "thinking", text: "long deliberation" },
			{ type: "tool_use", name: "Read", input: { file_path: "src/retry.ts" } },
			{ type: "tool_use", name: "Edit", input: { file_path: "src/retry.ts" } },
			{ type: "tool_use", name: "Bash", input: { command: "pnpm test retry" } },
			{
				type: "tool_use",
				name: "TodoWrite",
				input: { todos: [{ content: "Land the fix", status: "in_progress" }] },
			},
			{ type: "tool_use", name: "ExitPlanMode", input: { plan: "1. Freeze the clock\n2. Assert the backoff" } },
			{
				type: "tool_use",
				name: "AskUserQuestion",
				input: { questions: [{ question: "Cap the backoff at 30s?" }] },
			},
			{ type: "tool_use", name: "Write", input: { file_path: "ai_plans/2026-07-31_retry.md" } },
		],
	},
	{
		role: "assistant",
		ts: 3,
		blocks: [
			{
				type: "text",
				text: "The backoff is now driven by an injected clock, so the test no longer races. Coverage is unchanged.",
			},
		],
	},
]

const tumbleMessages: InterchangeMessage[] = [
	{ role: "user", ts: 1, blocks: [{ type: "text", text: "<task>\nPort the fix\n</task>" }] },
	{
		role: "assistant",
		ts: 2,
		blocks: [
			{ type: "tool_use", name: "read_file", input: { args: "<file><path>src/a.ts</path></file>" } },
			{
				type: "tool_use",
				name: "apply_patch",
				input: { patch: "*** Begin Patch\n*** Update File: src/b.ts\n+x\n" },
			},
			{ type: "tool_use", name: "execute_command", input: { command: "pnpm vitest run" } },
			{ type: "tool_use", name: "new_task", input: { mode: "reviewer", message: "Review the diff" } },
			{ type: "tool_use", name: "attempt_completion", input: { result: "Ported and tested." } },
		],
	},
	{
		role: "assistant",
		ts: 3,
		blocks: [
			{
				type: "text",
				text: "<write_to_file>\n<path>src/c.ts</path>\n<content>x</content>\n</write_to_file>\n<ask_followup_question>\n<question>Should I bump the version?</question>\n</ask_followup_question>",
			},
		],
	},
]

function session(overrides: Partial<Session>): Session {
	return {
		agent: "claude-code",
		id: "abc",
		title: "Retry determinism",
		cwd: "/tmp/proj",
		gitBranch: "main",
		createdAt: Date.parse("2026-07-31T10:00:00.000Z"),
		updatedAt: Date.parse("2026-07-31T10:30:00.000Z"),
		path: "/tmp/proj.jsonl",
		messages: [],
		...overrides,
	}
}

describe("action extraction", () => {
	it("reads Claude Code's vocabulary", () => {
		const actions = extractActions(claudeMessages)

		expect(actions.find((action) => action.tool === "Edit")).toMatchObject({
			kind: "write",
			paths: ["src/retry.ts"],
		})
		expect(actions.find((action) => action.tool === "Bash")).toMatchObject({
			kind: "command",
			command: "pnpm test retry",
		})
		expect(actions.find((action) => action.tool === "ExitPlanMode")?.kind).toBe("plan")
	})

	it("reads Tumble Code's vocabulary, native and XML", () => {
		const actions = extractActions(tumbleMessages)

		expect(actions.find((action) => action.tool === "read_file")).toMatchObject({
			kind: "read",
			paths: ["src/a.ts"],
		})
		expect(actions.find((action) => action.tool === "apply_patch")).toMatchObject({
			kind: "write",
			paths: ["src/b.ts"],
		})
		// The XML style lives in a text block and must be found there.
		expect(actions.find((action) => action.tool === "write_to_file")).toMatchObject({
			kind: "write",
			paths: ["src/c.ts"],
		})
		expect(actions.find((action) => action.tool === "ask_followup_question")).toMatchObject({
			kind: "question",
			text: "Should I bump the version?",
		})
	})

	it("keeps an unknown tool visible instead of dropping it", () => {
		const actions = extractActions([
			{ role: "assistant", blocks: [{ type: "tool_use", name: "BrandNewTool", input: {} }] },
		])

		expect(actions).toEqual([{ kind: "other", tool: "BrandNewTool", messageIndex: 0 }])
	})
})

describe("briefing facts", () => {
	it("derives the request, files, commands, plan, todos and questions", () => {
		const facts = collectFacts(session({ messages: claudeMessages }))

		expect(facts.request).toBe("Make the retry logic deterministic.")
		expect(facts.filesWritten).toEqual(["src/retry.ts", "ai_plans/2026-07-31_retry.md"])
		expect(facts.filesRead).toEqual(["src/retry.ts"])
		expect(facts.commands).toEqual(["pnpm test retry"])
		expect(facts.planFiles).toEqual(["ai_plans/2026-07-31_retry.md"])
		expect(facts.plans[0]).toContain("Freeze the clock")
		expect(facts.todos).toBe("- [-] Land the fix")
		expect(facts.questions).toEqual(["Cap the backoff at 30s?"])
		expect(facts.assistantNotes[0]).toContain("injected clock")
	})

	it("strips each agent's prompt wrapper from the request", () => {
		const facts = collectFacts(session({ agent: "tumble-code", messages: tumbleMessages }))

		expect(facts.request).toBe("Port the fix")
		expect(facts.outcome).toBe("Ported and tested.")
		expect(facts.delegations).toEqual(["reviewer: Review the diff"])
	})

	it("falls back to the recorded completion summary when there is no result tool call", () => {
		const facts = collectFacts(session({ agent: "tumble-code", messages: [], resultSummary: "Child finished" }))

		expect(facts.outcome).toBe("Child finished")
	})
})

describe("renderBriefing", () => {
	it("puts the load-bearing sections in the document", () => {
		const markdown = renderBriefing(session({ messages: claudeMessages }))

		expect(markdown).toContain("# Retry determinism")
		expect(markdown).toContain("**Agent:** Claude Code")
		expect(markdown).toContain("## The request")
		expect(markdown).toContain("## Files changed (2)")
		expect(markdown).toContain("## Commands run (1)")
		expect(markdown).toContain("## Questions the agent asked")
		expect(markdown).toContain("`/tmp/proj.jsonl`")
	})

	it("omits sections it has no facts for", () => {
		const markdown = renderBriefing(session({ messages: [] }))

		expect(markdown).not.toContain("## Files changed")
		expect(markdown).not.toContain("## Commands run")
	})
})

describe("renderTranscript", () => {
	const long = session({
		messages: Array.from({ length: 25 }, (_, index) => ({
			role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
			ts: index,
			blocks: [{ type: "text" as const, text: `message ${index}` }],
		})),
	})

	it("pages, and says how to continue", () => {
		const page = renderTranscript(long, { offset: 0, limit: 10 })

		expect(page).toMatchObject({ offset: 0, limit: 10, total: 25, nextOffset: 10 })
		expect(page.markdown).toContain("Messages 1–10 of 25")
		expect(page.markdown).toContain("offset: 10")
		expect(page.markdown).not.toContain("message 10")
	})

	it("reports no continuation at the end", () => {
		expect(renderTranscript(long, { offset: 20, limit: 10 }).nextOffset).toBeUndefined()
	})

	it("hides reasoning unless asked", () => {
		const withThinking = session({
			messages: [{ role: "assistant", blocks: [{ type: "thinking", text: "secret deliberation" }] }],
		})

		expect(renderTranscript(withThinking).markdown).not.toContain("secret deliberation")
		expect(renderTranscript(withThinking, { includeThinking: true }).markdown).toContain("secret deliberation")
	})

	it("truncates a block instead of dumping it", () => {
		const huge = session({
			messages: [{ role: "assistant", blocks: [{ type: "text", text: "x".repeat(5000) }] }],
		})

		const markdown = renderTranscript(huge, { maxBlockChars: 100 }).markdown

		expect(markdown).toContain("truncated, 4900 more characters")
	})
})
