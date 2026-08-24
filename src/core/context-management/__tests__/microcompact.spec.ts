// cd src && npx vitest run core/context-management/__tests__/microcompact.spec.ts

import type { ModelInfo } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { BaseProvider } from "../../../api/providers/base-provider"
import { ApiMessage } from "../../task-persistence/apiMessages"

import {
	microcompactToolResults,
	selectMicrocompactTargets,
	microcompactTargetChars,
	MICROCOMPACT_CLEARED_PLACEHOLDER,
	MICROCOMPACT_PLACEHOLDER_CHARS,
	MICROCOMPACT_CHARS_PER_TOKEN,
	MICROCOMPACT_TARGET_MARGIN,
	MICROCOMPACT_MIN_KEEP,
	MICROCOMPACT_CLEAR_FLOOR_CHARS,
	MICROCOMPACT_PROTECT_MAX_CHARS,
	COMPACTABLE_TOOL_NAMES,
	type MicrocompactCandidate,
} from "../microcompact"
import { manageContext } from "../index"

let counter = 0

/** Content comfortably above `MICROCOMPACT_CLEAR_FLOOR_CHARS`, so size never masks the behaviour under test. */
function bigText(label: string, chars = MICROCOMPACT_CLEAR_FLOOR_CHARS * 2): string {
	return `${label} `.repeat(Math.ceil(chars / (label.length + 1))).slice(0, chars)
}

/**
 * Build an assistant `tool_use` + user `tool_result` pair for a given tool.
 * The result content is a single string (the common case).
 */
function toolPair(toolName: string, resultContent: string, id?: string): [ApiMessage, ApiMessage] {
	counter += 1
	const useId = id ?? `tool-${counter}`
	const assistant: ApiMessage = {
		role: "assistant",
		content: [{ type: "tool_use", id: useId, name: toolName, input: {} }],
		ts: counter,
	}
	const user: ApiMessage = {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: useId, content: resultContent }],
		ts: counter,
	}
	return [assistant, user]
}

function firstUser(): ApiMessage {
	return { role: "user", content: "Initial task", ts: 0 }
}

/** Find the tool_result content for a given tool_use_id in a message list. */
function resultContentFor(messages: ApiMessage[], toolUseId: string): unknown {
	for (const msg of messages) {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
					return block.content
				}
			}
		}
	}
	return undefined
}

function candidate(toolUseId: string, chars: number, critical = false): MicrocompactCandidate {
	return { toolUseId, chars, critical }
}

// --- Budget conversion ----------------------------------------------------------------

describe("microcompactTargetChars", () => {
	it("selects nothing when there is no pressure", () => {
		expect(microcompactTargetChars(0)).toBe(0)
		expect(microcompactTargetChars(-500)).toBe(0)
		expect(microcompactTargetChars(Number.NaN)).toBe(0)
		expect(microcompactTargetChars(Number.POSITIVE_INFINITY)).toBe(0)
	})

	it("converts the token overage to chars with the overshoot margin", () => {
		expect(microcompactTargetChars(1000)).toBe(
			Math.ceil(1000 * MICROCOMPACT_TARGET_MARGIN * MICROCOMPACT_CHARS_PER_TOKEN),
		)
		// Overshooting is deliberate: landing exactly on the threshold re-selects next turn.
		expect(microcompactTargetChars(1000)).toBeGreaterThan(1000 * MICROCOMPACT_CHARS_PER_TOKEN)
	})
})

// --- Selection policy -----------------------------------------------------------------

