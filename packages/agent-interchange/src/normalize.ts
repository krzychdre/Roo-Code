import type { InterchangeBlock } from "./types.js"

/**
 * Anthropic-shaped message content → canonical blocks.
 *
 * Both stores hold the same family of blocks but spell some of them
 * differently: Claude Code writes `thinking` with the prose under `thinking`,
 * Tumble Code writes `reasoning` with the prose under `text` and an optional
 * `summary` array. `content` is sometimes a bare string (older Tumble tasks).
 * Unknown block types are dropped rather than guessed at.
 */
export function normalizeContent(content: unknown): InterchangeBlock[] {
	if (typeof content === "string") {
		return content.trim() ? [{ type: "text", text: content }] : []
	}

	if (!Array.isArray(content)) {
		return []
	}

	const blocks: InterchangeBlock[] = []

	for (const raw of content) {
		const block = normalizeBlock(raw)

		if (block) {
			blocks.push(block)
		}
	}

	return blocks
}

function normalizeBlock(raw: unknown): InterchangeBlock | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined
	}

	const block = raw as Record<string, unknown>

	switch (block.type) {
		case "text": {
			const text = asString(block.text)
			return text ? { type: "text", text } : undefined
		}
		case "thinking":
		case "reasoning":
		case "redacted_thinking": {
			const text = asString(block.thinking) || asString(block.text) || summaryText(block.summary)
			return text ? { type: "thinking", text } : undefined
		}
		case "tool_use": {
			const name = asString(block.name)
			return name ? { type: "tool_use", id: asString(block.id), name, input: block.input } : undefined
		}
		case "tool_result": {
			return {
				type: "tool_result",
				toolUseId: asString(block.tool_use_id) || asString(block.toolUseId),
				text: flattenResultContent(block.content),
				isError: block.is_error === true || block.isError === true,
			}
		}
		case "image": {
			const source = block.source as Record<string, unknown> | undefined
			return { type: "image", mediaType: asString(source?.media_type) }
		}
		default:
			return undefined
	}
}

/** A tool result's payload is a string, or blocks that are usually text. */
function flattenResultContent(content: unknown): string {
	if (typeof content === "string") {
		return content
	}

	if (!Array.isArray(content)) {
		return ""
	}

	return content
		.map((entry) => {
			if (typeof entry === "string") {
				return entry
			}

			if (entry && typeof entry === "object") {
				const block = entry as Record<string, unknown>

				if (block.type === "image") {
					return "[image]"
				}

				return asString(block.text)
			}

			return ""
		})
		.filter(Boolean)
		.join("\n")
}

function summaryText(summary: unknown): string {
	if (!Array.isArray(summary)) {
		return ""
	}

	return summary
		.map((entry) =>
			entry && typeof entry === "object" ? asString((entry as Record<string, unknown>).text) : asString(entry),
		)
		.filter(Boolean)
		.join("\n")
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : ""
}

/** The concatenated prose of a message, ignoring tools and reasoning. */
export function textOf(blocks: InterchangeBlock[]): string {
	return blocks
		.filter((block): block is Extract<InterchangeBlock, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim()
}

/** First `limit` characters of `value`, collapsed onto one line. */
export function oneLine(value: string, limit = 120): string {
	const collapsed = value.replace(/\s+/g, " ").trim()
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`
}
