// npx vitest run core/condense/__tests__/keep-recent-tail.spec.ts

import { ApiHandler } from "../../../api"
import { ApiMessage } from "../../task-persistence/apiMessages"

import {
	summarizeConversation,
	getEffectiveApiHistory,
	computeCondenseKeepBoundary,
	toolPairsSatisfiedFrom,
	CONDENSE_KEEP_RECENT_MESSAGES,
	CONDENSE_MIN_SUMMARIZED_MESSAGES,
} from "../index"

vi.mock("../../../api/transform/image-cleaning", () => ({
	maybeRemoveImageBlocks: vi.fn((messages: ApiMessage[], _apiHandler: ApiHandler) => [...messages]),
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		// Condensing now reports what the call cost (services/model_attribution
		// on the backend groups it under completionKind "condense"), so the mock
		// has to answer `hasInstance` as well.
		hasInstance: vi.fn().mockReturnValue(true),
		instance: {
			captureContextCondensed: vi.fn(),
			captureLlmCompletion: vi.fn(),
		},
	},
}))

const taskId = "keep-recent-tail-task"

/** A plain (no tool blocks) conversation of `n` messages, alternating user/assistant. */
function plainConversation(n: number): ApiMessage[] {
	const out: ApiMessage[] = [{ role: "user", content: "Initial task", ts: 1 }]
	for (let i = 1; i < n; i++) {
		out.push({
			role: i % 2 === 1 ? "assistant" : "user",
			content: `message ${i}`,
			ts: i + 1,
		})
	}
	return out
}

