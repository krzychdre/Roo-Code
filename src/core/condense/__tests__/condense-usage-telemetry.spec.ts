// npx vitest run core/condense/__tests__/condense-usage-telemetry.spec.ts

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

const taskId = "condense-usage-task"

/**
 * Condensing is often the single largest request a long task makes — it sends
 * the whole history — and it was recorded only as "Context Condensed", an event
 * with no figures at all. These tests pin that it now reports what it spent,
 * under its own kind and against the model that actually ran it.
 */

function handler(options: { summary?: string; usage?: Record<string, unknown> | null; modelId?: string }): ApiHandler {
	const { summary = "A summary of the conversation.", usage, modelId = "the-condensing-model" } = options
	return {
		createMessage: () =>
			(async function* () {
				yield { type: "text", text: summary }
				if (usage !== null) {
					yield {
						type: "usage",
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						...usage,
					}
				}
			})(),
		getModel: () => ({ id: modelId, info: { contextWindow: 200_000, supportsPromptCache: false } }),
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

describe("condense usage telemetry", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("reports every figure the stream reported, not only cost and output", async () => {
		await summarizeConversation({
			messages: conversation(),
			apiHandler: handler({
				usage: {
					inputTokens: 48_000,
					outputTokens: 900,
					cacheReadTokens: 32_000,
					cacheWriteTokens: 128,
					totalCost: 0.42,
				},
			}),
			systemPrompt: "system",
			taskId,
			isAutomaticTrigger: true,
		})

		expect(TelemetryService.instance.captureLlmCompletion).toHaveBeenCalledWith(
			taskId,
			expect.objectContaining({
				inputTokens: 48_000,
				outputTokens: 900,
				cacheReadTokens: 32_000,
				cacheWriteTokens: 128,
				cost: 0.42,
				completionKind: "condense",
				usageReported: true,
			}),
		)
	})

	it("names the model that condensed, which is not necessarily the task's", async () => {
		await summarizeConversation({
			messages: conversation(),
			apiHandler: handler({ usage: { inputTokens: 10, outputTokens: 1 }, modelId: "a-cheap-background-model" }),
			systemPrompt: "system",
			taskId,
			isAutomaticTrigger: true,
		})

		const [, properties] = vi.mocked(TelemetryService.instance.captureLlmCompletion).mock.calls[0]
		expect(properties.modelId).toBe("a-cheap-background-model")
	})

	it("says so when the provider reported no usage, instead of claiming zero", async () => {
		await summarizeConversation({
			messages: conversation(),
			apiHandler: handler({ usage: null }),
			systemPrompt: "system",
			taskId,
			isAutomaticTrigger: true,
		})

		const [, properties] = vi.mocked(TelemetryService.instance.captureLlmCompletion).mock.calls[0]
		expect(properties.usageReported).toBe(false)
		expect(properties.inputTokens).toBe(0)
	})

	it("still records the condense event itself, as before", async () => {
		await summarizeConversation({
			messages: conversation(),
			apiHandler: handler({ usage: { inputTokens: 10, outputTokens: 1 } }),
			systemPrompt: "system",
			taskId,
			isAutomaticTrigger: false,
		})

		expect(TelemetryService.instance.captureContextCondensed).toHaveBeenCalledWith(taskId, false, false)
	})
})
