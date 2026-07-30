// npx vitest run api/providers/utils/__tests__/completion-usage.spec.ts

import {
	aiSdkCompletionUsage,
	anthropicCompletionUsage,
	geminiCompletionUsage,
	ollamaCompletionUsage,
	openAiCompletionUsage,
	responsesApiCompletionUsage,
} from "../completion-usage"

/**
 * The property under test throughout: a figure the provider did not report must
 * come back as absent, never as zero. A zero would be added into a usage total
 * as if the call had been free, which is exactly the kind of quietly-wrong
 * number a cost dashboard must not produce.
 */
describe("completion usage mappers", () => {
	describe("openAiCompletionUsage", () => {
		it("reads prompt/completion tokens", () => {
			expect(openAiCompletionUsage({ prompt_tokens: 1200, completion_tokens: 34 })).toEqual({
				inputTokens: 1200,
				outputTokens: 34,
			})
		})

		it("reports the cached prefix as a subset of the input", () => {
			const usage = openAiCompletionUsage({
				prompt_tokens: 1200,
				completion_tokens: 34,
				prompt_tokens_details: { cached_tokens: 1024 },
			})

			expect(usage).toEqual({ inputTokens: 1200, outputTokens: 34, cacheReadTokens: 1024 })
		})

		it.each([[null], [undefined], [{}]])("returns undefined for %p rather than zeros", (input) => {
			expect(openAiCompletionUsage(input as any)).toBeUndefined()
		})

		it("does not turn a non-numeric field into a number", () => {
			expect(openAiCompletionUsage({ prompt_tokens: "1200" as any, completion_tokens: 34 })).toEqual({
				inputTokens: 0,
				outputTokens: 34,
			})
		})
	})

	describe("anthropicCompletionUsage", () => {
		it("keeps the cache figures separate from the input, as Anthropic reports them", () => {
			expect(
				anthropicCompletionUsage({
					input_tokens: 100,
					output_tokens: 20,
					cache_creation_input_tokens: 500,
					cache_read_input_tokens: 4000,
				}),
			).toEqual({ inputTokens: 100, outputTokens: 20, cacheWriteTokens: 500, cacheReadTokens: 4000 })
		})

		it("returns undefined when nothing was reported", () => {
			expect(anthropicCompletionUsage(undefined)).toBeUndefined()
		})
	})

	describe("responsesApiCompletionUsage", () => {
		it("reads input_tokens/output_tokens, not prompt_tokens", () => {
			expect(
				responsesApiCompletionUsage({
					input_tokens: 900,
					output_tokens: 12,
					input_tokens_details: { cached_tokens: 512 },
				}),
			).toEqual({ inputTokens: 900, outputTokens: 12, cacheReadTokens: 512 })
		})

		it("ignores a Chat-Completions-shaped block instead of guessing", () => {
			expect(responsesApiCompletionUsage({ prompt_tokens: 900 } as any)).toBeUndefined()
		})
	})

	describe("geminiCompletionUsage", () => {
		it("maps the usageMetadata field names", () => {
			expect(
				geminiCompletionUsage({
					promptTokenCount: 700,
					candidatesTokenCount: 9,
					cachedContentTokenCount: 256,
				}),
			).toEqual({ inputTokens: 700, outputTokens: 9, cacheReadTokens: 256 })
		})
	})

	describe("ollamaCompletionUsage", () => {
		it("maps the native eval counters", () => {
			expect(ollamaCompletionUsage({ prompt_eval_count: 55, eval_count: 5 })).toEqual({
				inputTokens: 55,
				outputTokens: 5,
			})
		})
	})

	describe("aiSdkCompletionUsage", () => {
		it("accepts either naming the SDK has used", () => {
			expect(aiSdkCompletionUsage({ promptTokens: 10, completionTokens: 2 })).toEqual({
				inputTokens: 10,
				outputTokens: 2,
			})
			expect(aiSdkCompletionUsage({ inputTokens: 10, outputTokens: 2 })).toEqual({
				inputTokens: 10,
				outputTokens: 2,
			})
		})
	})
})