describe("computeCondenseKeepBoundary", () => {
	it("returns messages.length (no tail) below the gate", () => {
		// Gate is keepRecent + CONDENSE_MIN_SUMMARIZED_MESSAGES = 6 + 4 = 10.
		const messages = plainConversation(CONDENSE_KEEP_RECENT_MESSAGES + CONDENSE_MIN_SUMMARIZED_MESSAGES - 1) // 9
		expect(computeCondenseKeepBoundary(messages)).toBe(messages.length)
	})

	it("keeps the last keepRecent messages once the region is large enough", () => {
		const messages = plainConversation(20)
		// No tool pairs -> boundary is exactly length - keepRecent.
		expect(computeCondenseKeepBoundary(messages)).toBe(20 - CONDENSE_KEEP_RECENT_MESSAGES)
	})

	it("pulls the boundary backward so it never splits a tool_use/tool_result pair", () => {
		const messages = plainConversation(20)
		// Place a tool pair straddling the default boundary (index 14): the matching
		// tool_use sits at 13 (in the prefix) while its tool_result sits at 14 (in the tail).
		messages[13] = {
			role: "assistant",
			content: [{ type: "tool_use", id: "pair-1", name: "read_file", input: {} }],
			ts: 14,
		}
		messages[14] = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "pair-1", content: "file contents" }],
			ts: 15,
		}
		// Default boundary 14 would orphan the tool_result, so it is pulled back to 13.
		expect(computeCondenseKeepBoundary(messages)).toBe(13)
	})

	it("never lets the tail reach a prior summary (floor)", () => {
		const messages = plainConversation(16)
		messages[3] = {
			role: "user",
			content: "## Conversation Summary\nolder",
			ts: 4,
			isSummary: true,
			condenseId: "old",
		}
		// Make every message after the prior summary an orphan tool_result so the
		// tool-pairing walk would otherwise march the boundary all the way down.
		for (let i = 4; i < 16; i++) {
			messages[i] = {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: `orphan-${i}`, content: "x" }],
				ts: i + 1,
			}
		}
		// With the forward fallback, no boundary < messages.length satisfies
		// (every tail has orphan results), so the function returns messages.length
		// (fresh start) rather than a floor-clamped boundary that splits pairs.
		// The floor guarantee still holds: the returned boundary (16) is above the
		// floor (4), so the prior summary is never swallowed into the tail.
		expect(computeCondenseKeepBoundary(messages)).toBe(16)
	})

	it("respects a keepRecent override", () => {
		const messages = plainConversation(20)
		expect(computeCondenseKeepBoundary(messages, 3)).toBe(20 - 3)
	})

	// --- Forward-fallback cases (register tech-debt: capped backward pull splits a pair) ---

	it("forward fallback: never returns a boundary that splits a tool pair when backward is capped", () => {
		// 20 messages, keepRecent=4. Backward window is [12, 16].
		// Messages 12-16: every user message carries an orphan tool_result (its tool_use
		// sits in the prefix, before the window). Assistant messages in the window are
		// plain text (no tool_use), so every boundary in [12, 16] has at least one
		// orphaned tool_result in the tail → toolPairsSatisfiedFrom returns false.
		// Messages 17-19: clean plain text (no tool blocks). Boundary 17 starts a tail
		// with no tool_results at all → trivially satisfied.
		//
		// Pre-fix: backward loop exhausts at minBoundary=12, returns 12 (splits pair at msg 12).
		// Post-fix: forward search from 16 finds boundary 17 (satisfied) → returns 17.
		const messages = plainConversation(20)
		messages[12] = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "ghost-12", content: "x" }],
			ts: 13,
		}
		messages[13] = { role: "assistant", content: "text", ts: 14 }
		messages[14] = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "ghost-14", content: "x" }],
			ts: 15,
		}
		messages[15] = { role: "assistant", content: "text", ts: 16 }
		messages[16] = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "ghost-16", content: "x" }],
			ts: 17,
		}
		// 17-19 stay as plain text from plainConversation(20) — no tool blocks.

		const keepRecent = 4
		const boundary = computeCondenseKeepBoundary(messages, keepRecent)
		// The returned boundary must satisfy toolPairsSatisfiedFrom.
		expect(toolPairsSatisfiedFrom(messages, boundary)).toBe(true)
		// Specifically, the forward fallback should land at 17 (first clean boundary).
		expect(boundary).toBe(17)
	})

	it("degenerate case: no satisfying boundary except messages.length returns messages.length", () => {
		// Every user message in the tail region carries an orphan tool_result whose
		// matching tool_use is in the prefix. The last message is also an orphan
		// tool_result, so no boundary < messages.length is satisfied.
		// Forward search terminates at messages.length (empty tail = fresh start).
		const messages = plainConversation(20)
		messages[12] = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "ghost-12", content: "x" }],
			ts: 13,
		}
		messages[13] = { role: "assistant", content: "text", ts: 14 }
		messages[14] = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "ghost-14", content: "x" }],
			ts: 15,
		}
		messages[15] = { role: "assistant", content: "text", ts: 16 }
		messages[16] = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "ghost-16", content: "x" }],
			ts: 17,
		}
		messages[17] = { role: "assistant", content: "text", ts: 18 }
		messages[18] = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "ghost-18", content: "x" }],
			ts: 19,
		}
		messages[19] = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "ghost-19", content: "x" }],
			ts: 20,
		}

		const keepRecent = 4
		const boundary = computeCondenseKeepBoundary(messages, keepRecent)
		expect(boundary).toBe(messages.length)
		expect(toolPairsSatisfiedFrom(messages, boundary)).toBe(true)
	})

	it("regression: backward-satisfiable fixture returns the same boundary as before the change", () => {
		// The existing "pulls backward" test already asserts boundary === 13 for the
		// default keepRecent. Here we assert the same with an explicit keepRecent
		// and verify it's identical to what the backward pull alone would produce.
		const messages = plainConversation(20)
		messages[13] = {
			role: "assistant",
			content: [{ type: "tool_use", id: "pair-1", name: "read_file", input: {} }],
			ts: 14,
		}
		messages[14] = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "pair-1", content: "file contents" }],
			ts: 15,
		}
		const keepRecent = 6
		// Boundary at 14 splits the pair (tool_result at 14 orphaned); pulled back to 13.
		expect(computeCondenseKeepBoundary(messages, keepRecent)).toBe(13)
		// Also verify the invariant holds.
		expect(toolPairsSatisfiedFrom(messages, 13)).toBe(true)
	})
})

