import { openAiCodexModels } from "../providers/openai-codex.js"

/**
 * The Codex provider never sends `max_output_tokens` — the backend rejects it — so each
 * model's `maxTokens` only ever acts as the response reservation subtracted from the
 * context window when deciding whether to condense/truncate
 * (`contextWindow * 0.9 - reservedTokens`, see `src/core/context-management`).
 *
 * GPT-5 model IDs skip the usual 20%-of-context clamp in `getModelMaxOutputTokens`, so the
 * catalog itself has to stay within that budget. A 128k reserve on the 200k subscription
 * window left ~52k of usable context and made auto-condense fire almost immediately.
 */
describe("openAiCodexModels", () => {
	it("reserves at most 20% of the context window for the response", () => {
		for (const [modelId, info] of Object.entries(openAiCodexModels)) {
			expect(info.maxTokens, `${modelId} reserves too much of its context window`).toBeLessThanOrEqual(
				Math.ceil(info.contextWindow * 0.2),
			)
		}
	})

	it("leaves the majority of the context window usable before condensing", () => {
		for (const [modelId, info] of Object.entries(openAiCodexModels)) {
			// Mirrors the allowed-tokens formula used by the context manager.
			const allowedTokens = info.contextWindow * 0.9 - info.maxTokens
			expect(allowedTokens / info.contextWindow, `${modelId} condenses too early`).toBeGreaterThanOrEqual(0.7)
		}
	})
})
