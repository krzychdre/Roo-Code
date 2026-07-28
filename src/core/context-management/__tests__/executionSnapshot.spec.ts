// cd src && npx vitest run core/context-management/__tests__/executionSnapshot.spec.ts

import type { ApiMessage } from "../../task-persistence/apiMessages"
import type { ContextLedger, LedgerFact } from "../ledger/types"
import { buildContextLedger, LEDGER_GOAL_MAX_CHARS } from "../ledger/buildLedger"
import { getEffectiveApiHistory } from "../../condense"
import {
	applyExecutionSnapshot,
	detectStaleFileChanges,
	renderExecutionSnapshot,
	EXECUTION_SNAPSHOT_VERSION,
	MAX_SNAPSHOT_SECTION_ITEMS,
	RESUME_SNAPSHOT_MIN_CHARS,
	STALE_MTIME_GRACE_MS,
} from "../executionSnapshot"

/** Enough per result that a dozen of them clear the size gate. */
const FILLER = "y".repeat(6_000)

/**
 * A history shaped like a real interrupted task: one edit that landed, one command that failed
 * and was never fixed, and a pile of file reads that carry nothing worth keeping.
 */
function interruptedHistory(): ApiMessage[] {
	let ts = 1_000
	const messages: ApiMessage[] = []
	const push = (message: Omit<ApiMessage, "ts">) => {
		messages.push({ ...message, ts: ts++ } as ApiMessage)
	}

	push({
		role: "user",
		content: [{ type: "text", text: "<task>Add exponential backoff to the openrouter provider</task>" }],
	})

	// The edit that must not be redone after the resume.
	push({
		role: "assistant",
		content: [
			{
				type: "tool_use",
				id: "use-edit",
				name: "write_to_file",
				input: { path: "src/api/providers/openrouter.ts" },
			},
		],
	})
	push({
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "use-edit", content: "The content was successfully saved." }],
	})

	// The failure that is still open.
	push({
		role: "assistant",
		content: [{ type: "tool_use", id: "use-test", name: "execute_command", input: { command: "pnpm test" } }],
	})
	push({
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: "use-test", content: "Error: 3 assertions failed in backoff.spec.ts" },
		],
	})

	// Bulk that should end up behind the snapshot.
	for (let i = 0; i < 12; i++) {
		push({
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: `use-read-${i}`,
					name: "read_file",
					input: { path: `src/api/providers/p${i}.ts` },
				},
			],
		})
		push({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: `use-read-${i}`, content: FILLER }],
		})
	}

	return messages
}

let nextIndex = 0

function fact(partial: Partial<LedgerFact> & Pick<LedgerFact, "class" | "text">): LedgerFact {
	return { index: nextIndex++, ...partial }
}

function ledgerOf(...facts: LedgerFact[]): ContextLedger {
	return {
		goal: facts.find((f) => f.class === "goal"),
		decisions: facts.filter((f) => f.class === "decision"),
		fileChanges: facts.filter((f) => f.class === "file_change"),
		openErrors: facts.filter((f) => f.class === "open_error"),
		validations: facts.filter((f) => f.class === "validation"),
		artifacts: facts.filter((f) => f.class === "artifact"),
		facts,
		criticalToolUseIds: new Set<string>(),
	}
}

beforeEach(() => {
	nextIndex = 0
})

describe("renderExecutionSnapshot", () => {
	it("states the goal, the finished work and the open failure under explicit headings", () => {
		const snapshot = renderExecutionSnapshot(
			ledgerOf(
				fact({ class: "goal", text: "Add exponential backoff to the openrouter provider" }),
				fact({ class: "file_change", text: "src/api/providers/openrouter.ts (write_to_file)" }),
				fact({ class: "open_error", text: "execute_command failed on pnpm test: 3 assertions failed" }),
			),
		)

		expect(snapshot).toContain(`## Execution Snapshot (v${EXECUTION_SNAPSHOT_VERSION})`)
		expect(snapshot).toContain("### Goal")
		expect(snapshot).toContain("Add exponential backoff to the openrouter provider")
		expect(snapshot).toContain("### Already changed")
		expect(snapshot).toContain("- src/api/providers/openrouter.ts (write_to_file)")
		expect(snapshot).toContain("### Still broken")
		expect(snapshot).toContain("3 assertions failed")
		// The instruction has to be next to the facts, not buried in a preamble a weak model skips.
		expect(snapshot).toContain("Do NOT make them again.")
	})

	it("omits sections that have nothing in them", () => {
		const snapshot = renderExecutionSnapshot(ledgerOf(fact({ class: "goal", text: "Ship the thing" })))

		expect(snapshot).not.toContain("### Still broken")
		expect(snapshot).not.toContain("### Already changed")
		expect(snapshot).not.toContain("### Plan")
	})

	it("warns about files that moved while the task was paused", () => {
		const snapshot = renderExecutionSnapshot(
			ledgerOf(fact({ class: "file_change", text: "src/a.ts (apply_diff)", subject: "src/a.ts" })),
			[
				{ path: "src/a.ts", reason: "modified" },
				{ path: "src/b.ts", reason: "removed" },
			],
		)

		expect(snapshot).toContain("### Changed outside this task while it was paused")
		expect(snapshot).toContain("- src/a.ts (modified)")
		expect(snapshot).toContain("- src/b.ts (removed)")
		// Validations are invalidated by an outside edit too, so the warning has to say so.
		expect(snapshot).toContain("re-run the validations")
	})

	it("says nothing about staleness when nothing moved", () => {
		const snapshot = renderExecutionSnapshot(
			ledgerOf(fact({ class: "file_change", text: "src/a.ts (apply_diff)", subject: "src/a.ts" })),
		)
		expect(snapshot).not.toContain("while it was paused")
	})

	it("reports section overflow instead of truncating silently", () => {
		const changes = Array.from({ length: MAX_SNAPSHOT_SECTION_ITEMS + 4 }, (_, i) =>
			fact({ class: "file_change" as const, text: `src/file${i}.ts (write_to_file)` }),
		)

		const snapshot = renderExecutionSnapshot(ledgerOf(...changes))
		expect(snapshot).toContain("- (4 more, omitted for length)")
	})
})

