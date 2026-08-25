// cd src && npx vitest run core/context-management/__tests__/prune-before-condense.spec.ts

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { BaseProvider } from "../../../api/providers/base-provider"
import { ArtifactStore } from "../../artifacts/ArtifactStore"
import { ApiMessage } from "../../task-persistence/apiMessages"
import * as condenseModule from "../../condense"
import { computeCondenseKeepBoundary } from "../../condense"
import { PRUNE_NOTICE_PREFIX } from "../../condense/toolResultPruner"

import { manageContext } from "../index"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(true),
		instance: {
			captureContextCondensed: vi.fn(),
			captureContextMicrocompacted: vi.fn(),
			captureContextPruned: vi.fn(),
			captureSlidingWindowTruncation: vi.fn(),
			captureLlmCompletion: vi.fn(),
		},
	},
}))

/**
 * Integration tests for WS-C: on context pressure the deterministic prune pass
 * runs first, and the LLM summary only happens if pruning was not enough.
 *
 * The token estimator is deliberately simple (4 characters per token) so the
 * arithmetic in the assertions is readable; what matters is that manageContext
 * remeasures with the SAME estimator the pressure decision uses.
 */

/** Deterministic, cheap stand-in for the provider's tokenizer. */
class CountingApiHandler extends BaseProvider {
	createMessage(): any {
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "text", text: "Mock summary content" }
			},
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "test-model",
			info: {
				contextWindow: 100_000,
				maxTokens: 8_000,
				supportsPromptCache: false,
				supportsImages: false,
				inputPrice: 0,
				outputPrice: 0,
				description: "Test model",
			},
		}
	}

	override async countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		return content.reduce((sum, block) => sum + (block.type === "text" ? Math.ceil(block.text.length / 4) : 0), 0)
	}
}

const apiHandler = new CountingApiHandler()
const taskId = "prune-before-condense-task"

/** ~10 KB of short lines: over the 4 KB budget, and cheap to preview. */
function bigResult(tag: string): string {
	return Array.from({ length: 200 }, (_, index) => `${tag} line ${index}`.padEnd(50, ".")).join("\n")
}

/**
 * `list_code_definition_names` is deliberately NOT in microcompaction's
 * `COMPACTABLE_TOOL_NAMES` allowlist and NOT on the spill bypass list, so these
 * histories reach the pruner with microcompaction having found nothing to do.
 * That is exactly the case WS-C exists for.
 */
function toolPair(index: number, resultContent: string): [ApiMessage, ApiMessage] {
	const useId = `use-${index}`
	return [
		{
			role: "assistant",
			content: [{ type: "tool_use", id: useId, name: "list_code_definition_names", input: {} }],
			ts: index,
		},
		{ role: "user", content: [{ type: "tool_result", tool_use_id: useId, content: resultContent }], ts: index },
	]
}

/** 15 messages: two oversized old results, the rest tiny. */
function buildHistory(): ApiMessage[] {
	return [
		{ role: "user", content: "the task", ts: 0 },
		...toolPair(1, bigResult("alpha")),
		...toolPair(2, bigResult("beta")),
		...toolPair(3, "small"),
		...toolPair(4, "small"),
		...toolPair(5, "small"),
		...toolPair(6, "small"),
		...toolPair(7, "small"),
	]
}

function resultText(messages: ApiMessage[], toolUseId: string): string | undefined {
	for (const msg of messages) {
		if (msg.role !== "user" || !Array.isArray(msg.content)) continue
		for (const block of msg.content) {
			if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
				const content = (block as Anthropic.Messages.ToolResultBlockParam).content
				return typeof content === "string" ? content : undefined
			}
		}
	}
	return undefined
}

