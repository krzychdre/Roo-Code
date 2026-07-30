import { TelemetryService } from "@roo-code/telemetry"

import type { EmbeddingResponse, IEmbedder } from "./interfaces/embedder"

/**
 * Where an embedding call came from. Indexing a repository and answering one
 * search are the same API call with wildly different volumes, so the console
 * can tell them apart instead of showing a single unexplained number.
 */
export type EmbeddingSource = "index-scan" | "index-watch" | "search"

/**
 * Report what an embedding call cost.
 *
 * Embeddings are the largest source of tokens the extension sends that used to
 * appear nowhere: a full index of a repository is hundreds of thousands of
 * input tokens, on the same endpoint as the conversation, and the usage page
 * knew nothing about it. They are reported as their own event rather than as a
 * completion — there is no output and no price — so the conversation totals
 * stay readable next to them.
 *
 * Silent when the embedder reported no usage: an unknown figure must not become
 * a zero that reads as "this was free".
 */
export function reportEmbeddingUsage(
	embedder: IEmbedder,
	response: EmbeddingResponse,
	source: EmbeddingSource,
	model?: string,
): void {
	const usage = response.usage
	if (!usage || !TelemetryService.hasInstance()) {
		return
	}
	if (!usage.promptTokens && !usage.totalTokens) {
		return
	}
	TelemetryService.instance.captureEmbeddingUsage({
		promptTokens: usage.promptTokens ?? 0,
		totalTokens: usage.totalTokens ?? 0,
		apiProvider: embedder.embedderInfo?.name,
		source,
		...(model && { modelId: model }),
	})
}