describe("detectStaleFileChanges", () => {
	const ledger = ledgerOf(
		fact({ class: "file_change", text: "src/a.ts (apply_diff)", subject: "src/a.ts" }),
		fact({ class: "file_change", text: "src/b.ts (write_to_file)", subject: "src/b.ts" }),
	)

	it("flags a file edited after the task last acted", async () => {
		const lastActivity = 10_000_000
		const stat = vi.fn(async (filePath: string) => ({
			mtimeMs: filePath.endsWith("a.ts") ? lastActivity + 60_000 : lastActivity - 5_000,
		}))

		const stale = await detectStaleFileChanges(ledger, "/repo", lastActivity, stat)
		expect(stale).toEqual([{ path: "src/a.ts", reason: "modified" }])
		expect(stat).toHaveBeenCalledWith("/repo/src/a.ts")
	})

	it("does not flag the task's own writes, which land just before the last message", async () => {
		const lastActivity = 10_000_000
		// Written a beat before the tool result was recorded — inside the grace window.
		const stat = async () => ({ mtimeMs: lastActivity + STALE_MTIME_GRACE_MS - 1 })

		expect(await detectStaleFileChanges(ledger, "/repo", lastActivity, stat)).toEqual([])
	})

	it("reports a file that was deleted while the task was paused", async () => {
		const stat = async (filePath: string) => {
			if (filePath.endsWith("b.ts")) {
				const error = new Error("no such file") as NodeJS.ErrnoException
				error.code = "ENOENT"
				throw error
			}
			return { mtimeMs: 0 }
		}

		expect(await detectStaleFileChanges(ledger, "/repo", 10_000_000, stat)).toEqual([
			{ path: "src/b.ts", reason: "removed" },
		])
	})

	it("stays silent when the file cannot be read for an unrelated reason", async () => {
		// A permissions error says nothing about whether the content changed; guessing would put a
		// warning on every resume in a locked-down workspace.
		const stat = async () => {
			const error = new Error("permission denied") as NodeJS.ErrnoException
			error.code = "EACCES"
			throw error
		}

		expect(await detectStaleFileChanges(ledger, "/repo", 10_000_000, stat)).toEqual([])
	})

	it("checks a file once even when it was written repeatedly", async () => {
		const repeated = ledgerOf(
			fact({ class: "file_change", text: "src/a.ts (apply_diff)", subject: "src/a.ts" }),
			fact({ class: "file_change", text: "src/a.ts (apply_diff)", subject: "src/a.ts" }),
			fact({ class: "file_change", text: "src/a.ts (write_to_file)", subject: "src/a.ts" }),
		)
		const stat = vi.fn(async () => ({ mtimeMs: 0 }))

		await detectStaleFileChanges(repeated, "/repo", 10_000_000, stat)
		expect(stat).toHaveBeenCalledTimes(1)
	})
})

