import * as fs from "node:fs"
import * as path from "node:path"

import { claudeProjectDirs, claudeProjectDirsForCwd, samePath } from "../locate.js"
import { parseLine, readHeadLines, readTailLines, streamJsonl } from "../jsonl.js"
import { normalizeContent, oneLine, textOf } from "../normalize.js"
import type { InterchangeMessage, ListOptions, ReadOptions, Session, SessionSummary } from "../types.js"

/**
 * Reader for `~/.claude/projects/<slug>/<sessionId>.jsonl`.
 *
 * Record types seen in the wild: `user`, `assistant`, `ai-title`, `last-prompt`,
 * `file-history-snapshot`, `queue-operation`, `attachment`, `summary`. Only the
 * first four carry anything a briefing wants; the rest are skipped.
 */

interface ClaudeRecord {
	type?: string
	uuid?: string
	parentUuid?: string | null
	sessionId?: string
	cwd?: string
	gitBranch?: string
	version?: string
	timestamp?: string
	isSidechain?: boolean
	message?: { role?: string; model?: string; content?: unknown }
	aiTitle?: string
	lastPrompt?: string
	summary?: string
}

export function listClaudeSessions(options: ListOptions = {}): SessionSummary[] {
	const dirs = options.cwd ? projectDirsFor(options.cwd) : claudeProjectDirs()
	const summaries: SessionSummary[] = []

	for (const dir of dirs) {
		for (const file of sessionFilesIn(dir)) {
			const summary = summarize(file)

			if (!summary) {
				continue
			}

			if (options.cwd && !samePath(summary.cwd, options.cwd)) {
				continue
			}

			if (options.since && summary.updatedAt < options.since) {
				continue
			}

			if (options.query && !summary.title.toLowerCase().includes(options.query.toLowerCase())) {
				continue
			}

			summaries.push(summary)
		}
	}

	summaries.sort((a, b) => b.updatedAt - a.updatedAt)

	return options.limit ? summaries.slice(0, options.limit) : summaries
}

/**
 * The workspace a Claude Code project directory actually belongs to.
 *
 * The directory name is a lossy slug, so this is how a caller confirms that the
 * directory it resolved is the one it meant. Reads the head of one session
 * file, not the whole store.
 */
export function claudeProjectCwd(projectDir: string): string | undefined {
	for (const file of sessionFilesIn(projectDir)) {
		for (const line of readHeadLines(file)) {
			const cwd = parseLine<ClaudeRecord>(line)?.cwd

			if (cwd) {
				return cwd
			}
		}
	}

	return undefined
}

export function findClaudeSessionFile(id: string): string | undefined {
	if (!/^[A-Za-z0-9._-]+$/.test(id)) {
		return undefined
	}

	for (const dir of claudeProjectDirs()) {
		const file = path.join(dir, `${id}.jsonl`)

		if (fs.existsSync(file)) {
			return file
		}
	}

	return undefined
}

export async function readClaudeSession(id: string, options: ReadOptions = {}): Promise<Session | undefined> {
	const file = findClaudeSessionFile(id)

	if (!file) {
		return undefined
	}

	const summary = summarize(file)

	if (!summary) {
		return undefined
	}

	const messages: InterchangeMessage[] = []
	const sidechainMessages: InterchangeMessage[] = []

	await streamJsonl<ClaudeRecord>(file, (record) => {
		const message = toMessage(record)

		if (!message) {
			return
		}

		if (message.isSidechain && !options.includeSidechains) {
			sidechainMessages.push(message)
		} else {
			messages.push(message)
		}
	})

	return { ...summary, messageCount: messages.length, messages, sidechainMessages }
}

/**
 * Directories to search for a workspace. The slug fast path wins when it
 * exists; otherwise every project directory is scanned and matched on the `cwd`
 * recorded inside the sessions, because the slug is lossy.
 */
function projectDirsFor(cwd: string): string[] {
	const fastPath = claudeProjectDirsForCwd(cwd)
	return fastPath.length > 0 ? fastPath : claudeProjectDirs()
}

function sessionFilesIn(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => path.join(dir, entry.name))
	} catch {
		return []
	}
}

/**
 * Build a summary from a bounded head and tail slice — never the whole file.
 *
 * The head supplies `cwd`, branch and the opening prompt; the tail supplies the
 * last activity, the model-assigned title and the model in use. A session whose
 * head holds only bookkeeping records still summarizes, just with less detail.
 */
function summarize(file: string): SessionSummary | undefined {
	let stat: fs.Stats

	try {
		stat = fs.statSync(file)
	} catch {
		return undefined
	}

	if (stat.size === 0) {
		return undefined
	}

	const id = path.basename(file, ".jsonl")
	const head = readHeadLines(file).map((line) => parseLine<ClaudeRecord>(line))
	const tail = readTailLines(file).map((line) => parseLine<ClaudeRecord>(line))

	let cwd: string | undefined
	let gitBranch: string | undefined
	let createdAt: number | undefined
	let firstPrompt = ""

	for (const record of head) {
		if (!record) {
			continue
		}

		cwd ??= record.cwd
		gitBranch ??= record.gitBranch
		createdAt ??= parseTimestamp(record.timestamp)

		if (!firstPrompt && record.type === "user" && !record.isSidechain) {
			firstPrompt = textOf(normalizeContent(record.message?.content))
		}
	}

	let updatedAt: number | undefined
	let aiTitle: string | undefined
	let lastPrompt: string | undefined
	let model: string | undefined

	for (const record of tail) {
		if (!record) {
			continue
		}

		updatedAt = parseTimestamp(record.timestamp) ?? updatedAt
		aiTitle = record.aiTitle ?? aiTitle
		lastPrompt = record.lastPrompt ?? lastPrompt
		model = record.message?.model ?? model
		cwd ??= record.cwd
		gitBranch ??= record.gitBranch
	}

	const title = aiTitle?.trim() || oneLine(firstPrompt || lastPrompt || "", 100) || `Session ${id.slice(0, 8)}`

	return {
		agent: "claude-code",
		id,
		title,
		cwd,
		gitBranch,
		createdAt: createdAt ?? (stat.birthtimeMs || stat.mtimeMs),
		updatedAt: updatedAt ?? stat.mtimeMs,
		path: file,
		sizeBytes: stat.size,
		model,
	}
}

function toMessage(record: ClaudeRecord): InterchangeMessage | undefined {
	if (record.type !== "user" && record.type !== "assistant") {
		return undefined
	}

	const blocks = normalizeContent(record.message?.content)

	if (blocks.length === 0) {
		return undefined
	}

	return {
		role: record.type,
		ts: parseTimestamp(record.timestamp),
		blocks,
		isSidechain: record.isSidechain === true,
		model: record.message?.model,
	}
}

function parseTimestamp(value: string | undefined): number | undefined {
	if (!value) {
		return undefined
	}

	const ms = Date.parse(value)

	return Number.isNaN(ms) ? undefined : ms
}
