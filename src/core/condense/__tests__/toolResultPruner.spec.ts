// cd src && npx vitest run core/condense/__tests__/toolResultPruner.spec.ts

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import { Anthropic } from "@anthropic-ai/sdk"

import { ArtifactStore } from "../../artifacts/ArtifactStore"
import { applyToolResultSpill } from "../../artifacts/spillPolicy"
import { MICROCOMPACT_CLEARED_PLACEHOLDER } from "../../context-management/microcompact"
import { ApiMessage } from "../../task-persistence/apiMessages"
import { computeCondenseKeepBoundary } from "../index"
import { PRUNE_NOTICE_PREFIX, pruneToolResults, resolveKeepBoundary } from "../toolResultPruner"

/**
 * Unit tests for the deterministic tool-result pruner (WS-C).
 *
 * The store is REAL and backed by a temp directory: an artifact id that is
 * quoted to the model but does not exist on disk is the one failure mode the
 * whole design cannot tolerate, so every "artifact cited" assertion is paired
 * with a file read.
 */

const BUDGET = 4096

let counter = 0

/** A result big enough to prune: 200 short lines, ~10 KB. */
function bigResult(tag: string, lines = 200): string {
	return Array.from({ length: lines }, (_, index) => `${tag} line ${index}`.padEnd(50, ".")).join("\n")
}

/**
 * Filler messages appended to every fixture that passes an explicit boundary.
 *
 * Without them a short fixture's boundary would equal `messages.length`, which
 * the pass reads as `computeCondenseKeepBoundary`'s "summarize everything"
 * SENTINEL and translates into a protected tail (see `resolveKeepBoundary`).
 * The tests below are about budget, bypass lists and idempotency, so they use
 * histories long enough that their boundary is a real index. The sentinel itself
 * gets its own tests, which deliberately skip this padding.
 */
function tail(): ApiMessage[] {
	return Array.from({ length: 6 }, (_, index) => ({
		role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
		content: `filler turn ${index}`,
		ts: 1000 + index,
	}))
}

/** Build an assistant `tool_use` + user `tool_result` pair for a given tool. */
function toolPair(toolName: string, resultContent: string, id?: string): [ApiMessage, ApiMessage] {
	counter += 1
	const useId = id ?? `use-${counter}`
	return [
		{ role: "assistant", content: [{ type: "tool_use", id: useId, name: toolName, input: {} }], ts: counter },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: useId, content: resultContent }], ts: counter },
	]
}

/** The tool_result content for a tool_use_id, flattened to text. */
function resultText(messages: ApiMessage[], toolUseId: string): string | undefined {
	for (const msg of messages) {
		if (msg.role !== "user" || !Array.isArray(msg.content)) continue
		for (const block of msg.content) {
			if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
				const content = (block as Anthropic.Messages.ToolResultBlockParam).content
				if (typeof content === "string") return content
				if (Array.isArray(content)) {
					return content.map((inner) => (inner.type === "text" ? inner.text : "")).join("\n")
				}
				return undefined
			}
		}
	}
	return undefined
}

/** Every tool_use id, in order, so pairing can be compared before and after. */
function toolUseIds(messages: ApiMessage[]): string[] {
	const ids: string[] = []
	for (const msg of messages) {
		if (!Array.isArray(msg.content)) continue
		for (const block of msg.content) {
			if (block.type === "tool_use") ids.push(block.id)
			if (block.type === "tool_result") ids.push(block.tool_use_id)
		}
	}
	return ids
}

