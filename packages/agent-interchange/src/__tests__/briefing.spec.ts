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

	it("strips every system-noise token from user text", () => {
		const golden: Array<{ label: string; raw: string; expected: string }> = [
			{
				label: "system-reminder block",
				raw: "Keep<system-reminder>drop me</system-reminder>End",
				expected: "KeepEnd",
			},
			{ label: "ide_selection block", raw: "A<ide_selection>noise</ide_selection>B", expected: "AB" },
			{
				label: "environment_details block",
				raw: "C<environment_details>noise</environment_details>D",
				expected: "CD",
			},
			{ label: "task open tag", raw: "<task>Port</task>", expected: "Port" },
			{ label: "task close tag", raw: "<task>Port</task>", expected: "Port" },
			{ label: "user_message tag", raw: "<user_message>Follow up</user_message>", expected: "Follow up" },
			{ label: "feedback tag", raw: "<feedback>Note</feedback>", expected: "Note" },
			{ label: "answer tag", raw: "<answer>Yes</answer>", expected: "Yes" },
			// Lazy [\s\S]*? pairs the first open with the FIRST close, so the
			// inner open is consumed but "tail</system-reminder>" survives —
			// this matches the original regex exactly (verified via equiv probe).
			{
				label: "nested same-kind block",
				raw: "x<system-reminder>outer<system-reminder>inner</system-reminder>tail</system-reminder>y",
				expected: "xtail</system-reminder>y",
			},
			{
				label: "two same-kind blocks",
				raw: "a<system-reminder>1</system-reminder>b<system-reminder>2</system-reminder>c",
				expected: "abc",
			},
			{
				label: "orphan open kept, later valid block stripped",
				raw: "<system-reminder>x<ide_selection>y</ide_selection>z",
				expected: "<system-reminder>xz",
			},
			{
				label: "adjacent different blocks",
				raw: "<system-reminder>s</system-reminder><ide_selection>i</ide_selection><environment_details>e</environment_details>",
				expected: "",
			},
			{
				label: "block with newlines",
				raw: "a<system-reminder>line1\nline2\nline3</system-reminder>b",
				expected: "ab",
			},
			{ label: "plain text unchanged", raw: "hello world", expected: "hello world" },
		]

		for (const { label, raw, expected } of golden) {
			const facts = collectFacts(
				session({ messages: [{ role: "user", ts: 1, blocks: [{ type: "text", text: raw }] }] }),
			)

			expect(facts.request, label).toBe(expected)
		}
	})

	it("does not catastrophically backtrack on many unmatched open tags", () => {
		// Regression guard for CodeQL alert #15 (polynomial ReDoS). The original
		// regexes (/<tag>[\s\S]*?<\/tag>/g) took ~95 ms on 3000 orphan
		// <environment_details> opens (63 KB) due to quadratic rescan-per-open.
		// The linear stripTaggedBlocks scanner must finish well under a generous
		// bound; this asserts < 100 ms for 10000 opens (210 KB), which is far
		// beyond any realistic message size.
		// The sentinel is placed at the START because truncate() keeps the first
		// maxRequestChars chars; orphan opens have no close, so cleaning leaves
		// them in place and the sentinel survives at the head of the request.
		const adversarial = "SENTINEL_BEFORE" + "<environment_details>".repeat(10000)
		const before = Date.now()
		const facts = collectFacts(
			session({ messages: [{ role: "user", ts: 1, blocks: [{ type: "text", text: adversarial }] }] }),
			{ maxRequestChars: 100000 },
		)
		const elapsed = Date.now() - before

		expect(facts.request).toContain("SENTINEL_BEFORE")
		expect(elapsed).toBeLessThan(100)
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
