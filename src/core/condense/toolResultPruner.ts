import { Anthropic } from "@anthropic-ai/sdk"

import { PRUNE_CONDENSE_DEFAULTS } from "@roo-code/types"

import type { ArtifactStore } from "../artifacts/ArtifactStore"
import {
	PRUNE_NOTICE_PREFIX,
	SPILL_BYPASS_TOOLS,
	SPILL_NOTICE_PREFIX,
	buildSpillPreview,
	formatArtifactKb,
} from "../artifacts/spillPolicy"
import { MICROCOMPACT_CLEARED_PLACEHOLDER } from "../context-management/microcompact"
import { ApiMessage } from "../task-persistence/apiMessages"
import { CONDENSE_KEEP_RECENT_MESSAGES } from "./index"

/**
 * Deterministic tool-result pruning.
 *
 * A cheap, NO-LLM reduction that runs on context pressure BEFORE the expensive,
 * lossy `summarizeConversation`. It is the port of dsh's tool-result pruner in
 * its `compaction-basic` pipeline: shrink the old, bulky, low-signal part of the
 * conversation first, and pay for a model-written summary only if that was not
 * enough.
 *
 * What it does: for every `tool_result` older than the protected recent tail
 * whose text is larger than the byte budget, the full text is written to a
 * `prune` artifact and the block keeps only the first N and last N lines plus a
 * notice naming the artifact and the tool that reads it back.
 *
 * How it differs from microcompaction (`../context-management/microcompact.ts`),
 * which runs first:
 *
 * - Microcompaction is NON-DESTRUCTIVE. It strips only the OUTGOING copy of the
 *   request; the stored history keeps the full text, so a mid-task switch to a
 *   wider-context model silently gets everything back. Its placeholder tells the
 *   model to re-read the file or re-run the command.
 * - Pruning is DESTRUCTIVE for the conversation but LOSSLESS for the task: the
 *   original moves to disk and the replacement cites the artifact id, so the
 *   text is one `read_artifact` call away. Because the original is gone from the
 *   history, the citation is mandatory and the change must be persisted (it has
 *   to survive a resume and a mid-task mode switch).
 *
 * That ordering is the whole point: try the reversible pass, then the
 * recoverable one, and only then the irreversible LLM summary.
 *
 * No message is removed and no `tool_result` block disappears, so every
 * `tool_use` keeps its partner: only the text inside a result shrinks.
 */

export { PRUNE_NOTICE_PREFIX }

/**
 * Builds the notice that replaces a pruned result's dropped middle.
 *
 * Written for a weak local model (GLM / Qwen / Llama): it says what happened,
 * names the artifact, and spells out the exact call that recovers the rest, so a
 * model that reads only the first sentence still learns the data is not lost.
 */
export function buildPruneNotice(
	originalBytes: number,
	headLines: number,
	tailLines: number,
	artifactId: string,
): string {
	return (
		`${PRUNE_NOTICE_PREFIX}${formatArtifactKb(originalBytes)} of old tool output, keeping the first ${headLines} and last ${tailLines} lines. ` +
		`Full text saved as artifact "${artifactId}". ` +
		`Use read_artifact with artifact_id "${artifactId}" (search/offset/limit) to read the rest.]`
	)
}

/**
 * Byte allowance the "is it worth it" check reserves for the notice line. The
 * notice is a fixed sentence plus two copies of a fixed-width artifact id, so a
 * constant is accurate to within a few bytes.
 */
const PRUNE_NOTICE_BYTES = 260

export interface PruneToolResultsOptions {
	/**
	 * Index into `messages` at which the protected recent tail starts. Only
	 * `messages[0..keepBoundary)` are eligible. Callers pass
	 * `computeCondenseKeepBoundary(messages)` so the pruner protects exactly the
	 * tail a condense would keep verbatim.
	 *
	 * `messages.length` is that function's SENTINEL for "no raw tail, summarize
	 * everything", not a real boundary, and it is re-interpreted here. See
	 * `resolveKeepBoundary`.
	 */
	keepBoundary: number
	/** A result larger than this many UTF-8 bytes is a prune candidate. */
	budgetBytes: number
	/** Lines kept from the start of a pruned result. */
	headLines?: number
	/** Lines kept from the end of a pruned result. */
	tailLines?: number
	/** Where the originals are persisted. */
	store: ArtifactStore
	/**
	 * `tool_use_id`s to leave alone. The caller passes the ids microcompaction
	 * strips at send time: their text is already absent from the outgoing
	 * request, so pruning them buys nothing this round and would only spend a
	 * disk write.
	 */
	skipToolUseIds?: ReadonlySet<string>
	/** Injectable clock, for deterministic tests. */
	now?: () => number
}