describe("prune before condense", () => {
	let globalStoragePath: string
	let store: ArtifactStore

	beforeEach(async () => {
		vi.clearAllMocks()
		globalStoragePath = fs.mkdtempSync(path.join(os.tmpdir(), "prune-integration-"))
		store = await ArtifactStore.forTask(globalStoragePath, taskId)
	})

	afterEach(() => {
		fs.rmSync(globalStoragePath, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("protects the same recent tail a condense would keep", () => {
		const messages = buildHistory()
		// Pins the shared boundary: the two oversized results (indices 2 and 4)
		// are eligible, the last three pairs are the protected working set.
		expect(computeCondenseKeepBoundary(messages)).toBe(9)
	})

	it("resolves the pressure without calling the summarizer, and the estimate drops", async () => {
		const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation")
		const messages = buildHistory()

		const result = await manageContext({
			messages,
			totalTokens: 71_000, // 71% of the window, over the 70% threshold
			contextWindow: 100_000,
			maxTokens: 8_000,
			apiHandler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 70,
			systemPrompt: "System prompt",
			taskId,
			profileThresholds: {},
			currentProfileId: "default",
			artifactStore: store,
		})

		expect(summarizeSpy).not.toHaveBeenCalled()
		expect(result.summarySkipped).toBe(true)
		expect(result.prunedCount).toBe(2)
		expect(result.prunedBytesSaved).toBeGreaterThan(0)
		expect(result.newContextTokens).toBeLessThan(result.prevContextTokens)
		// Back under the 70% threshold, which is why no summary was requested.
		expect((100 * result.newContextTokens!) / 100_000).toBeLessThan(70)

		// The rewritten history is what the caller must persist.
		expect(result.messages).not.toBe(messages)
		expect(result.messages).toHaveLength(messages.length)
		expect(resultText(result.messages, "use-1")!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)
		expect(resultText(result.messages, "use-2")!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)
		// The recent tail is untouched.
		expect(resultText(result.messages, "use-7")).toBe("small")

		// Both originals really are on disk under the ids the previews quote.
		const artifactDir = path.join(store.getTaskDir(), "artifacts")
		expect(fs.readdirSync(artifactDir)).toHaveLength(2)
		for (const id of [resultText(result.messages, "use-1")!, resultText(result.messages, "use-2")!]) {
			const quoted = id.match(/artifact "(prune-\d+\.txt)"/)![1]
			expect(fs.existsSync(path.join(artifactDir, quoted))).toBe(true)
		}
	})

	it("reports a prune-only round on its own event, never as a condense", async () => {
		vi.spyOn(condenseModule, "summarizeConversation")

		const result = await manageContext({
			messages: buildHistory(),
			totalTokens: 71_000,
			contextWindow: 100_000,
			maxTokens: 8_000,
			apiHandler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 70,
			systemPrompt: "System prompt",
			taskId,
			profileThresholds: {},
			currentProfileId: "default",
			artifactStore: store,
		})

		expect(TelemetryService.instance.captureContextPruned).toHaveBeenCalledWith(taskId, {
			prunedCount: result.prunedCount,
			bytesSaved: result.prunedBytesSaved,
		})
		// No summary was written, so the condense counters must not move.
		expect(TelemetryService.instance.captureContextCondensed).not.toHaveBeenCalled()
	})

	it("spares the newest results right after a condense, when the boundary is a sentinel", async () => {
		// A short post-condense history. `computeCondenseKeepBoundary` answers
		// `messages.length` here, which means "no raw tail, summarize everything"
		// for a condense but must NOT read as "protect nothing" for the pruner:
		// the freshest result is the one the model is working from this turn.
		const messages: ApiMessage[] = [
			{ role: "user", content: "## Conversation Summary\nearlier work", ts: 0, isSummary: true },
			...toolPair(1, bigResult("oldest")),
			...toolPair(2, bigResult("middle")),
			...toolPair(3, bigResult("newer")),
			...toolPair(4, bigResult("newest")),
		]
		expect(computeCondenseKeepBoundary(messages)).toBe(messages.length)

		const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation")

		const result = await manageContext({
			messages,
			totalTokens: 71_000,
			contextWindow: 100_000,
			maxTokens: 8_000,
			apiHandler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 70,
			systemPrompt: "System prompt",
			taskId,
			profileThresholds: {},
			currentProfileId: "default",
			artifactStore: store,
		})

		expect(summarizeSpy).not.toHaveBeenCalled()
		// Only the oldest result was eligible; the newest three are the protected
		// working set, exactly as if the boundary had been a real one.
		expect(result.prunedCount).toBe(1)
		expect(resultText(result.messages, "use-1")!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)
		for (const id of ["use-2", "use-3", "use-4"]) {
			expect(resultText(result.messages, id)!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(false)
		}
		expect(resultText(result.messages, "use-4")).toBe(bigResult("newest"))
	})

	it("falls through to the summarizer when pruning is not enough, with the smaller history", async () => {
		const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
			messages: [{ role: "user", content: "## Conversation Summary\nsummary", ts: 1, isSummary: true }],
			summary: "summary",
			cost: 0.01,
			newContextTokens: 1_000,
		})
		const messages = buildHistory()

		const result = await manageContext({
			messages,
			totalTokens: 90_000, // far over the threshold; a 4 KB prune cannot save this
			contextWindow: 100_000,
			maxTokens: 8_000,
			apiHandler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 70,
			systemPrompt: "System prompt",
			taskId,
			profileThresholds: {},
			currentProfileId: "default",
			artifactStore: store,
		})

		expect(summarizeSpy).toHaveBeenCalledTimes(1)
		expect(result.summarySkipped).toBe(false)
		expect(result.prunedCount).toBe(2)

		// The summary ran on the PRUNED history, which is the whole point: its
		// input is smaller and cheaper than the pristine one.
		const passedMessages = summarizeSpy.mock.calls[0][0].messages
		expect(passedMessages).not.toBe(messages)
		expect(resultText(passedMessages, "use-1")!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)

		// And the prune numbers ride along on the condense telemetry event.
		expect(summarizeSpy.mock.calls[0][0].pruneStats).toEqual({
			prunedCount: 2,
			bytesSaved: result.prunedBytesSaved,
		})
	})

	it("does not prune when the setting is off", async () => {
		const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
			messages: [],
			summary: "summary",
			cost: 0,
			newContextTokens: 1_000,
		})
		const messages = buildHistory()

		const result = await manageContext({
			messages,
			totalTokens: 71_000,
			contextWindow: 100_000,
			maxTokens: 8_000,
			apiHandler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 70,
			systemPrompt: "System prompt",
			taskId,
			profileThresholds: {},
			currentProfileId: "default",
			artifactStore: store,
			pruneBeforeCondense: false,
		})

		expect(result.prunedCount).toBeUndefined()
		expect(summarizeSpy).toHaveBeenCalledTimes(1)
		expect(summarizeSpy.mock.calls[0][0].messages).toBe(messages)
		expect(fs.existsSync(path.join(store.getTaskDir(), "artifacts"))).toBe(false)
	})

	it("does not prune when no artifact store is available", async () => {
		const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
			messages: [],
			summary: "summary",
			cost: 0,
			newContextTokens: 1_000,
		})

		const result = await manageContext({
			messages: buildHistory(),
			totalTokens: 71_000,
			contextWindow: 100_000,
			maxTokens: 8_000,
			apiHandler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 70,
			systemPrompt: "System prompt",
			taskId,
			profileThresholds: {},
			currentProfileId: "default",
		})

		expect(result.prunedCount).toBeUndefined()
		expect(summarizeSpy).toHaveBeenCalledTimes(1)
	})

	it("does nothing at all while the context is below the thresholds", async () => {
		const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation")
		const messages = buildHistory()

		const result = await manageContext({
			messages,
			totalTokens: 10_000,
			contextWindow: 100_000,
			maxTokens: 8_000,
			apiHandler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 70,
			systemPrompt: "System prompt",
			taskId,
			profileThresholds: {},
			currentProfileId: "default",
			artifactStore: store,
		})

		expect(summarizeSpy).not.toHaveBeenCalled()
		expect(result.messages).toBe(messages)
		expect(result.prunedCount).toBeUndefined()
		expect(fs.existsSync(path.join(store.getTaskDir(), "artifacts"))).toBe(false)
	})

	it("is idempotent across rounds: a second pass writes no new artifacts", async () => {
		// Hand the (pruned) input straight back, so round two starts from exactly
		// the history round one produced.
		//
		// NOTE ON SCOPE: because this summarizer is a no-op (it returns
		// `options.messages` verbatim), this test proves idempotency only for the
		// pruner running twice over its OWN output. It says nothing about a round
		// where the summary really rewrites the history in between; the test right
		// below covers that case.
		vi.spyOn(condenseModule, "summarizeConversation").mockImplementation(async (options) => ({
			messages: options.messages,
			summary: "summary",
			cost: 0,
			newContextTokens: 1_000,
		}))

		const options = {
			totalTokens: 90_000,
			contextWindow: 100_000,
			maxTokens: 8_000,
			apiHandler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 70,
			systemPrompt: "System prompt",
			taskId,
			profileThresholds: {},
			currentProfileId: "default",
			artifactStore: store,
		}

		const first = await manageContext({ ...options, messages: buildHistory() })
		expect(first.prunedCount).toBe(2)

		const second = await manageContext({ ...options, messages: first.messages })
		expect(second.prunedCount).toBeUndefined()
		expect(fs.readdirSync(path.join(store.getTaskDir(), "artifacts"))).toHaveLength(2)
	})

	it("stays idempotent when the summary rewrote the history in between", async () => {
		// A summarizer that behaves like the real one: it replaces the history with
		// a summary message followed by a slice of what it was given. Round two
		// therefore starts from an array the pruner has never seen, whose only
		// oversized results are the previews round one wrote. Those must survive:
		// re-pruning a preview would spend a disk write to save nothing and would
		// bury the artifact id the first pass put there.
		vi.spyOn(condenseModule, "summarizeConversation").mockImplementation(async (options) => ({
			messages: [
				{ role: "user" as const, content: "## Conversation Summary\nearlier work", ts: 0, isSummary: true },
				...options.messages.slice(1, 11),
			],
			summary: "summary",
			cost: 0,
			newContextTokens: 1_000,
		}))

		const options = {
			totalTokens: 90_000,
			contextWindow: 100_000,
			maxTokens: 8_000,
			apiHandler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 70,
			systemPrompt: "System prompt",
			taskId,
			profileThresholds: {},
			currentProfileId: "default",
			artifactStore: store,
		}

		const first = await manageContext({ ...options, messages: buildHistory() })
		expect(first.prunedCount).toBe(2)
		// The condensed history really is a different array that still carries the
		// two previews, so round two has something to be tempted by.
		expect(resultText(first.messages, "use-1")!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)
		expect(resultText(first.messages, "use-2")!.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)

		const second = await manageContext({ ...options, messages: first.messages })
		expect(second.prunedCount).toBeUndefined()
		expect(fs.readdirSync(path.join(store.getTaskDir(), "artifacts"))).toHaveLength(2)
		// The previews are untouched: same text, same artifact ids.
		expect(resultText(second.messages, "use-1")).toBe(resultText(first.messages, "use-1"))
		expect(resultText(second.messages, "use-2")).toBe(resultText(first.messages, "use-2"))
	})
})