describe("selectMicrocompactTargets", () => {
	/** Ten 10k results, oldest first: enough eligible mass to make every term visible. */
	function tenBig(): MicrocompactCandidate[] {
		return Array.from({ length: 10 }, (_, i) => candidate(`c-${i}`, 10_000))
	}

	it("stops as soon as the target is met, clearing the OLDEST results first", () => {
		// Two results' worth of net reclaim requested -> exactly two cleared, from the front.
		const net = 10_000 - MICROCOMPACT_PLACEHOLDER_CHARS
		const selection = selectMicrocompactTargets(tenBig(), { targetChars: net * 2 })

		expect([...selection.clearIds]).toEqual(["c-0", "c-1"])
		expect(selection.reclaimedChars).toBe(net * 2)
	})

	it("clears everything eligible when no target is given", () => {
		const selection = selectMicrocompactTargets(tenBig())
		expect(selection.clearIds.size).toBe(10 - MICROCOMPACT_MIN_KEEP)
	})

	it("never clears the newest minKeep results, however large the target", () => {
		const selection = selectMicrocompactTargets(tenBig(), { targetChars: Number.POSITIVE_INFINITY })

		for (let i = 10 - MICROCOMPACT_MIN_KEEP; i < 10; i++) {
			expect(selection.clearIds.has(`c-${i}`)).toBe(false)
		}
	})

	it("never clears results below the reclaim floor, at any age or pressure", () => {
		// Small results are 55% of items but 7% of bytes: clearing them destroys facts for
		// almost no reclaim, and failures are the smallest results of all.
		const candidates = [
			candidate("tiny-0", 200),
			candidate("tiny-1", MICROCOMPACT_CLEAR_FLOOR_CHARS - 1),
			candidate("big", 50_000),
			...Array.from({ length: MICROCOMPACT_MIN_KEEP }, (_, i) => candidate(`keep-${i}`, 9_000)),
		]

		const selection = selectMicrocompactTargets(candidates, { targetChars: Number.POSITIVE_INFINITY })

		expect([...selection.clearIds]).toEqual(["big"])
	})

	it("counts reclaim NET of the placeholder it writes back", () => {
		const selection = selectMicrocompactTargets([candidate("a", 5_000), ...tenBig()], {
			targetChars: 1,
		})
		expect(selection.reclaimedChars).toBe(5_000 - MICROCOMPACT_PLACEHOLDER_CHARS)
	})

	it("protects critical results while the target can be met without them", () => {
		const candidates = [
			candidate("err", 3_000, true), // small failure: exactly what keep-5 threw away
			candidate("listing-0", 30_000),
			candidate("listing-1", 30_000),
			...Array.from({ length: MICROCOMPACT_MIN_KEEP }, (_, i) => candidate(`keep-${i}`, 9_000)),
		]

		const selection = selectMicrocompactTargets(candidates, { targetChars: 20_000 })

		expect(selection.clearIds.has("err")).toBe(false)
		expect(selection.clearIds.has("listing-0")).toBe(true)
		expect(selection.protectedCount).toBe(1)
		expect(selection.releasedProtectedCount).toBe(0)
	})

	it("does not protect a critical result larger than the protection cap", () => {
		// A 140 KB failing-build log is still a listing, whatever the ledger says about it.
		const candidates = [
			candidate("huge-error", MICROCOMPACT_PROTECT_MAX_CHARS + 1, true),
			...Array.from({ length: MICROCOMPACT_MIN_KEEP }, (_, i) => candidate(`keep-${i}`, 9_000)),
		]

		const selection = selectMicrocompactTargets(candidates, { targetChars: 1 })

		expect(selection.clearIds.has("huge-error")).toBe(true)
		expect(selection.protectedCount).toBe(0)
	})

	it("releases protection rather than fall short and hand the task to the condenser", () => {
		const candidates = [
			candidate("err-0", 5_000, true),
			candidate("err-1", 5_000, true),
			...Array.from({ length: MICROCOMPACT_MIN_KEEP }, (_, i) => candidate(`keep-${i}`, 9_000)),
		]

		const selection = selectMicrocompactTargets(candidates, { targetChars: 9_000 })

		expect(selection.clearIds.size).toBe(2)
		expect(selection.releasedProtectedCount).toBe(2)
		expect(selection.protectedCount).toBe(0)
	})

	it("releases protection oldest-first and stops the moment the target is met", () => {
		const candidates = [
			candidate("err-0", 5_000, true),
			candidate("err-1", 5_000, true),
			...Array.from({ length: MICROCOMPACT_MIN_KEEP }, (_, i) => candidate(`keep-${i}`, 9_000)),
		]

		const selection = selectMicrocompactTargets(candidates, { targetChars: 1_000 })

		expect([...selection.clearIds]).toEqual(["err-0"])
		expect(selection.releasedProtectedCount).toBe(1)
		expect(selection.protectedCount).toBe(1)
	})

	it("keeps previously cleared results cleared, even when policy would now spare them", () => {
		// Prefix monotonicity: re-inflating a result moves the first differing byte
		// backwards and voids the provider's prompt cache from that point on.
		const candidates = [
			candidate("tiny", 200), // below the floor
			candidate("err", 3_000, true), // protected
			candidate("recent-0", 30_000),
			candidate("recent-1", 30_000),
			candidate("recent-2", 30_000), // all three inside minKeep
		]

		const selection = selectMicrocompactTargets(candidates, {
			targetChars: 0,
			alreadyCleared: new Set(["tiny", "err", "recent-2"]),
		})

		expect(selection.clearIds).toEqual(new Set(["tiny", "err", "recent-2"]))
	})

	it("grows the cleared set monotonically as pressure rises", () => {
		const candidates = tenBig()
		const net = 10_000 - MICROCOMPACT_PLACEHOLDER_CHARS

		const first = selectMicrocompactTargets(candidates, { targetChars: net * 3 })
		// Pressure eases, but the previous decision is carried forward.
		const second = selectMicrocompactTargets(candidates, {
			targetChars: net,
			alreadyCleared: first.clearIds,
		})

		for (const id of first.clearIds) {
			expect(second.clearIds.has(id)).toBe(true)
		}
		expect(second.clearIds.size).toBe(first.clearIds.size)
	})

	it("returns an empty selection for an empty candidate list", () => {
		const selection = selectMicrocompactTargets([], { targetChars: 100_000 })
		expect(selection.clearIds.size).toBe(0)
		expect(selection.reclaimedChars).toBe(0)
	})
})

