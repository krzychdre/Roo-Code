// npx vitest run services/code-index/__tests__/embedding-usage.spec.ts

import { TelemetryService } from "@roo-code/telemetry"

import type { EmbeddingResponse, IEmbedder } from "../interfaces/embedder"
import { reportEmbeddingUsage } from "../embedding-usage"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(true),
		instance: { captureEmbeddingUsage: vi.fn() },
	},
}))

/**
 * Embeddings were the largest source of tokens the extension sent that appeared
 * nowhere: a full index is hundreds of thousands of input tokens on the same
 * endpoint as the conversation.
 */
describe("reportEmbeddingUsage", () => {
	const embedder = { embedderInfo: { name: "openai-compatible" } } as unknown as IEmbedder

	beforeEach(() => vi.clearAllMocks())

	it("reports the tokens an indexing batch spent, tagged with where it came from", () => {
		const response: EmbeddingResponse = {
			embeddings: [[0.1]],
			usage: { promptTokens: 128_000, totalTokens: 128_000 },
		}

		reportEmbeddingUsage(embedder, response, "index-scan")

		expect(TelemetryService.instance.captureEmbeddingUsage).toHaveBeenCalledWith({
			promptTokens: 128_000,
			totalTokens: 128_000,
			apiProvider: "openai-compatible",
			source: "index-scan",
		})
	})

	it("keeps a search apart from an index, since the volumes differ by orders of magnitude", () => {
		reportEmbeddingUsage(embedder, { embeddings: [[0.1]], usage: { promptTokens: 12, totalTokens: 12 } }, "search")

		const [properties] = vi.mocked(TelemetryService.instance.captureEmbeddingUsage).mock.calls[0]
		expect(properties.source).toBe("search")
	})

	it("stays silent when the embedder reported nothing, rather than recording a free call", () => {
		reportEmbeddingUsage(embedder, { embeddings: [[0.1]] }, "index-scan")

		expect(TelemetryService.instance.captureEmbeddingUsage).not.toHaveBeenCalled()
	})

	it("stays silent on an all-zero report", () => {
		reportEmbeddingUsage(embedder, { embeddings: [[0.1]], usage: { promptTokens: 0, totalTokens: 0 } }, "search")

		expect(TelemetryService.instance.captureEmbeddingUsage).not.toHaveBeenCalled()
	})
})
