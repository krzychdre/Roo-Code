import { formatTime } from "./briefing.js"
import type { InterchangeBlock, InterchangeMessage, Session } from "./types.js"

/**
 * The raw conversation, rendered readably and — crucially — in pages.
 *
 * The largest session in this repo's Claude Code store is 8.9 MB; handing that
 * to another agent in one call would blow its context. Every read therefore
 * states the total and the offset to continue from.
 */

export interface TranscriptOptions {
	/** First message index to render. Default 0. */
	offset?: number
	/** How many messages to render. Default 30. */
	limit?: number
	/** Include reasoning blocks. Default false — they are long and rarely load-bearing. */
	includeThinking?: boolean
	/** Characters kept per block. Default 1500. */
	maxBlockChars?: number
	/** Render the subagent turns instead of the main thread. */
	sidechains?: boolean
}

export interface TranscriptPage {
	markdown: string
	offset: number
	limit: number
	total: number
	/** Index to pass as the next `offset`, or `undefined` at the end. */
	nextOffset?: number
}

export function renderTranscript(session: Session, options: TranscriptOptions = {}): TranscriptPage {
	const { offset = 0, limit = 30, includeThinking = false, maxBlockChars = 1500, sidechains = false } = options
	const source = sidechains ? (session.sidechainMessages ?? []) : session.messages
	const total = source.length
	const start = Math.max(0, Math.min(offset, total))
	const end = Math.min(start + Math.max(1, limit), total)
	const lines: string[] = []

	lines.push(`# Transcript — ${session.title}`, "")
	lines.push(
		`Messages ${total === 0 ? 0 : start + 1}–${end} of ${total}${sidechains ? " (subagent turns)" : ""}.`,
		"",
	)

	for (let index = start; index < end; index++) {
		lines.push(...renderMessage(source[index]!, index, { includeThinking, maxBlockChars }))
	}

	const nextOffset = end < total ? end : undefined

	if (nextOffset !== undefined) {
		lines.push(`_${total - end} more messages — read again with \`offset: ${nextOffset}\`._`, "")
	}

	return { markdown: lines.join("\n").trimEnd() + "\n", offset: start, limit: end - start, total, nextOffset }
}

function renderMessage(
	message: InterchangeMessage,
	index: number,
	options: { includeThinking: boolean; maxBlockChars: number },
): string[] {
	const stamp = message.ts ? ` · ${formatTime(message.ts)}` : ""
	const lines = [`## [${index}] ${message.role}${stamp}`, ""]

	for (const block of message.blocks) {
		lines.push(...renderBlock(block, options))
	}

	return lines
}

function renderBlock(block: InterchangeBlock, options: { includeThinking: boolean; maxBlockChars: number }): string[] {
	switch (block.type) {
		case "text":
			return [truncate(block.text, options.maxBlockChars), ""]
		case "thinking":
			return options.includeThinking
				? [
						"<details><summary>reasoning</summary>",
						"",
						truncate(block.text, options.maxBlockChars),
						"",
						"</details>",
						"",
					]
				: []
		case "tool_use":
			return [
				`**→ ${block.name}**`,
				"",
				"```json",
				truncate(stringify(block.input), options.maxBlockChars),
				"```",
				"",
			]
		case "tool_result":
			return [
				`**← result${block.isError ? " (error)" : ""}**`,
				"",
				"```",
				truncate(block.text || "(empty)", options.maxBlockChars),
				"```",
				"",
			]
		case "image":
			return [`_[image${block.mediaType ? `: ${block.mediaType}` : ""}]_`, ""]
	}
}

function stringify(input: unknown): string {
	try {
		return JSON.stringify(input, null, 2) ?? String(input)
	} catch {
		return String(input)
	}
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated, ${text.length - limit} more characters]`
}