// --- End-to-end over a message history ------------------------------------------------

describe("microcompactToolResults", () => {
	beforeEach(() => {
		counter = 0
	})

	it("clears the oldest compactable results until the target is met, keeping the rest raw", () => {
		const pairs: ApiMessage[] = []
		for (let i = 0; i < 8; i++) {
			pairs.push(...toolPair("read_file", bigText(`contents of file ${i}`, 10_000), `read-${i}`))
		}
		const messages = [firstUser(), ...pairs]

		// Ask for two results' worth of net reclaim.
		const result = microcompactToolResults(messages, { targetChars: (10_000 - MICROCOMPACT_PLACEHOLDER_CHARS) * 2 })

		expect(result.clearedCount).toBe(2)
		expect(result.clearedToolUseIds).toEqual(["read-0", "read-1"])
		expect(result.candidateCount).toBe(8)

		for (const id of ["read-0", "read-1"]) {
			expect(resultContentFor(result.messages, id)).toBe(MICROCOMPACT_CLEARED_PLACEHOLDER)
		}
		// Everything the target did not require stays at full fidelity.
		for (let i = 2; i < 8; i++) {
			expect(resultContentFor(result.messages, `read-${i}`)).toContain(`contents of file ${i}`)
		}
		// Original content surfaced in clearedText for token accounting.
		expect(result.clearedText).toContain("contents of file 0")
		expect(result.clearedText).not.toContain("contents of file 7")
	})

	it("is a no-op (same reference) when there are at most minKeep compactable results", () => {
		const pairs: ApiMessage[] = []
		for (let i = 0; i < MICROCOMPACT_MIN_KEEP; i++) {
			pairs.push(...toolPair("read_file", bigText(`file ${i}`, 20_000)))
		}
		const messages = [firstUser(), ...pairs]

		const result = microcompactToolResults(messages, { targetChars: Number.POSITIVE_INFINITY })

		expect(result.clearedCount).toBe(0)
		expect(result.messages).toBe(messages) // unchanged reference
	})

	it("is a no-op when nothing is over budget", () => {
		const pairs: ApiMessage[] = []
		for (let i = 0; i < 8; i++) {
			pairs.push(...toolPair("read_file", bigText(`file ${i}`, 20_000)))
		}
		const messages = [firstUser(), ...pairs]

		const result = microcompactToolResults(messages, { targetChars: 0 })

		expect(result.clearedCount).toBe(0)
		expect(result.candidateCount).toBe(8)
		expect(result.messages).toBe(messages)
	})

	it("never clears results from non-compactable tools (e.g. attempt_completion, update_todo_list)", () => {
		// Sanity on the whitelist itself.
		expect(COMPACTABLE_TOOL_NAMES.has("attempt_completion")).toBe(false)
		expect(COMPACTABLE_TOOL_NAMES.has("update_todo_list")).toBe(false)
		expect(COMPACTABLE_TOOL_NAMES.has("read_file")).toBe(true)

		const pairs: ApiMessage[] = []
		// Lots of (old) attempt_completion + update_todo_list results, all large.
		for (let i = 0; i < 6; i++) {
			pairs.push(...toolPair("attempt_completion", bigText(`completion ${i}`, 20_000), `done-${i}`))
			pairs.push(...toolPair("update_todo_list", bigText(`todos ${i}`, 20_000), `todo-${i}`))
		}
		const messages = [firstUser(), ...pairs]

		const result = microcompactToolResults(messages, { targetChars: Number.POSITIVE_INFINITY })

		expect(result.clearedCount).toBe(0)
		expect(result.candidateCount).toBe(0)
		expect(result.messages).toBe(messages)
	})

	it("spares small results the old count-based rule would have cleared", () => {
		// A 123-char test failure surrounded by listings: the exact inversion the
		// count rule produced (cheapest to keep, most expensive to lose).
		const messages = [
			firstUser(),
			...toolPair("execute_command", "FAIL tests/auth.spec.ts — expected 200, got 401", "err"),
			...toolPair("list_files", bigText("src/components/widget", 40_000), "listing"),
			...toolPair("read_file", bigText("recent a", 20_000), "recent-a"),
			...toolPair("read_file", bigText("recent b", 20_000), "recent-b"),
			...toolPair("read_file", bigText("recent c", 20_000), "recent-c"),
		]

		const result = microcompactToolResults(messages, { targetChars: Number.POSITIVE_INFINITY })

		expect(result.clearedToolUseIds).toEqual(["listing"])
		expect(resultContentFor(result.messages, "err")).toContain("expected 200, got 401")
	})

	it("protects results the ledger marks critical", () => {
		const messages = [
			firstUser(),
			...toolPair("execute_command", bigText("npm test output", 6_000), "test-run"),
			...toolPair("list_files", bigText("listing", 40_000), "listing"),
			...toolPair("read_file", bigText("recent a", 20_000), "recent-a"),
			...toolPair("read_file", bigText("recent b", 20_000), "recent-b"),
			...toolPair("read_file", bigText("recent c", 20_000), "recent-c"),
		]

		const result = microcompactToolResults(messages, {
			targetChars: 10_000,
			criticalToolUseIds: new Set(["test-run"]),
		})

		expect(result.clearedToolUseIds).toEqual(["listing"])
		expect(result.protectedCount).toBe(1)
		expect(result.releasedProtectedCount).toBe(0)
	})

	it("carries a previous pass's decisions forward even when the target has dropped to zero", () => {
		const messages = [
			firstUser(),
			...toolPair("read_file", bigText("old", 20_000), "old-0"),
			...toolPair("read_file", bigText("recent a", 20_000), "recent-a"),
			...toolPair("read_file", bigText("recent b", 20_000), "recent-b"),
			...toolPair("read_file", bigText("recent c", 20_000), "recent-c"),
		]

		const result = microcompactToolResults(messages, {
			targetChars: 0,
			alreadyClearedToolUseIds: new Set(["old-0"]),
		})

		expect(result.clearedToolUseIds).toEqual(["old-0"])
		expect(resultContentFor(result.messages, "old-0")).toBe(MICROCOMPACT_CLEARED_PLACEHOLDER)
	})

	it("is idempotent: re-running does not re-clear or re-count already cleared blocks", () => {
		const pairs: ApiMessage[] = []
		for (let i = 0; i < 8; i++) {
			pairs.push(...toolPair("search_files", bigText(`match ${i}`, 10_000), `s-${i}`))
		}
		const messages = [firstUser(), ...pairs]

		const first = microcompactToolResults(messages, { targetChars: Number.POSITIVE_INFINITY })
		expect(first.clearedCount).toBe(8 - MICROCOMPACT_MIN_KEEP)

		const second = microcompactToolResults(first.messages, { targetChars: Number.POSITIVE_INFINITY })
		expect(second.clearedCount).toBe(0)
		expect(second.messages).toBe(first.messages) // nothing new to clear
	})

	it("handles tool_result content given as an array of text blocks", () => {
		const pairs: ApiMessage[] = []
		for (let i = 0; i < 7; i++) {
			counter += 1
			const useId = `arr-${i}`
			pairs.push({
				role: "assistant",
				content: [{ type: "tool_use", id: useId, name: "read_file", input: {} }],
				ts: counter,
			})
			pairs.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: useId,
						content: [{ type: "text", text: bigText(`block text ${i}`, 10_000) }],
					},
				],
				ts: counter,
			})
		}
		const messages = [firstUser(), ...pairs]

		const result = microcompactToolResults(messages, { targetChars: Number.POSITIVE_INFINITY })

		expect(result.clearedCount).toBe(7 - MICROCOMPACT_MIN_KEEP)
		expect(resultContentFor(result.messages, "arr-0")).toBe(MICROCOMPACT_CLEARED_PLACEHOLDER)
		expect(result.clearedText).toContain("block text 0")
		// Kept tail keeps the array form intact.
		expect(resultContentFor(result.messages, "arr-6")).toEqual([
			{ type: "text", text: bigText("block text 6", 10_000) },
		])
	})

	it("only considers the effective history (ignores condensed-away messages)", () => {
		// 4 old read_file pairs that were condensed away (tagged + a summary), then
		// MICROCOMPACT_MIN_KEEP recent pairs. Effective compactable = minKeep -> no-op.
		const summaryId = "summary-1"
		const old: ApiMessage[] = []
		for (let i = 0; i < 4; i++) {
			const [a, u] = toolPair("read_file", bigText(`old ${i}`, 20_000), `old-${i}`)
			a.condenseParent = summaryId
			u.condenseParent = summaryId
			old.push(a, u)
		}
		const summary: ApiMessage = {
			role: "user",
			content: [{ type: "text", text: "## Conversation Summary\nstuff" }],
			ts: 1000,
			isSummary: true,
			condenseId: summaryId,
		}
		const recent: ApiMessage[] = []
		for (let i = 0; i < MICROCOMPACT_MIN_KEEP; i++) {
			recent.push(...toolPair("read_file", bigText(`recent ${i}`, 20_000), `recent-${i}`))
		}
		const messages = [firstUser(), ...old, summary, ...recent]

		const result = microcompactToolResults(messages, { targetChars: Number.POSITIVE_INFINITY })

		expect(result.candidateCount).toBe(MICROCOMPACT_MIN_KEEP)
		expect(result.clearedCount).toBe(0)
	})

	describe("spilled results", () => {
		/** A tool result the spill policy already reduced to notice + preview. */
		function spilledResult(artifactId: string, label: string): string {
			const notice =
				`[Tool result: 412 KB, showing first 60 and last 60 lines. ` +
				`Full output saved as artifact "${artifactId}". ` +
				`Use read_artifact (search/offset/limit) to inspect the rest.]`
			return `${notice}\n${bigText(label, 10_000)}`
		}

		it("keeps the artifact notice when clearing a spilled result", () => {
			const pairs: ApiMessage[] = []
			for (let i = 0; i < 8; i++) {
				pairs.push(
					...toolPair("search_files", spilledResult(`tool-170611923456${i}.txt`, `hit ${i}`), `sp-${i}`),
				)
			}
			const messages = [firstUser(), ...pairs]

			const result = microcompactToolResults(messages, { targetChars: Number.POSITIVE_INFINITY })

			const cleared = resultContentFor(result.messages, "sp-0") as string
			// The recovery path survives: id + how to reach it.
			expect(cleared).toContain('artifact "tool-1706119234560.txt"')
			expect(cleared).toContain("read_artifact")
			// The bulky preview does not.
			expect(cleared).not.toContain("hit 0 hit 0")
			expect(cleared.endsWith(MICROCOMPACT_CLEARED_PLACEHOLDER)).toBe(true)
		})

		it("still writes the bare placeholder for results that were never spilled", () => {
			const pairs: ApiMessage[] = []
			for (let i = 0; i < 8; i++) {
				pairs.push(...toolPair("search_files", bigText(`plain hit ${i}`, 10_000), `plain-${i}`))
			}
			const messages = [firstUser(), ...pairs]

			const result = microcompactToolResults(messages, { targetChars: Number.POSITIVE_INFINITY })

			expect(resultContentFor(result.messages, "plain-0")).toBe(MICROCOMPACT_CLEARED_PLACEHOLDER)
		})

		it("does not re-clear an already cleared spilled result", () => {
			const pairs: ApiMessage[] = []
			for (let i = 0; i < 8; i++) {
				pairs.push(
					...toolPair("search_files", spilledResult(`tool-170611923456${i}.txt`, `hit ${i}`), `sp-${i}`),
				)
			}
			const messages = [firstUser(), ...pairs]

			const once = microcompactToolResults(messages, { targetChars: Number.POSITIVE_INFINITY })
			const twice = microcompactToolResults(once.messages, { targetChars: Number.POSITIVE_INFINITY })

			expect(twice.clearedCount).toBe(0)
			expect(twice.messages).toBe(once.messages)
		})
	})
})