describe("pruneToolResults", () => {
	let taskDir: string
	let store: ArtifactStore

	beforeEach(() => {
		counter = 0
		taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-unit-"))
		store = new ArtifactStore(taskDir)
	})

	afterEach(() => {
		fs.rmSync(taskDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("prunes an old oversized result and cites a real artifact id", () => {
		const original = bigResult("alpha")
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", original, "old"),
			...toolPair("search_files", "small", "recent"),
			...tail(),
		]

		const result = pruneToolResults(messages, { keepBoundary: 3, budgetBytes: BUDGET, store })

		expect(result.prunedCount).toBe(1)
		expect(result.artifacts).toHaveLength(1)
		expect(result.artifacts[0]).toMatch(/^prune-\d+\.txt$/)

		const text = resultText(result.messages, "old")!
		expect(text.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)
		expect(text).toContain(`artifact "${result.artifacts[0]}"`)
		// Corrective, weak-model-friendly: it names the tool AND the parameter.
		expect(text).toContain(`Use read_artifact with artifact_id "${result.artifacts[0]}"`)

		// The artifact on disk holds the original, byte for byte.
		const artifactPath = path.join(taskDir, "artifacts", result.artifacts[0])
		expect(fs.readFileSync(artifactPath, "utf8")).toBe(original)
	})

	it("keeps exactly the first 20 and last 20 lines by default", () => {
		const original = bigResult("beta")
		const lines = original.split("\n")
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", original, "old"),
			...tail(),
		]

		const result = pruneToolResults(messages, { keepBoundary: 3, budgetBytes: BUDGET, store })
		const body = resultText(result.messages, "old")!.split("\n").slice(1)

		const separator = body.indexOf("...")
		expect(separator).toBe(20)
		expect(body.slice(0, 20)).toEqual(lines.slice(0, 20))
		expect(body.slice(separator + 1)).toEqual(lines.slice(-20))

		// The notice reports what the preview actually carries.
		expect(resultText(result.messages, "old")).toContain("keeping the first 20 and last 20 lines")
	})

	it("honours a custom head/tail shape", () => {
		const original = bigResult("gamma")
		const lines = original.split("\n")
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", original, "old"),
			...tail(),
		]

		const result = pruneToolResults(messages, {
			keepBoundary: 3,
			budgetBytes: BUDGET,
			store,
			headLines: 5,
			tailLines: 3,
		})
		const body = resultText(result.messages, "old")!.split("\n").slice(1)

		expect(body.slice(0, 5)).toEqual(lines.slice(0, 5))
		expect(body[5]).toBe("...")
		expect(body.slice(6)).toEqual(lines.slice(-3))
	})

	it("never touches the protected recent tail", () => {
		const oldText = bigResult("old")
		const recentText = bigResult("recent")
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", oldText, "old"),
			...toolPair("search_files", recentText, "recent"),
			...tail(),
		]

		// keepBoundary 3 protects messages[3..] (the "recent" pair).
		const result = pruneToolResults(messages, { keepBoundary: 3, budgetBytes: BUDGET, store })

		expect(result.prunedCount).toBe(1)
		expect(resultText(result.messages, "recent")).toBe(recentText)
	})

	it("reads the computeCondenseKeepBoundary sentinel as a tail to protect, not as open season", () => {
		// On a short history `computeCondenseKeepBoundary` answers `messages.length`.
		// That is a SENTINEL for the condense ("no raw tail, summarize everything"),
		// and taken literally by a pruner it would mean "protect nothing" and shred
		// the newest result. The pass must translate it, and the test therefore
		// passes the REAL boundary value rather than substituting a safe one.
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", bigResult("a"), "a"),
		]
		const boundary = computeCondenseKeepBoundary(messages)
		expect(boundary).toBe(messages.length)

		const result = pruneToolResults(messages, { keepBoundary: boundary, budgetBytes: BUDGET, store })

		expect(result.messages).toBe(messages)
		expect(result.prunedCount).toBe(0)
		expect(resultText(result.messages, "a")).toBe(bigResult("a"))
		expect(fs.existsSync(path.join(taskDir, "artifacts"))).toBe(false)
	})

	it("spares the newest CONDENSE_KEEP_RECENT_MESSAGES messages on a short post-condense history", () => {
		// The shape a task has immediately after a condense: a summary plus a few
		// fresh tool turns, which is exactly when the sentinel is returned.
		const messages: ApiMessage[] = [
			{ role: "user", content: "## Conversation Summary", ts: 0, isSummary: true, condenseId: "c1" },
			...toolPair("search_files", bigResult("oldest"), "oldest"),
			...toolPair("search_files", bigResult("middle"), "middle"),
			...toolPair("search_files", bigResult("newer"), "newer"),
			...toolPair("search_files", bigResult("newest"), "newest"),
		]
		const boundary = computeCondenseKeepBoundary(messages)
		expect(boundary).toBe(messages.length)

		const result = pruneToolResults(messages, { keepBoundary: boundary, budgetBytes: BUDGET, store })

		// Only what falls outside the 6-message tail is eligible.
		expect(result.prunedCount).toBe(1)
		expect(resultText(result.messages, "oldest")!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)
		expect(resultText(result.messages, "middle")).toBe(bigResult("middle"))
		expect(resultText(result.messages, "newer")).toBe(bigResult("newer"))
		expect(resultText(result.messages, "newest")).toBe(bigResult("newest"))
	})

	it("clamps the boundary itself, so no caller can opt out of the protected tail", () => {
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", bigResult("a"), "a"),
			...toolPair("search_files", bigResult("b"), "b"),
			...toolPair("search_files", bigResult("c"), "c"),
			...toolPair("search_files", bigResult("d"), "d"),
		]

		// A caller asking for "everything" (or overshooting) still gets the tail.
		expect(resolveKeepBoundary(messages.length, messages.length)).toBe(messages.length - 6)
		expect(resolveKeepBoundary(9_999, messages.length)).toBe(messages.length - 6)
		expect(resolveKeepBoundary(Number.POSITIVE_INFINITY, messages.length)).toBe(messages.length - 6)
		// A real, smaller boundary is honoured as given.
		expect(resolveKeepBoundary(3, messages.length)).toBe(3)
		expect(resolveKeepBoundary(-1, messages.length)).toBe(0)

		const result = pruneToolResults(messages, { keepBoundary: 9_999, budgetBytes: BUDGET, store })
		expect(resultText(result.messages, "d")).toBe(bigResult("d"))
	})

	it("fails closed on a result whose tool_use partner is missing", () => {
		// An orphaned tool_result: its tool_use was condensed away, so the pass
		// cannot tell whether this is bulky search output or a protocol result the
		// bypass list protects. Guessing wrong destroys instructions, so it does
		// not prune.
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "orphan", content: bigResult("orphan") }],
				ts: 1,
			},
			...toolPair("search_files", bigResult("known"), "known"),
			...tail(),
		]

		const result = pruneToolResults(messages, { keepBoundary: 4, budgetBytes: BUDGET, store })

		expect(result.prunedCount).toBe(1)
		expect(resultText(result.messages, "orphan")).toBe(bigResult("orphan"))
		expect(resultText(result.messages, "known")!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)
	})

	it("respects the byte budget: results at or under it stay whole", () => {
		const underBudget = bigResult("small", 40) // ~2 KB
		expect(Buffer.byteLength(underBudget, "utf8")).toBeLessThan(BUDGET)

		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", underBudget, "small"),
			...toolPair("search_files", bigResult("large"), "large"),
			...tail(),
		]

		const result = pruneToolResults(messages, { keepBoundary: 5, budgetBytes: BUDGET, store })

		expect(result.prunedCount).toBe(1)
		expect(resultText(result.messages, "small")).toBe(underBudget)
		expect(resultText(result.messages, "large")!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)
	})

	it("is idempotent: a second pass over its own output changes nothing", () => {
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", bigResult("alpha"), "old"),
			...tail(),
		]

		const first = pruneToolResults(messages, { keepBoundary: 3, budgetBytes: BUDGET, store })
		expect(first.prunedCount).toBe(1)

		const second = pruneToolResults(first.messages, { keepBoundary: 3, budgetBytes: BUDGET, store })

		expect(second.messages).toBe(first.messages)
		expect(second.prunedCount).toBe(0)
		expect(second.artifacts).toEqual([])
		// And no second artifact was written behind the first one.
		expect(fs.readdirSync(path.join(taskDir, "artifacts"))).toHaveLength(1)
	})

	it("skips results the WS-B spill policy already reduced", () => {
		// A genuinely spilled result, produced by the real policy.
		const spilled = applyToolResultSpill(bigResult("spilled", 3000), "search_files", {
			store,
			maxInlineBytes: 24 * 1024,
		})
		expect(spilled.artifactId).toBeDefined()
		expect(Buffer.byteLength(spilled.text, "utf8")).toBeGreaterThan(BUDGET)

		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", spilled.text, "spilled"),
			...tail(),
		]

		const result = pruneToolResults(messages, { keepBoundary: 3, budgetBytes: BUDGET, store })

		expect(result.prunedCount).toBe(0)
		expect(resultText(result.messages, "spilled")).toBe(spilled.text)
	})

	it("skips results microcompaction already cleared, in both shapes", () => {
		const bare = MICROCOMPACT_CLEARED_PLACEHOLDER
		const withNotice = `[Tool result: 300 KB, showing first 60 and last 60 lines. Full output saved as artifact "tool-1.txt". Use read_artifact (search/offset/limit) to inspect the rest.]\n${MICROCOMPACT_CLEARED_PLACEHOLDER}`

		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", bare, "bare"),
			...toolPair("search_files", withNotice, "with-notice"),
			...tail(),
		]

		const result = pruneToolResults(messages, { keepBoundary: 5, budgetBytes: 10, store })

		expect(result.prunedCount).toBe(0)
		expect(resultText(result.messages, "bare")).toBe(bare)
		expect(resultText(result.messages, "with-notice")).toBe(withNotice)
	})

	it("never touches user or assistant text blocks", () => {
		const userText = bigResult("user-said")
		const assistantText = bigResult("assistant-said")
		const messages: ApiMessage[] = [
			{ role: "user", content: userText, ts: 0 },
			{ role: "assistant", content: [{ type: "text", text: assistantText }], ts: 1 },
			{ role: "user", content: [{ type: "text", text: userText }], ts: 2 },
			...toolPair("search_files", bigResult("tool"), "tool"),
			...tail(),
		]

		const result = pruneToolResults(messages, { keepBoundary: 6, budgetBytes: BUDGET, store })

		expect(result.prunedCount).toBe(1)
		expect(result.messages[0].content).toBe(userText)
		expect((result.messages[1].content as Anthropic.Messages.TextBlockParam[])[0].text).toBe(assistantText)
		expect((result.messages[2].content as Anthropic.Messages.TextBlockParam[])[0].text).toBe(userText)
	})

	it("never prunes results of tools on the spill bypass list", () => {
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("read_file", bigResult("file"), "read"),
			...toolPair("skill", bigResult("skill"), "skill"),
			...toolPair("read_artifact", bigResult("artifact"), "artifact"),
			...toolPair("attempt_completion", bigResult("done"), "complete"),
			...toolPair("search_files", bigResult("search"), "search"),
			...tail(),
		]

		const result = pruneToolResults(messages, { keepBoundary: 11, budgetBytes: BUDGET, store })

		expect(result.prunedCount).toBe(1)
		for (const id of ["read", "skill", "artifact", "complete"]) {
			expect(resultText(result.messages, id)!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(false)
		}
		expect(resultText(result.messages, "search")!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)
	})

	it("keeps tool_use/tool_result pairing intact", () => {
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", bigResult("a"), "a"),
			...toolPair("execute_command", bigResult("b"), "b"),
			...toolPair("codebase_search", bigResult("c"), "c"),
			...tail(),
		]
		const idsBefore = toolUseIds(messages)

		const result = pruneToolResults(messages, { keepBoundary: 7, budgetBytes: BUDGET, store })

		expect(result.prunedCount).toBe(3)
		expect(result.messages).toHaveLength(messages.length)
		expect(toolUseIds(result.messages)).toEqual(idsBefore)
		for (let i = 0; i < messages.length; i++) {
			expect(result.messages[i].role).toBe(messages[i].role)
		}
	})

	it("does not mutate the input array or its blocks", () => {
		const original = bigResult("alpha")
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", original, "old"),
			...tail(),
		]
		const blockBefore = (messages[2].content as Anthropic.Messages.ContentBlockParam[])[0]

		const result = pruneToolResults(messages, { keepBoundary: 3, budgetBytes: BUDGET, store })

		expect(result.messages).not.toBe(messages)
		expect((messages[2].content as Anthropic.Messages.ContentBlockParam[])[0]).toBe(blockBefore)
		expect(resultText(messages, "old")).toBe(original)
	})

	it("skips the tool_use_ids the caller reserved for microcompaction", () => {
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", bigResult("a"), "a"),
			...toolPair("search_files", bigResult("b"), "b"),
			...tail(),
		]

		const result = pruneToolResults(messages, {
			keepBoundary: 5,
			budgetBytes: BUDGET,
			store,
			skipToolUseIds: new Set(["a"]),
		})

		expect(result.prunedCount).toBe(1)
		expect(resultText(result.messages, "a")!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(false)
		expect(resultText(result.messages, "b")!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)
	})

	it("keeps the result inline when the artifact write fails", () => {
		const original = bigResult("alpha")
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", original, "old"),
			...tail(),
		]
		vi.spyOn(store, "save").mockImplementation(() => {
			throw new Error("disk full")
		})
		vi.spyOn(console, "warn").mockImplementation(() => {})

		const result = pruneToolResults(messages, { keepBoundary: 3, budgetBytes: BUDGET, store })

		expect(result.messages).toBe(messages)
		expect(result.prunedCount).toBe(0)
		expect(resultText(result.messages, "old")).toBe(original)
	})

	it("prunes oversized text blocks inside an array-shaped result and leaves images alone", () => {
		const original = bigResult("alpha")
		const image: Anthropic.Messages.ImageBlockParam = {
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
		}
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			{ role: "assistant", content: [{ type: "tool_use", id: "old", name: "search_files", input: {} }], ts: 1 },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "old",
						content: [{ type: "text", text: original }, image, { type: "text", text: "tiny" }],
					},
				],
				ts: 2,
			},
			...tail(),
		]

		const result = pruneToolResults(messages, { keepBoundary: 3, budgetBytes: BUDGET, store })

		expect(result.prunedCount).toBe(1)
		const block = (result.messages[2].content as Anthropic.Messages.ContentBlockParam[])[0]
		const inner = (block as Anthropic.Messages.ToolResultBlockParam).content as Array<
			Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam
		>
		expect((inner[0] as Anthropic.Messages.TextBlockParam).text.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)
		expect(inner[1]).toBe(image)
		expect((inner[2] as Anthropic.Messages.TextBlockParam).text).toBe("tiny")
	})

	it("leaves the pre-summary prefix alone: it is already hidden from the API", () => {
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", bigResult("hidden"), "hidden"),
			{ role: "user", content: "## Conversation Summary", ts: 3, isSummary: true, condenseId: "c1" },
			...toolPair("search_files", bigResult("visible"), "visible"),
			...tail(),
		]

		const result = pruneToolResults(messages, { keepBoundary: 6, budgetBytes: BUDGET, store })

		expect(result.prunedCount).toBe(1)
		expect(resultText(result.messages, "hidden")!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(false)
		expect(resultText(result.messages, "visible")!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)
	})

	it("reports bytesSaved as what the conversation actually lost", () => {
		const original = bigResult("alpha")
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", original, "old"),
			...tail(),
		]

		const result = pruneToolResults(messages, { keepBoundary: 3, budgetBytes: BUDGET, store })

		const before = Buffer.byteLength(original, "utf8")
		const after = Buffer.byteLength(resultText(result.messages, "old")!, "utf8")
		expect(result.bytesSaved).toBe(before - after)
		expect(result.bytesSaved).toBeGreaterThan(0)
		expect(result.prunedText).toBe(`${original}\n`)
	})

	it("leaves a result inline when the preview would not save at least half the bytes", () => {
		// 45 lines of 100 chars: over the budget, but the 20+20 preview plus the
		// notice is more than half of it, so pruning is not worth a disk write.
		const marginal = Array.from({ length: 45 }, (_, i) => `line ${i}`.padEnd(100, "-")).join("\n")
		expect(Buffer.byteLength(marginal, "utf8")).toBeGreaterThan(BUDGET)

		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			...toolPair("search_files", marginal, "marginal"),
			...tail(),
		]

		const result = pruneToolResults(messages, { keepBoundary: 3, budgetBytes: BUDGET, store })

		expect(result.prunedCount).toBe(0)
		expect(resultText(result.messages, "marginal")).toBe(marginal)
	})
})
