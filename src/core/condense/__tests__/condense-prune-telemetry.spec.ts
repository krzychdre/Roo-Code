// cd src && npx vitest run core/condense/__tests__/condense-prune-telemetry.spec.ts

import { TelemetryService } from "@roo-code/telemetry"

import type { ApiHandler } from "../../../api"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { summarizeConversation } from "../index"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(true),
		instance: {
			captureContextCondensed: vi.fn(),
			captureLlmCompletion: vi.fn(),
		},
	},
}))

const taskId = "condense-prune-telemetry-task"

/**
 * The condense event is the one place the metrics page can learn how often the
 * deterministic prune pass made the LLM summary unnecessary. These tests pin the
 * two halves of that story on the summarizer's side: a round where pruning ran
 * but was not enough reports `summarySkipped: false` alongside what it saved,
 * and a round that never pruned still emits exactly the properties it always
 * did (a widened event on every task would rewrite historical dashboards).
 */

function handler(): ApiHandler {
	return {
		createMessage: () =>
			(async function* () {
				yield { type: "text", text: "A summary of the conversation." }
				yield { type: "usage", inputTokens: 10, outputTokens: 1, totalCost: 0 }
			})(),
		getModel: () => ({ id: "the-condensing-model", info: { contextWindow: 200_000, supportsPromptCache: false } }),
		countTokens: async () => 0,
	} as unknown as ApiHandler
}

function conversation(): ApiMessage[] {
	return [
		{ role: "user", content: "Start the task", ts: 1 },
		{ role: "assistant", content: "Working on it", ts: 2 },
		{ role: "user", content: "Keep going", ts: 3 },
		{ role: "assistant", content: "Still working", ts: 4 },
		{ role: "user", content: "And now condense", ts: 5 },
	]
}

describe("condense telemetry: prune fields", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("carries prunedCount, bytesSaved and summarySkipped when a prune preceded the summary", async () => {
		await summarizeConversation({
			messages: conversation(),
			apiHandler: handler(),
			systemPrompt: "system",
			taskId,
			isAutomaticTrigger: true,
			pruneStats: { prunedCount: 3, bytesSaved: 123_456 },
		})

		expect(TelemetryService.instance.captureContextCondensed).toHaveBeenCalledWith(taskId, true, false, {
			prunedCount: 3,
			bytesSaved: 123_456,
			// The summary DID run: pruning alone did not relieve the pressure.
			summarySkipped: false,
		})
	})

	it("keeps the historical event shape when no prune ran", async () => {
		await summarizeConversation({
			messages: conversation(),
			apiHandler: handler(),
			systemPrompt: "system",
			taskId,
			isAutomaticTrigger: false,
		})

		expect(TelemetryService.instance.captureContextCondensed).toHaveBeenCalledWith(taskId, false, false)

		// Exactly three positional arguments: not even an `undefined` fourth one.
		// A regression that always passes a zeroed `pruneStats` (or an empty
		// object) would widen every historical dashboard row, so the arity is
		// part of the contract and is asserted directly rather than left to the
		// matcher above.
		const calls = vi.mocked(TelemetryService.instance.captureContextCondensed).mock.calls
		expect(calls).toHaveLength(1)
		expect(calls[0]).toHaveLength(3)
	})
})
