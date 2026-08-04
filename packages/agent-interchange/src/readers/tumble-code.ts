import * as fs from "node:fs"
import * as path from "node:path"

import { isDirectory, listDirectories, samePath, tumbleTaskRoots } from "../locate.js"
import { normalizeContent, oneLine } from "../normalize.js"
import type { InterchangeMessage, ListOptions, ReadOptions, Session, SessionSummary } from "../types.js"

/**
 * Reader for `<globalStorage>/<extension>/tasks/<taskId>/`.
 *
 * `history_item.json` is the cheap summary and is present for all but the
 * oldest tasks; when it is missing the directory is summarized from
 * `ui_messages.json` instead. `api_conversation_history.json` holds the
 * conversation in Anthropic message shape with a `ts` per message.
 */

interface HistoryItemFile {
	id?: string
	number?: number
	ts?: number
	task?: string
	tokensIn?: number
	tokensOut?: number
	totalCost?: number
	size?: number
	workspace?: string
	mode?: string
	apiConfigName?: string
	status?: string
	parentTaskId?: string
	rootTaskId?: string
	childIds?: string[]
	completionResultSummary?: string
}

interface UiMessage {
	ts?: number
	type?: string
	say?: string
	ask?: string
	text?: string
}

interface ApiMessageFile {
	role?: string
	content?: unknown
	ts?: number
	isSummary?: boolean
}

/**
 * Where to look for tasks.
 *
 * The extension knows its own storage directory exactly — including a
 * `customStoragePath` the user set — so it passes it in rather than letting the
 * discovery heuristics guess and possibly land on another editor's profile.
 */
export interface TumbleStoreOptions {
	/** globalStorage directories (the ones containing `tasks/`). */
	storageRoots?: string[]
}

function taskRootsFor(storageRoots: string[] | undefined): string[] {
	if (!storageRoots || storageRoots.length === 0) {
		return tumbleTaskRoots()
	}

	return storageRoots.map((root) => path.join(root, "tasks")).filter((dir) => isDirectory(dir))
}

export function listTumbleSessions(options: ListOptions & TumbleStoreOptions = {}): SessionSummary[] {
	const summaries: SessionSummary[] = []
	const seen = new Set<string>()

	for (const root of taskRootsFor(options.storageRoots)) {
		for (const dir of listDirectories(root)) {
			const summary = summarize(dir)

			if (!summary || seen.has(summary.id)) {
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

			seen.add(summary.id)
			summaries.push(summary)
		}
	}

	summaries.sort((a, b) => b.updatedAt - a.updatedAt)

	return options.limit ? summaries.slice(0, options.limit) : summaries
}

export function findTumbleTaskDir(id: string, storageRoots?: string[]): string | undefined {
	if (!/^[A-Za-z0-9._-]+$/.test(id)) {
		return undefined
	}

	for (const root of taskRootsFor(storageRoots)) {
		const dir = path.join(root, id)

		if (fs.existsSync(dir)) {
			return dir
		}
	}

	return undefined
}

export async function readTumbleSession(
	id: string,
	options: ReadOptions & TumbleStoreOptions = {},
): Promise<Session | undefined> {
	const dir = findTumbleTaskDir(id, options.storageRoots)

	if (!dir) {
		return undefined
	}

	const summary = summarize(dir)

	if (!summary) {
		return undefined
	}

	const history = readJsonFile<ApiMessageFile[]>(path.join(dir, "api_conversation_history.json")) ?? []
	const messages: InterchangeMessage[] = []

	for (const entry of history) {
		const role = entry.role === "assistant" ? "assistant" : entry.role === "user" ? "user" : undefined

		if (!role) {
			continue
		}

		const blocks = normalizeContent(entry.content)

		if (blocks.length === 0) {
			continue
		}

		messages.push({ role, ts: entry.ts, blocks })
	}

	return { ...summary, messageCount: messages.length, messages }
}

function summarize(dir: string): SessionSummary | undefined {
	const id = path.basename(dir)
	const item = readJsonFile<HistoryItemFile>(path.join(dir, "history_item.json"))
	const stat = statOrUndefined(dir)

	if (!item) {
		return summarizeWithoutHistoryItem(dir, id, stat)
	}

	const updatedAt = item.ts ?? stat?.mtimeMs ?? 0

	return {
		agent: "tumble-code",
		id,
		title: oneLine(item.task ?? "", 100) || `Task ${id.slice(0, 8)}`,
		cwd: item.workspace,
		createdAt: stat?.birthtimeMs || updatedAt,
		updatedAt,
		path: dir,
		sizeBytes: item.size,
		mode: item.mode,
		apiConfigName: item.apiConfigName,
		status: item.status,
		parentId: item.parentTaskId,
		childIds: item.childIds,
		resultSummary: item.completionResultSummary,
		tokensIn: item.tokensIn,
		tokensOut: item.tokensOut,
		totalCost: item.totalCost,
	}
}

/**
 * Pre-`history_item.json` tasks: the UI stream still carries the opening
 * request as its first message and the last activity as its last timestamp.
 * The workspace was not recorded back then, so such tasks only surface in
 * unfiltered listings.
 */
function summarizeWithoutHistoryItem(dir: string, id: string, stat: fs.Stats | undefined): SessionSummary | undefined {
	const messages = readJsonFile<UiMessage[]>(path.join(dir, "ui_messages.json"))

	if (!messages || messages.length === 0) {
		return undefined
	}

	const first = messages[0]
	const last = messages[messages.length - 1]

	return {
		agent: "tumble-code",
		id,
		title: oneLine(first?.text ?? "", 100) || `Task ${id.slice(0, 8)}`,
		createdAt: first?.ts ?? stat?.birthtimeMs ?? 0,
		updatedAt: last?.ts ?? stat?.mtimeMs ?? 0,
		path: dir,
	}
}

function readJsonFile<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T
	} catch {
		return undefined
	}
}

function statOrUndefined(target: string): fs.Stats | undefined {
	try {
		return fs.statSync(target)
	} catch {
		return undefined
	}
}