describe("applyExecutionSnapshot", () => {
	it("leaves a small history exactly as it was", () => {
		const messages: ApiMessage[] = [
			{ role: "user", ts: 1, content: [{ type: "text", text: "<task>tiny task</task>" }] },
			{ role: "assistant", ts: 2, content: [{ type: "text", text: "done" }] },
		]

		const result = applyExecutionSnapshot({ messages })
		expect(result.applied).toBe(false)
		expect(result.skipReason).toBe("too-small")
		// Same array, not a copy: a resume below the gate must be byte-for-byte today's behaviour.
		expect(result.messages).toBe(messages)
	})

	it("replaces the replay with a snapshot that carries the critical facts", () => {
		const messages = interruptedHistory()
		const result = applyExecutionSnapshot({ messages })

		expect(result.applied).toBe(true)
		expect(result.charsBefore).toBeGreaterThan(RESUME_SNAPSHOT_MIN_CHARS)
		expect(result.charsAfter).toBeLessThan(result.charsBefore / 2)

		const effective = getEffectiveApiHistory(result.messages)
		const snapshot = effective[0]
		expect(snapshot.isSummary).toBe(true)
		const text = typeof snapshot.content === "string" ? snapshot.content : JSON.stringify(snapshot.content)
		// The two facts that cannot be re-derived after the raw turns are hidden.
		expect(text).toContain("src/api/providers/openrouter.ts")
		expect(text).toContain("pnpm test")
		expect(text).toContain("Add exponential backoff to the openrouter provider")
	})

	it("hides messages without deleting them", () => {
		const messages = interruptedHistory()
		const result = applyExecutionSnapshot({ messages })

		// Every original message is still on disk; only one message was added.
		expect(result.messages).toHaveLength(messages.length + 1)
		expect(result.hiddenMessages).toBeGreaterThan(0)

		const hidden = result.messages.slice(0, result.hiddenMessages)
		expect(hidden.every((message) => typeof message.condenseParent === "string")).toBe(true)
		expect(getEffectiveApiHistory(result.messages).length).toBeLessThan(messages.length)
	})

	it("keeps an interrupted tool call answerable", () => {
		// The common resume: the task died between the tool_use and its result. If the snapshot
		// hid that assistant message, the tool_result built by prepareResumptionContent would
		// reference an id the model can no longer see.
		const messages = interruptedHistory()
		messages.push({
			role: "assistant",
			ts: 9_000,
			content: [
				{ type: "tool_use", id: "use-interrupted", name: "apply_diff", input: { path: "src/api/retry.ts" } },
			],
		})

		const result = applyExecutionSnapshot({ messages })
		expect(result.applied).toBe(true)

		const effective = getEffectiveApiHistory(result.messages)
		const ids = effective.flatMap((message) =>
			Array.isArray(message.content)
				? message.content.filter((block) => block.type === "tool_use").map((block) => (block as any).id)
				: [],
		)
		expect(ids).toContain("use-interrupted")
	})

	it("does not orphan a tool_result in the kept tail", () => {
		const messages = interruptedHistory()
		const result = applyExecutionSnapshot({ messages })

		const effective = getEffectiveApiHistory(result.messages)
		const toolUseIds = new Set(
			effective.flatMap((message) =>
				Array.isArray(message.content)
					? message.content
							.filter((block) => block.type === "tool_use")
							.map((block) => (block as any).id as string)
					: [],
			),
		)
		const resultIds = effective.flatMap((message) =>
			Array.isArray(message.content)
				? message.content
						.filter((block) => block.type === "tool_result")
						.map((block) => (block as any).tool_use_id as string)
				: [],
		)

		expect(resultIds.length).toBeGreaterThan(0)
		expect(resultIds.every((id) => toolUseIds.has(id))).toBe(true)
	})

	it("reuses a ledger the caller already built", () => {
		const messages = interruptedHistory()
		const ledger = buildContextLedger(messages)
		const result = applyExecutionSnapshot({ messages, ledger })

		expect(result.applied).toBe(true)
		expect(JSON.stringify(getEffectiveApiHistory(result.messages)[0].content)).toContain("openrouter.ts")
	})

	it("carries the staleness warning into the applied snapshot", () => {
		const messages = interruptedHistory()
		const result = applyExecutionSnapshot({
			messages,
			stale: [{ path: "src/api/providers/openrouter.ts", reason: "modified" }],
		})

		const text = JSON.stringify(getEffectiveApiHistory(result.messages)[0].content)
		expect(text).toContain("Changed outside this task while it was paused")
	})

	it("keeps a prior condense summary's tagging intact", () => {
		const messages = interruptedHistory()
		messages[1] = { ...messages[1], condenseParent: "earlier-condense" }

		const result = applyExecutionSnapshot({ messages })
		expect(result.messages[1].condenseParent).toBe("earlier-condense")
	})

	it("treats a long first user message as the goal rather than skipping", () => {
		// Any real history has at least one fact, because the first user turn is the goal — and the
		// ledger bounds it, so a wall-of-text request cannot bloat the snapshot without limit.
		const messages: ApiMessage[] = Array.from({ length: 20 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			ts: 1_000 + i,
			content: [{ type: "text", text: i === 0 ? `<task>${FILLER}</task>` : FILLER }],
		}))

		const result = applyExecutionSnapshot({ messages })
		expect(result.applied).toBe(true)
		const snapshot = JSON.stringify(getEffectiveApiHistory(result.messages)[0].content)
		// The cap plus the fixed boilerplate (headings and their instruction lines), which is the
		// only other thing in a snapshot with no tool calls behind it.
		expect(snapshot.length).toBeLessThan(LEDGER_GOAL_MAX_CHARS + 1_000)
	})

	it("does nothing when the history carries no facts at all", () => {
		// Degenerate shape — no user turn, so no goal, and no tool calls. This is the defensive
		// path: with nothing to carry over, hiding the raw turns would be a pure loss.
		const messages: ApiMessage[] = Array.from({ length: 20 }, (_, i) => ({
			role: "assistant",
			ts: 1_000 + i,
			content: [{ type: "text", text: FILLER }],
		}))

		const result = applyExecutionSnapshot({ messages })
		expect(result.applied).toBe(false)
		expect(result.skipReason).toBe("no-facts")
		expect(result.messages).toBe(messages)
	})
})
