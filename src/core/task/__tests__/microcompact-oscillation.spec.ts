// cd src && npx vitest run core/task/__tests__/microcompact-oscillation.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { BaseProvider } from "../../../api/providers/base-provider"
import { ApiMessage } from "../../task-persistence/apiMessages"
import { manageContext, estimateTokenCount } from "../../context-management"

import { nextMicrocompactStrippedTokens } from "../TaskContextManager"

describe("nextMicrocompactStrippedTokens", () => {
	it("returns what was stripped on a microcompaction-only pass", () => {
		expect(nextMicrocompactStrippedTokens({ microcompactTokensCleared: 130_000 }, 5)).toBe(130_000)
	})

	it("returns 0 when nothing was cleared", () => {
		// Reported size already equals the pristine size — nothing to add back.
		expect(nextMicrocompactStrippedTokens({ microcompactTokensCleared: 130_000 }, 0)).toBe(0)
		expect(nextMicrocompactStrippedTokens({}, 0)).toBe(0)
	})

	it("returns 0 when the pass also condensed", () => {
		// A summary rewrites the history; the reported size reflects the new shape.
		expect(nextMicrocompactStrippedTokens({ summary: "s", microcompactTokensCleared: 130_000 }, 5)).toBe(0)
	})

	it("returns 0 when the pass also truncated", () => {
		expect(nextMicrocompactStrippedTokens({ truncationId: "t", microcompactTokensCleared: 130_000 }, 5)).toBe(0)
	})

	it("returns 0 when the strip estimate is missing", () => {
		expect(nextMicrocompactStrippedTokens({}, 5)).toBe(0)
	})
})

// --- Feedback-loop harness ----------------------------------------------------------
//
// Reproduces the measured production symptom: `tokensIn` alternating between a
// compacted and a full-history size on consecutive turns of the same task (observed
// 92k <-> 222k). The cause is a broken feedback loop, not a bug inside microcompaction:
//
//   1. The threshold gate reads the PREVIOUS request's provider-reported size.
//   2. Microcompaction is non-destructive — it strips the outgoing copy only, so the
//      provider reports the STRIPPED size while stored history stays pristine.
//   3. Next turn the gate therefore compares a pristine history against a stripped
//      measurement, concludes it is under the threshold, and sends everything.
//   4. That full request reports a big size -> strip again -> repeat.
//
// The sent prefix changes every single turn, which makes prompt caching structurally
// impossible on top of the wasted input tokens.

const CONTEXT_WINDOW = 30_000
const MAX_TOKENS = 1_000
const CONDENSE_PERCENT = 50

/**
 * The size the gate exists to keep the outgoing payload under. Microcompaction runs
 * precisely so a turn does not have to be condensed; a request that goes over the wire
 * ABOVE this line means the gate failed at its one job.
 */
const CONDENSE_CEILING_TOKENS = (CONTEXT_WINDOW * CONDENSE_PERCENT) / 100

class MockApiHandler extends BaseProvider {
	createMessage(): any {
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "text", text: "Mock summary content" }
				yield { type: "usage", inputTokens: 100, outputTokens: 50, totalCost: 0.01 }
			},
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "test-model",
			info: {
				contextWindow: CONTEXT_WINDOW,
				maxTokens: MAX_TOKENS,
				supportsPromptCache: true,
				supportsImages: false,
				inputPrice: 0,
				outputPrice: 0,
				description: "Test model",
			},
		}
	}
}

const apiHandler = new MockApiHandler()

/** Body text for a tool result, sized in rough 4-chars-per-token units. */
function resultBody(index: number, approxTokens: number): string {
	return `result ${index}: ` + `const value = compute(input, options); // line of source\n`.repeat(approxTokens / 12)
}

let pairCounter = 0

function toolPair(resultContent: string): [ApiMessage, ApiMessage] {
	pairCounter += 1
	const useId = `tool-${pairCounter}`
	return [
		{
			role: "assistant",
			content: [{ type: "tool_use", id: useId, name: "read_file", input: {} }],
			ts: pairCounter,
		},
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: useId, content: resultContent }],
			ts: pairCounter,
		},
	]
}

/**
 * Size of the whole (pristine) history as the provider would measure it, using the
 * same tokenizer microcompaction uses for its freed-token estimate so the harness
 * arithmetic stays self-consistent.
 */
async function pristineTokens(messages: ApiMessage[]): Promise<number> {
	const blocks: Anthropic.Messages.ContentBlockParam[] = []
	for (const msg of messages) {
		if (typeof msg.content === "string") {
			blocks.push({ type: "text", text: msg.content })
			continue
		}
		for (const block of msg.content) {
			if (block.type === "tool_result" && typeof block.content === "string") {
				blocks.push({ type: "text", text: block.content })
			} else if (block.type === "text") {
				blocks.push({ type: "text", text: block.text })
			}
		}
	}
	return estimateTokenCount(blocks, apiHandler)
}