// --- Integration with manageContext ---------------------------------------------------

class MockApiHandler extends BaseProvider {
	createMessage(): any {
		const mockStream = {
			async *[Symbol.asyncIterator]() {
				yield { type: "text", text: "Mock summary content" }
				yield { type: "usage", inputTokens: 100, outputTokens: 50, totalCost: 0.01 }
			},
		}
		return mockStream
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "test-model",
			info: {
				contextWindow: 30000,
				maxTokens: 1000,
				supportsPromptCache: true,
				supportsImages: false,
				inputPrice: 0,
				outputPrice: 0,
				description: "Test model",
			},
		}
	}
}

describe("manageContext microcompaction pre-pass", () => {
	const apiHandler = new MockApiHandler()
	const taskId = "microcompact-task"

	beforeEach(() => {
		counter = 0
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
	})

	function bigReadPairs(count: number, charsEach: number): ApiMessage[] {
		const out: ApiMessage[] = []
		for (let i = 0; i < count; i++) {
			out.push(...toolPair("read_file", bigText(`file ${i} contents`, charsEach), `big-${i}`))
		}
		return out
	}

	it("takes the quiet path: microcompaction frees enough, so no summarization runs", async () => {
		const messages = [firstUser(), ...bigReadPairs(10, 6000)]

		const result = await manageContext({
			messages,
			totalTokens: 16000, // ~53% of 30000 -> over the 50% threshold, under allowedTokens (26000)
			contextWindow: 30000,
			maxTokens: 1000,
			apiHandler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 50,
			systemPrompt: "sys",
			taskId,
			profileThresholds: {},
			currentProfileId: "default",
		})

		expect(result.microcompacted).toBe(true)
		expect(result.summary).toBe("") // no summarization
		expect(result.truncationId).toBeUndefined() // no truncation

		// Need-adaptive: a modest overage clears a few of the oldest results, not the
		// whole eligible set. The old rule always cleared everything but the last five.
		const cleared = result.microcompactClearedToolUseIds ?? []
		expect(cleared.length).toBeGreaterThan(0)
		expect(cleared.length).toBeLessThan(10 - MICROCOMPACT_MIN_KEEP)
		// Oldest-first prefix, so the sent prefix diverges as late as possible.
		expect(cleared).toEqual(Array.from({ length: cleared.length }, (_, i) => `big-${i}`))

		// Non-destructive contract: stored history stays pristine (same reference);
		// the clearing decision is carried as ids and applied only at send time.
		expect(result.messages).toBe(messages) // pristine — nothing persisted
		expect(resultContentFor(result.messages, "big-0")).not.toBe(MICROCOMPACT_CLEARED_PLACEHOLDER)
		expect(resultContentFor(result.messages, "big-0")).toContain("file 0 contents")
	})

	it("escalates to summarization when microcompaction does not free enough", async () => {
		// Same large reads, but context is so far over that even after clearing everything
		// eligible we remain above the condense threshold -> full summarization runs.
		const messages = [firstUser(), ...bigReadPairs(10, 6000)]

		const result = await manageContext({
			messages,
			totalTokens: 29000, // ~97% of 30000
			contextWindow: 30000,
			maxTokens: 1000,
			apiHandler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 50,
			systemPrompt: "sys",
			taskId,
			profileThresholds: {},
			currentProfileId: "default",
		})

		expect(result.microcompacted).toBe(true)
		// Everything eligible cleared; only the immediate working set survives.
		expect(result.microcompactClearedCount).toBe(10 - MICROCOMPACT_MIN_KEEP)
		expect(result.summary).toBe("Mock summary content") // summarization ran
	})

	it("does not re-inflate results a previous pass cleared", async () => {
		const messages = [firstUser(), ...bigReadPairs(10, 6000)]

		const result = await manageContext({
			messages,
			totalTokens: 16000,
			contextWindow: 30000,
			maxTokens: 1000,
			apiHandler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 50,
			systemPrompt: "sys",
			taskId,
			profileThresholds: {},
			currentProfileId: "default",
			// A prior, higher-pressure turn had cleared six results.
			previouslyClearedToolUseIds: new Set(["big-0", "big-1", "big-2", "big-3", "big-4", "big-5"]),
		})

		expect(result.microcompactClearedToolUseIds).toEqual(["big-0", "big-1", "big-2", "big-3", "big-4", "big-5"])
	})
})