export interface PruneToolResultsResult {
	/**
	 * The full message array with old oversized tool results replaced by
	 * previews. Returns the SAME reference as the input when nothing changed, so
	 * callers can detect a no-op with `result.messages === messages`.
	 */
	messages: ApiMessage[]
	/** Number of tool-result payloads that were pruned. */
	prunedCount: number
	/** Bytes removed from the conversation, net of the previews written back. */
	bytesSaved: number
	/** Ids of the `prune` artifacts written, in encounter order. */
	artifacts: string[]
	/**
	 * Concatenation of the original text of every pruned payload. Lets the caller
	 * price the reduction with one `countTokens` call instead of recounting the
	 * whole history.
	 */
	prunedText: string
	/** Concatenation of the replacements written back, for the same reason. */
	replacementText: string
}

/**
 * A payload no pass should touch again.
 *
 * Three shapes, three different reasons:
 * 1. Spilled by the push-time policy (`applyToolResultSpill`): already a small
 *    preview, and already citing an artifact.
 * 2. Pruned by an earlier run of this pass: same, and re-pruning would bury the
 *    first artifact behind a second one. This is what makes the pass idempotent.
 * 3. Cleared by microcompaction: nothing left to reclaim but the placeholder.
 *    Defensive, since microcompaction only ever clears the outgoing copy, but a
 *    history written by a future (or older) build must not confuse this pass.
 */
/**
 * Turns a caller's `keepBoundary` into the index this pass may actually prune up
 * to, and it exists because the same number means opposite things in the two
 * modules that produce and consume it.
 *
 * `computeCondenseKeepBoundary` returns `messages.length` as a SENTINEL: "the
 * since-last-summary region is too small to be worth splitting, so summarize
 * everything and keep no raw tail". Read literally by a pruner, that sentinel
 * says "protect nothing", which is the exact opposite of what it means. Right
 * after a condense (or in any short history) the newest tool result, the one the
 * model is working from this very turn, would be the first thing shredded.
 *
 * So the sentinel is translated into the tail the condense would have kept if it
 * had kept one. The clamp lives here rather than in the caller on purpose: it is
 * a safety property of the pass, and no caller should be able to opt out of it
 * by passing a large number.
 */
export function resolveKeepBoundary(keepBoundary: number, messageCount: number): number {
	if (!Number.isFinite(keepBoundary) || keepBoundary >= messageCount) {
		return Math.max(0, messageCount - CONDENSE_KEEP_RECENT_MESSAGES)
	}

	return Math.max(0, keepBoundary)
}

function isAlreadyReduced(text: string): boolean {
	return (
		text.startsWith(SPILL_NOTICE_PREFIX) ||
		text.startsWith(PRUNE_NOTICE_PREFIX) ||
		text === MICROCOMPACT_CLEARED_PLACEHOLDER ||
		text.endsWith(`\n${MICROCOMPACT_CLEARED_PLACEHOLDER}`)
	)
}

/**
 * Prunes old oversized tool results, oldest first.
 *
 * Deterministic and idempotent: running it again on its own output changes
 * nothing. Best effort like the spill policy: a failed artifact write leaves the
 * result inline rather than advertising an artifact that does not exist.
 *
 * Never touches:
 * - anything at or after the resolved keep boundary (the model's recent working
 *   set); see `resolveKeepBoundary` for why the caller's number is clamped here
 *   rather than trusted,
 * - user or assistant TEXT blocks, only `tool_result` content shrinks,
 * - results of tools on `SPILL_BYPASS_TOOLS` (protocol output, the `read_file`
 *   whole-file contract, and readers that already window themselves). The check
 *   is keyed on the paired `tool_use` block and reuses the spill policy's set,
 *   so the two policies cannot drift apart,
 * - results whose `tool_use` partner cannot be found at all: an unidentified
 *   result may well be one of the protocol results the bypass list protects, and
 *   guessing wrong destroys instructions the task machinery depends on, so the
 *   unknown case fails CLOSED,
 * - messages hidden by a previous condense or truncation: they are never sent to
 *   the API, so pruning them would write artifacts nobody can read.
 *
 * @param messages The full API conversation history (including tagged messages).
 * @param options Boundary, budget, preview shape and the artifact store.
 */
