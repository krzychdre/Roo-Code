import { ARTIFACT_SPILL_DEFAULTS } from "@roo-code/types"

import { PROTOCOL_TOOL_NAMES } from "../../shared/tools"

import type { ArtifactStore } from "./ArtifactStore"

/**
 * Marker that opens the notice of a spilled tool result.
 *
 * Exported so later context passes can recognise a spilled result and keep the
 * line that carries the artifact id (see `microcompactToolResults`): clearing
 * it would strand the artifact with no way for the model to name it.
 */
export const SPILL_NOTICE_PREFIX = "[Tool result:"

/**
 * Marker that opens the notice of a tool result PRUNED under context pressure
 * (`src/core/condense/toolResultPruner.ts`).
 *
 * It lives here, beside the spill prefix, because the two are one vocabulary:
 * both notices are the only place an artifact id survives, and every later pass
 * has to recognise both. Keeping them together is also what lets this module
 * stay a leaf: the pruner imports the prefix, instead of this module importing
 * the pruner and closing a cycle.
 */
export const PRUNE_NOTICE_PREFIX = "[Pruned "

/**
 * Byte allowance reserved for the notice line when judging whether a spill is
 * worth it. The real notice is a fixed sentence plus a fixed-width artifact id,
 * so a constant is accurate to within a few bytes.
 */
const SPILL_NOTICE_BYTES = 200

/**
 * Tools whose results never spill.
 *
 * Three reasons, and they are different:
 *
 * 1. `PROTOCOL_TOOL_NAMES` (`src/shared/tools.ts`): the result is protocol or
 *    instructions the task machinery or the next turn consumes, so a preview
 *    changes behaviour instead of saving context. Shared with microcompact's
 *    never-clear set so the two policies cannot drift apart.
 * 2. `read_file`: its schema promises whole-file reads (up to its own line cap)
 *    and tells the model not to re-read what it already has. Cutting a file to a
 *    120-line preview would break that contract, and read_file already caps
 *    itself, so there is nothing to protect the context from.
 * 3. Tools that already window or resolve their own output: `read_artifact`
 *    (offset/limit/search - spilling a window into a new artifact would make the
 *    model chase its own tail) and `access_mcp_resource` (a resource the model
 *    asked for by URI, usually a schema or document it needs whole).
 */
export const SPILL_BYPASS_TOOLS: ReadonlySet<string> = new Set<string>([
	...PROTOCOL_TOOL_NAMES,
	"read_file",
	"read_artifact",
	// Deprecated alias of read_artifact; a history replayed from an older
	// build can still carry this name.
	"read_command_output",
	"access_mcp_resource",
])

/**
 * Everything the policy needs to spill: where to write and how much may stay
 * inline. Assembled once per task by `ensureToolResultSpill`.
 */
export interface ToolResultSpillContext {
	store: ArtifactStore
	maxInlineBytes: number
	headLines?: number
	tailLines?: number
	/** Injectable clock, for deterministic tests. */
	now?: () => number
}

export interface SpillOutcome {
	/** Text that should go into the conversation. */
	text: string
	/** Set when the text was replaced by a preview. */
	artifactId?: string
	/** Byte size of the original text when it was spilled. */
	originalBytes?: number
}

/**
 * Formats a byte count the way an artifact notice quotes it.
 *
 * Exported so the spill notice and the prune notice cannot drift into two
 * different roundings of the same number.
 */
export function formatArtifactKb(bytes: number): string {
	return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * Slices a string down to at most `maxBytes` UTF-8 bytes, keeping whole
 * characters, counting from the start.
 */
function sliceHeadBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) {
		return text
	}

	let bytes = 0
	let index = 0

	while (index < text.length) {
		const charBytes = Buffer.byteLength(text[index], "utf8")
		if (bytes + charBytes > maxBytes) {
			break
		}
		bytes += charBytes
		index++
	}

	return text.slice(0, index)
}

/**
 * Slices a string down to at most `maxBytes` UTF-8 bytes, counting from the end.
 */
function sliceTailBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) {
		return text
	}

	let bytes = 0
	let index = text.length - 1

	while (index >= 0) {
		const charBytes = Buffer.byteLength(text[index], "utf8")
		if (bytes + charBytes > maxBytes) {
			break
		}
		bytes += charBytes
		index--
	}

	return text.slice(index + 1)
}

/**
 * Builds the head/tail preview body for a spilled result.
 *
 * Line-based first (a model reads lines, not bytes), then clamped by bytes so a
 * single enormous line - minified bundles, base64 blobs, one-line JSON - cannot
 * smuggle the whole payload back into the context.
 */
