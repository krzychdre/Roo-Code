// npx vitest run utils/__tests__/run-completion.spec.ts

import type { SingleCompletionHandler } from "../../api"
import { runCompletion } from "../single-completion-handler"

/**
 * `runCompletion` is the one place that decides how a one-shot call is made, so
 * that "this provider cannot report tokens" is handled once. The two rules it
 * has to keep: prefer the usage-bearing method, and never invent a figure for a
 * provider that did not give one.
 */
describe("runCompletion", () => {
	it("prefers the usage-bearing method when the provider has one", async () => {
		const handler: SingleCompletionHandler = {
			completePrompt: vi.fn().mockResolvedValue("from the plain method"),
			completePromptWithUsage: vi
				.fn()
				.mockResolvedValue({ text: "answer", usage: { inputTokens: 90, outputTokens: 7 } }),
		}

		const result = await runCompletion(handler, "the prompt")

		expect(result).toEqual({ text: "answer", usage: { inputTokens: 90, outputTokens: 7 } })
		expect(handler.completePromptWithUsage).toHaveBeenCalledWith("the prompt")
		expect(handler.completePrompt).not.toHaveBeenCalled()
	})

	it("falls back to the plain method, reporting no usage rather than zero usage", async () => {
		const handler: SingleCompletionHandler = {
			completePrompt: vi.fn().mockResolvedValue("answer"),
		}

		const result = await runCompletion(handler, "the prompt")

		expect(result).toEqual({ text: "answer" })
		expect(result.usage).toBeUndefined()
	})

	it("propagates the provider's error instead of swallowing it into an empty result", async () => {
		const handler: SingleCompletionHandler = {
			completePrompt: vi.fn(),
			completePromptWithUsage: vi.fn().mockRejectedValue(new Error("provider is down")),
		}

		await expect(runCompletion(handler, "the prompt")).rejects.toThrow("provider is down")
	})
})