export function pruneToolResults(messages: ApiMessage[], options: PruneToolResultsOptions): PruneToolResultsResult {
	const noop: PruneToolResultsResult = {
		messages,
		prunedCount: 0,
		bytesSaved: 0,
		artifacts: [],
		prunedText: "",
		replacementText: "",
	}

	const { store, budgetBytes } = options
	const headLines = options.headLines ?? PRUNE_CONDENSE_DEFAULTS.PREVIEW_HEAD_LINES
	const tailLines = options.tailLines ?? PRUNE_CONDENSE_DEFAULTS.PREVIEW_TAIL_LINES
	const skip = options.skipToolUseIds
	const now = options.now ?? Date.now
	const keepBoundary = resolveKeepBoundary(options.keepBoundary, messages.length)

	if (!store || !(budgetBytes > 0) || keepBoundary <= 0 || messages.length === 0) {
		return noop
	}

	// Map tool_use_id -> tool name from assistant tool_use blocks, so a result's
	// source tool decides whether it may be pruned at all. Built over the WHOLE
	// history: a pair can straddle the boundary in either direction.
	const toolNameById = new Map<string, string>()
	for (const msg of messages) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_use") {
					toolNameById.set(block.id, block.name)
				}
			}
		}
	}

	// Everything before the most recent summary is already hidden from the API by
	// the fresh-start model in `getEffectiveApiHistory`, so pruning it would spend
	// disk writes on text nobody sends.
	let firstEligible = 0
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].isSummary) {
			firstEligible = i
			break
		}
	}

	const artifacts: string[] = []
	let prunedCount = 0
	let bytesSaved = 0
	let prunedText = ""
	let replacementText = ""

	/**
	 * Prunes one text payload, or returns `undefined` to keep it as it is.
	 * Every "leave it alone" rule lives here so a string result and an array
	 * result can never be judged differently.
	 */
	const pruneText = (text: string, toolUseId: string): string | undefined => {
		if (!text || isAlreadyReduced(text) || skip?.has(toolUseId)) {
			return undefined
		}

		const bytes = Buffer.byteLength(text, "utf8")
		if (bytes <= budgetBytes) {
			return undefined
		}

		// Build the preview before writing anything: if the replacement does not
		// save at least half the bytes, the disk write and the lost middle buy
		// nothing. Same trade the spill policy makes, and the same helper, so a
		// pruned preview and a spilled preview look identical to the model.
		const preview = buildSpillPreview(text, headLines, tailLines, budgetBytes)
		const projectedBytes = Buffer.byteLength(preview.body, "utf8") + PRUNE_NOTICE_BYTES
		if (projectedBytes * 2 > bytes) {
			return undefined
		}

		let artifactId: string
		try {
			artifactId = store.save("prune", text, now()).id
		} catch (error) {
			console.warn(`[toolResultPruner] Keeping ${bytes} byte result inline; artifact write failed:`, error)
			return undefined
		}

		const replacement = `${buildPruneNotice(bytes, preview.headLines, preview.tailLines, artifactId)}\n${preview.body}`

		artifacts.push(artifactId)
		prunedCount++
		bytesSaved += Math.max(0, bytes - Buffer.byteLength(replacement, "utf8"))
		prunedText += `${text}\n`
		replacementText += `${replacement}\n`

		return replacement
	}

	let anyTouched = false

	const newMessages = messages.map((msg, index) => {
		// The recent tail, the pre-summary prefix, and everything a previous
		// condense or truncation already hid are all off limits. Assistant
		// messages never enter the loop at all, which is what guarantees no
		// decision text is ever rewritten.
		if (
			index >= keepBoundary ||
			index < firstEligible ||
			msg.role !== "user" ||
			!Array.isArray(msg.content) ||
			msg.condenseParent ||
			msg.truncationParent ||
			msg.isTruncationMarker
		) {
			return msg
		}

		let touched = false

		const newContent = msg.content.map((block) => {
			// Only tool results shrink. A user text block is the human talking.
			if (block.type !== "tool_result") {
				return block
			}

			const tr = block as Anthropic.Messages.ToolResultBlockParam
			const toolName = toolNameById.get(tr.tool_use_id)

			// Fail CLOSED on an unidentified result. An orphaned tool_result (its
			// tool_use was condensed away, or the history was written by a build
			// that named tools differently) could be anything, including one of
			// the protocol results the bypass list exists to protect. Not pruning
			// costs a little context; pruning a `skill` or `tools_load` result
			// costs the task its instructions.
			if (!toolName || SPILL_BYPASS_TOOLS.has(toolName)) {
				return block
			}

			if (typeof tr.content === "string") {
				const replacement = pruneText(tr.content, tr.tool_use_id)
				if (replacement === undefined) {
					return block
				}
				touched = true
				return { ...tr, content: replacement }
			}

			if (!Array.isArray(tr.content)) {
				return block
			}

			// Array form: prune the oversized TEXT blocks and leave images (and
			// every other block type) exactly where they are.
			let innerTouched = false
			const newInner = tr.content.map((inner) => {
				if (inner.type !== "text") {
					return inner
				}
				const replacement = pruneText(inner.text, tr.tool_use_id)
				if (replacement === undefined) {
					return inner
				}
				innerTouched = true
				return { ...inner, text: replacement }
			})

			if (!innerTouched) {
				return block
			}
			touched = true
			return { ...tr, content: newInner }
		})

		if (!touched) {
			return msg
		}

		anyTouched = true
		return { ...msg, content: newContent }
	})

	if (!anyTouched) {
		return noop
	}

	return { messages: newMessages, prunedCount, bytesSaved, artifacts, prunedText, replacementText }
}
