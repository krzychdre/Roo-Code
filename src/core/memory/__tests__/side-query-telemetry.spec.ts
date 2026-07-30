// npx vitest run core/memory/__tests__/side-query-telemetry.spec.ts

import { TelemetryService } from "@roo-code/telemetry"

import type { ApiHandler } from "../../../api"
import { makeSideQuery } from "../memoryTaskIntegration"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(true),
		instance: { captureLlmCompletion: vi.fn() },
	},
}))

/**
 * The recall side-query runs on every user turn, on the task's own model, and
 * reported nothing at all — it went through `completePrompt`, which returns a
 * bare string and threw the usage away.
 */
describe("memory side-query telemetry", () => {
	beforeEach(() => vi.clearAllMocks())

	const handler = (impl: Partial<ApiHandler> & Record<string, unknown>) =>
		({
			getModel: () => ({ id: "the-task-model", info: {} }),
			...impl,
		}) as unknown as ApiHandler

	it("reports what ranking memories cost, under its own kind", async () => {
		const query = makeSideQuery(
			handler({
				completePrompt: vi.fn(),
				completePromptWithUsage: vi
					.fn()
					.mockResolvedValue({ text: "1,2", usage: { inputTokens: 4_000, outputTokens: 12 } }),
			}),
			"memory-task",
		)!

		const answer = await query("system", "user", new AbortController().signal)

		expect(answer).toBe("1,2")
		expect(TelemetryService.instance.captureLlmCompletion).toHaveBeenCalledWith(
			"memory-task",
			expect.objectContaining({
				inputTokens: 4_000,
				outputTokens: 12,
				completionKind: "memory",
				usageReported: true,
				modelId: "the-task-model",
			}),
		)
	})

	it("records the call even when the provider cannot report figures", async () => {
		const query = makeSideQuery(handler({ completePrompt: vi.fn().mockResolvedValue("1") }), "memory-task")!

		await query("system", "user", new AbortController().signal)

		const [, properties] = vi.mocked(TelemetryService.instance.captureLlmCompletion).mock.calls[0]
		expect(properties.usageReported).toBe(false)
	})

	it("reports nothing when the turn was aborted — there is no answer to account for", async () => {
		const controller = new AbortController()
		controller.abort()
		const query = makeSideQuery(handler({ completePrompt: vi.fn().mockResolvedValue("1") }), "memory-task")!

		await expect(query("system", "user", controller.signal)).rejects.toThrow("aborted")
		expect(TelemetryService.instance.captureLlmCompletion).not.toHaveBeenCalled()
	})

	it("is undefined for a handler that cannot do one-shot completions at all", () => {
		expect(makeSideQuery(handler({}), "memory-task")).toBeUndefined()
	})
})
