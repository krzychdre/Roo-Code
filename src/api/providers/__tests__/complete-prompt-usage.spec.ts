// npx vitest run api/providers/__tests__/complete-prompt-usage.spec.ts

import type { ModelInfo } from "@roo-code/types"

import { BaseOpenAiCompatibleProvider } from "../base-openai-compatible-provider"

const mockCreate = vi.fn()

vi.mock("openai", () => ({
	default: vi.fn(() => ({
		chat: { completions: { create: mockCreate } },
	})),
}))

class TestProvider extends BaseOpenAiCompatibleProvider<"test-model"> {
	constructor() {
		const models: Record<"test-model", ModelInfo> = {
			"test-model": {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsImages: false,
				supportsPromptCache: false,
			},
		}
		super({
			providerName: "TestProvider",
			baseURL: "https://test.example.com/v1",
			defaultProviderModelId: "test-model",
			providerModels: models,
			apiKey: "test-key",
		})
	}
}

/**
 * Every provider's `completePrompt` body moved into `completePromptWithUsage`,
 * with `completePrompt` delegating. The contract that mechanical change has to
 * keep is pinned here on the base the majority of providers inherit: the same
 * single request, the same string back, and the usage no longer discarded.
 */
describe("completePrompt delegation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns the usage the provider reported", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "the answer" } }],
			usage: { prompt_tokens: 4321, completion_tokens: 21, prompt_tokens_details: { cached_tokens: 4096 } },
		})

		const result = await new TestProvider().completePromptWithUsage("a prompt")

		expect(result).toEqual({
			text: "the answer",
			usage: { inputTokens: 4321, outputTokens: 21, cacheReadTokens: 4096 },
		})
	})

	it("still returns just the string through the original method", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "the answer" } }],
			usage: { prompt_tokens: 10, completion_tokens: 2 },
		})

		await expect(new TestProvider().completePrompt("a prompt")).resolves.toBe("the answer")
	})

	it("makes exactly one request either way — delegation must not double-call", async () => {
		mockCreate.mockResolvedValue({ choices: [{ message: { content: "x" } }] })

		await new TestProvider().completePrompt("a prompt")

		expect(mockCreate).toHaveBeenCalledTimes(1)
	})

	it("reports no usage when the response carried none", async () => {
		mockCreate.mockResolvedValue({ choices: [{ message: { content: "x" } }] })

		const result = await new TestProvider().completePromptWithUsage("a prompt")

		expect(result.usage).toBeUndefined()
	})
})
