import * as fs from "node:fs"
import * as path from "node:path"

import { streamJsonl } from "./jsonl.js"
import { listClaudeSessions } from "./readers/claude-code.js"
import { listTumbleSessions } from "./readers/tumble-code.js"
import { oneLine } from "./normalize.js"
import type { AgentKind, SessionSummary } from "./types.js"

/**
 * Text search across both stores.
 *
 * Deliberately a substring scan over the raw session files rather than a parsed
 * search: it is one pass, it finds text wherever it sits (prompt, tool input,
 * tool output), and it never has to hold a large session in memory. Cost is
 * bounded by only scanning the newest `scanLimit` sessions and by stopping at
 * `maxHits` matches per session.
 */

export interface SearchOptions {
	query: string
	agent?: AgentKind
	cwd?: string
	/** Sessions to return. Default 20. */
	limit?: number
	/** Sessions to scan, newest first. Default 60. */
	scanLimit?: number
	/** Snippets kept per session. Default 3. */
	maxHits?: number
}

export interface SearchHit {
	session: SessionSummary
	snippets: string[]
}

export async function searchSessions(options: SearchOptions): Promise<SearchHit[]> {
	const { query, agent, cwd, limit = 20, scanLimit = 60, maxHits = 3 } = options
	const needle = query.toLowerCase()

	if (!needle.trim()) {
		return []
	}

	const candidates: SessionSummary[] = [
		...(agent === "tumble-code" ? [] : listClaudeSessions({ cwd })),
		...(agent === "claude-code" ? [] : listTumbleSessions({ cwd })),
	]
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, scanLimit)

	const hits: SearchHit[] = []

	for (const session of candidates) {
		const snippets =
			session.agent === "claude-code"
				? await scanJsonl(session.path, needle, maxHits)
				: scanTaskDir(session.path, needle, maxHits)

		if (snippets.length > 0) {
			hits.push({ session, snippets })
		}

		if (hits.length >= limit) {
			break
		}
	}

	return hits
}

export function renderSearchHits(hits: SearchHit[]): string {
	if (hits.length === 0) {
		return "No matching sessions."
	}

	const lines: string[] = []

	for (const hit of hits) {
		lines.push(`### ${hit.session.title}`)
		lines.push(`\`${hit.session.id}\` · ${hit.session.agent}${hit.session.cwd ? ` · ${hit.session.cwd}` : ""}`)
		lines.push("")

		for (const snippet of hit.snippets) {
			lines.push(`- …${snippet}…`)
		}

		lines.push("")
	}

	return lines.join("\n").trimEnd()
}

async function scanJsonl(file: string, needle: string, maxHits: number): Promise<string[]> {
	const snippets: string[] = []

	try {
		await streamJsonl<Record<string, unknown>>(file, (record) => {
			if (snippets.length >= maxHits) {
				return
			}

			const serialized = JSON.stringify(record)
			const snippet = snippetOf(serialized, needle)

			if (snippet) {
				snippets.push(snippet)
			}
		})
	} catch {
		return snippets
	}

	return snippets
}

function scanTaskDir(dir: string, needle: string, maxHits: number): string[] {
	const snippets: string[] = []

	for (const name of ["api_conversation_history.json", "ui_messages.json"]) {
		if (snippets.length >= maxHits) {
			break
		}

		let raw: string

		try {
			raw = fs.readFileSync(path.join(dir, name), "utf8")
		} catch {
			continue
		}

		let from = 0

		while (snippets.length < maxHits) {
			const index = raw.toLowerCase().indexOf(needle, from)

			if (index === -1) {
				break
			}

			snippets.push(context(raw, index, needle.length))
			from = index + needle.length
		}
	}

	return snippets
}

function snippetOf(haystack: string, needle: string): string | undefined {
	const index = haystack.toLowerCase().indexOf(needle)
	return index === -1 ? undefined : context(haystack, index, needle.length)
}

function context(haystack: string, index: number, length: number): string {
	const start = Math.max(0, index - 80)
	const end = Math.min(haystack.length, index + length + 80)

	return oneLine(haystack.slice(start, end), 200)
}