describe("summarizeConversation keep-recent-tail integration", () => {
	let mockApiHandler: ApiHandler

	beforeEach(() => {
		vi.clearAllMocks()
		mockApiHandler = {
			createMessage: vi.fn().mockReturnValue(
				(async function* () {
					yield { type: "text" as const, text: "A summary" }
					yield { type: "usage" as const, totalCost: 0.02, outputTokens: 80 }
				})(),
			),
			countTokens: vi.fn().mockResolvedValue(100),
			getModel: vi.fn().mockReturnValue({
				id: "test-model",
				info: {
					contextWindow: 8000,
					supportsImages: false,
					maxTokens: 4000,
					supportsPromptCache: true,
				},
			}),
		} as unknown as ApiHandler
	})

	it("keeps the recent raw tail in the effective history after condensing a large conversation", async () => {
		const messages = plainConversation(20)

		const result = await summarizeConversation({
			messages,
			apiHandler: mockApiHandler,
			systemPrompt: "sys",
			taskId,
		})

		expect(result.error).toBeUndefined()
		expect(result.summary).toBe("A summary")

		// Storage: [..prefix(tagged), summary, ..tail(raw)] -> 20 originals + 1 summary.
		expect(result.messages.length).toBe(21)

		const summaryMessage = result.messages.find((m) => m.isSummary)!
		expect(summaryMessage).toBeDefined()
		const condenseId = summaryMessage.condenseId

		const boundary = 20 - CONDENSE_KEEP_RECENT_MESSAGES // 14
		const summaryIndex = result.messages.indexOf(summaryMessage)
		expect(summaryIndex).toBe(boundary)

		// Prefix (before the summary) is tagged; tail (after the summary) is NOT.
		for (let i = 0; i < summaryIndex; i++) {
			expect(result.messages[i].condenseParent).toBe(condenseId)
		}
		const tail = result.messages.slice(summaryIndex + 1)
		expect(tail).toHaveLength(CONDENSE_KEEP_RECENT_MESSAGES)
		for (const msg of tail) {
			expect(msg.condenseParent).toBeUndefined()
		}
		// Tail is byte-identical to the original recent messages.
		expect(tail).toEqual(messages.slice(boundary))

		// Effective history is the summary followed by the raw tail (fresh start + working set).
		const effective = getEffectiveApiHistory(result.messages)
		expect(effective).toHaveLength(1 + CONDENSE_KEEP_RECENT_MESSAGES)
		expect(effective[0].isSummary).toBe(true)
		expect(effective.slice(1)).toEqual(messages.slice(boundary))

		// newContextTokens includes the tail: countTokens (mocked 100) is summed for
		// the summary block set and again for the tail block set => 200.
		expect(result.newContextTokens).toBe(200)
	})

	it("falls back to classic fresh-start (no tail) on a small conversation", async () => {
		const messages = plainConversation(8) // below the gate

		const result = await summarizeConversation({
			messages,
			apiHandler: mockApiHandler,
			systemPrompt: "sys",
			taskId,
		})

		// Summary is the last message and the effective history is summary-only.
		const last = result.messages[result.messages.length - 1]
		expect(last.isSummary).toBe(true)
		const effective = getEffectiveApiHistory(result.messages)
		expect(effective).toHaveLength(1)
		expect(effective[0].isSummary).toBe(true)
		// All originals tagged.
		for (const msg of result.messages.filter((m) => !m.isSummary)) {
			expect(msg.condenseParent).toBe(last.condenseId)
		}
	})

	it("preserves a tool_result in the tail by healing a split pair at the boundary", async () => {
		const messages = plainConversation(20)
		messages[13] = {
			role: "assistant",
			content: [{ type: "tool_use", id: "kept-pair", name: "read_file", input: {} }],
			ts: 14,
		}
		messages[14] = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "kept-pair", content: "important file" }],
			ts: 15,
		}

		const result = await summarizeConversation({
			messages,
			apiHandler: mockApiHandler,
			systemPrompt: "sys",
			taskId,
		})

		const effective = getEffectiveApiHistory(result.messages)
		// The tool_use and its tool_result both survive (boundary pulled back to 13).
		const hasUse = effective.some(
			(m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use"),
		)
		const hasResult = effective.some(
			(m) =>
				m.role === "user" &&
				Array.isArray(m.content) &&
				m.content.some((b) => b.type === "tool_result" && b.tool_use_id === "kept-pair"),
		)
		expect(hasUse).toBe(true)
		expect(hasResult).toBe(true)
	})
})