type TurnRecord = { sent: number; stripped: boolean }

/**
 * Runs `turns` request cycles against the real `manageContext`, modelling the caller:
 * the gate is fed the previous request's provider-reported size, which is the size of
 * what was actually SENT (i.e. already deflated when the previous turn stripped).
 *
 * @param undeflate when true, apply the fix: add back what the previous turn stripped
 *                  before running the threshold check.
 */
async function runTask(turns: number, undeflate: boolean): Promise<TurnRecord[]> {
	pairCounter = 0
	const messages: ApiMessage[] = [{ role: "user", content: "Initial task", ts: 0 }]
	// Seed enough history that the first turn is already over the condense threshold.
	for (let i = 0; i < 8; i++) {
		messages.push(...toolPair(resultBody(i, 900)))
	}

	const log: TurnRecord[] = []
	let reported = await pristineTokens(messages)
	let strippedLastTurn = 0

	for (let turn = 0; turn < turns; turn++) {
		messages.push(...toolPair(resultBody(100 + turn, 300)))

		const contextTokens = reported + (undeflate ? strippedLastTurn : 0)

		const result = await manageContext({
			messages,
			totalTokens: contextTokens,
			contextWindow: CONTEXT_WINDOW,
			maxTokens: MAX_TOKENS,
			apiHandler,
			autoCondenseContext: true,
			autoCondenseContextPercent: CONDENSE_PERCENT,
			systemPrompt: "sys",
			taskId: "oscillation-task",
			profileThresholds: {},
			currentProfileId: "default",
		})

		// Guard the fixture: this scenario must stay on the cheap microcompaction path,
		// otherwise it would be measuring condensation instead of the feedback loop.
		expect(result.summary).toBe("")
		expect(result.truncationId).toBeUndefined()

		const clearedIds = result.microcompactClearedToolUseIds ?? []
		const sent = (await pristineTokens(messages)) - (result.microcompactTokensCleared ?? 0)
		log.push({ sent, stripped: clearedIds.length > 0 })

		strippedLastTurn = nextMicrocompactStrippedTokens(result, clearedIds.length)
		reported = sent
	}

	return log
}

/** Index of the first turn where the gate tripped; fails the caller's guard if never. */
function firstStrippedIndex(log: TurnRecord[]): number {
	const index = log.findIndex((t) => t.stripped)
	expect(index).toBeGreaterThanOrEqual(0)
	return index
}

describe("microcompaction feedback loop", () => {
	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
	})

	it("oscillates when the reported size is used as-is (documents the bug)", async () => {
		const log = await runTask(10, /* undeflate */ false)

		// The task grows quietly for a while, then crosses the threshold. From that
		// point on the strip decision keeps flipping back OFF instead of latching:
		// each strip deflates the reported size below the gate, so the next turn
		// sends the whole pristine history again.
		const first = firstStrippedIndex(log)
		const tail = log.slice(first)
		expect(tail.length).toBeGreaterThan(2)
		expect(tail[0].stripped).toBe(true)

		const reInflated = tail.filter((t) => !t.stripped)
		expect(reInflated.length).toBeGreaterThan(0)

		// ...and every one of those flips costs more than the turn that tripped the gate:
		// the history kept growing underneath, so re-sending it whole now exceeds the last
		// full turn AND breaches the ceiling the strip had just brought it under.
		const lastFullBeforeStrip = log[first - 1].sent
		expect(reInflated.every((t) => t.sent > lastFullBeforeStrip)).toBe(true)
		expect(reInflated.every((t) => t.sent > CONDENSE_CEILING_TOKENS)).toBe(true)
	})

	it("stays compacted once over the threshold when the reported size is un-deflated", async () => {
		const log = await runTask(10, /* undeflate */ true)

		// Same quiet growth, same crossing point — the fix does not make the gate
		// trip earlier, it only stops it from flipping back.
		const first = firstStrippedIndex(log)
		expect(first).toBeGreaterThan(0)
		expect(log.slice(0, first).every((t) => !t.stripped)).toBe(true)

		// Once stripping starts it never stops: the gate now sees the true pristine
		// size, which is monotone in the history, so the decision cannot flip back.
		expect(log.slice(first).every((t) => t.stripped)).toBe(true)

		// No sawtooth: once the strip latches, every request stays under the ceiling the
		// gate is there to enforce, instead of bouncing back over it on alternate turns.
		expect(log.slice(first).every((t) => t.sent <= CONDENSE_CEILING_TOKENS)).toBe(true)
	})

	it("sends fewer input tokens overall than the oscillating loop", async () => {
		const before = await runTask(10, false)
		const after = await runTask(10, true)

		const sum = (log: TurnRecord[]) => log.reduce((acc, t) => acc + t.sent, 0)
		expect(sum(after)).toBeLessThan(sum(before))
	})
})