export function buildSpillPreview(
	text: string,
	headLines: number,
	tailLines: number,
	maxBytes: number,
): { body: string; headLines: number; tailLines: number } {
	const lines = text.split("\n")

	if (lines.length <= headLines + tailLines) {
		// Not enough lines to drop a middle: clamp by bytes instead so the
		// preview is still smaller than the inline budget.
		const half = Math.max(1, Math.floor(maxBytes / 2))
		const head = sliceHeadBytes(text, half)
		const tail = sliceTailBytes(text.slice(head.length), half)
		return {
			body: tail ? `${head}\n...\n${tail}` : head,
			headLines: head.split("\n").length,
			tailLines: tail ? tail.split("\n").length : 0,
		}
	}

	const half = Math.max(1, Math.floor(maxBytes / 2))
	const head = sliceHeadBytes(lines.slice(0, headLines).join("\n"), half)
	const tail = sliceTailBytes(lines.slice(-tailLines).join("\n"), half)

	// Report what the preview actually carries: byte clamping may have cut the
	// head or tail short, and a notice that lies is worse than no notice.
	return {
		body: `${head}\n...\n${tail}`,
		headLines: head === "" ? 0 : head.split("\n").length,
		tailLines: tail === "" ? 0 : tail.split("\n").length,
	}
}

/**
 * Applies the tool-result spill policy to one tool result.
 *
 * When `text` is larger than the inline budget and the tool is not on the
 * bypass list, the full text is written to a `tool` artifact and the returned
 * text becomes a notice plus a head/tail preview that quotes the artifact id.
 *
 * Best effort by design: if the artifact cannot be written, the full text is
 * returned unchanged. A spill is an optimisation, and it must never turn a
 * successful tool call into an error or into a preview whose artifact does not
 * exist.
 *
 * It also has to be worth it: a text with few lines is clamped by bytes, so its
 * preview can approach the whole inline budget. Paying a disk write and a lost
 * middle to shave a fifth off a result is a bad trade, so the spill only happens
 * when the replacement is at most half the size of the original.
 *
 * @param text - The tool result text as it would go into the conversation.
 * @param toolName - Canonical tool name, used for the bypass list.
 * @param context - Store plus limits; `undefined` disables the policy.
 */
export function applyToolResultSpill(
	text: string,
	toolName: string | undefined,
	context: ToolResultSpillContext | undefined,
): SpillOutcome {
	if (!context || !text) {
		return { text }
	}

	if (toolName && SPILL_BYPASS_TOOLS.has(toolName)) {
		return { text }
	}

	const bytes = Buffer.byteLength(text, "utf8")

	if (bytes <= context.maxInlineBytes) {
		return { text }
	}

	const headLines = context.headLines ?? ARTIFACT_SPILL_DEFAULTS.PREVIEW_HEAD_LINES
	const tailLines = context.tailLines ?? ARTIFACT_SPILL_DEFAULTS.PREVIEW_TAIL_LINES

	// Build the preview first: if it does not save at least half the bytes the
	// whole exercise is pure cost, and no artifact is written at all.
	const preview = buildSpillPreview(text, headLines, tailLines, context.maxInlineBytes)
	const replacementBytes = Buffer.byteLength(preview.body, "utf8") + SPILL_NOTICE_BYTES

	if (replacementBytes * 2 > bytes) {
		return { text }
	}

	let artifactId: string
	try {
		const saved = context.store.save("tool", text, context.now ? context.now() : Date.now())
		artifactId = saved.id
	} catch (error) {
		console.warn(
			`[spillPolicy] Keeping ${bytes} byte ${toolName ?? "tool"} result inline; artifact write failed:`,
			error,
		)
		return { text }
	}

	const notice =
		`${SPILL_NOTICE_PREFIX} ${formatArtifactKb(bytes)}, showing first ${preview.headLines} and last ${preview.tailLines} lines. ` +
		`Full output saved as artifact "${artifactId}". ` +
		`Use read_artifact (search/offset/limit) to inspect the rest.]`

	return { text: `${notice}\n${preview.body}`, artifactId, originalBytes: bytes }
}

/**
 * Returns the spill notice line of a previously spilled tool result, or
 * `undefined` when the text is not one.
 *
 * A later context pass that drops the body of such a result must keep this line:
 * it is the only place the artifact id and the `read_artifact` instruction
 * survive, and without it the full output is on disk with no name the model can
 * quote.
 */
export function extractSpillNotice(text: string): string | undefined {
	if (!text.startsWith(SPILL_NOTICE_PREFIX)) {
		return undefined
	}

	const firstLine = text.split("\n", 1)[0]
	return firstLine.includes('artifact "') ? firstLine : undefined
}

/**
 * Returns the artifact-citing notice line of a reduced tool result, whether it
 * was reduced by the spill policy at push time or by the pruner under context
 * pressure, or `undefined` when the text carries no such line.
 *
 * This is what a pass that clears a result's body should call: after WS-C a
 * block can carry either notice, and dropping a prune notice strands the
 * `prune-*.txt` artifact exactly as dropping a spill notice would strand the
 * `tool-*.txt` one.
 */
export function extractArtifactNotice(text: string): string | undefined {
	if (!text.startsWith(SPILL_NOTICE_PREFIX) && !text.startsWith(PRUNE_NOTICE_PREFIX)) {
		return undefined
	}

	const firstLine = text.split("\n", 1)[0]
	return firstLine.includes('artifact "') ? firstLine : undefined
}
