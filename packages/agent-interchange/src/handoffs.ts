import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import * as path from "node:path"

import { renderBriefing } from "./briefing.js"
import { handoffDir } from "./locate.js"
import { oneLine } from "./normalize.js"
import { AGENT_LABELS, type AgentKind, type Session } from "./types.js"

/**
 * Handoffs: a session frozen into a document the other agent can pick up.
 *
 * They live outside the repository (`$AGENT_INTERCHANGE_DIR`, else
 * `~/.local/share/agent-interchange/handoffs`) so they are never committed by
 * accident and survive branch switches — the same convention the `zoo-port`
 * ledger uses. One markdown file per handoff: YAML-ish frontmatter for the
 * fields tools filter on, prose below for the agent that reads it.
 */

export type HandoffStatus = "open" | "picked-up" | "done" | "abandoned"

export interface HandoffMeta {
	id: string
	title: string
	from: AgentKind
	to: AgentKind
	sourceSessionId: string
	cwd?: string
	gitBranch?: string
	status: HandoffStatus
	created: string
	updated: string
	pickedUpBy?: AgentKind
	pickedUpSessionId?: string
	path: string
}

export interface Handoff extends HandoffMeta {
	/** The whole document, frontmatter included. */
	markdown: string
	/** The document body — briefing plus handoff notes. */
	body: string
}

export interface CreateHandoffOptions {
	session: Session
	to: AgentKind
	/** What the next agent should do. One entry per step. */
	nextSteps?: string[]
	/** Anything the briefing cannot derive: traps, decisions, constraints. */
	notes?: string
}

export interface UpdateHandoffOptions {
	status?: HandoffStatus
	pickedUpBy?: AgentKind
	pickedUpSessionId?: string
	/** Appended to the log with a timestamp. */
	note?: string
}

interface HandoffIo {
	rename(source: string, destination: string): Promise<void>
}

interface HandoffUpdateOperation {
	revision: string
	created: string
	status?: HandoffStatus
	pickedUpBy?: AgentKind
	pickedUpSessionId?: string
	note?: string
}

const defaultIo: HandoffIo = { rename: fsPromises.rename }

const STATUS_ORDER: Record<HandoffStatus, number> = {
	open: 0,
	"picked-up": 1,
	abandoned: 2,
	done: 3,
}

const FRONTMATTER_KEYS: Array<keyof HandoffMeta> = [
	"id",
	"title",
	"from",
	"to",
	"sourceSessionId",
	"cwd",
	"gitBranch",
	"status",
	"created",
	"updated",
	"pickedUpBy",
	"pickedUpSessionId",
]

export async function createHandoff(options: CreateHandoffOptions): Promise<Handoff> {
	const { session, to, nextSteps = [], notes } = options
	const now = new Date().toISOString()
	const id = handoffId(session.agent, to, now)
	const dir = handoffDir()

	const meta: HandoffMeta = {
		id,
		title: oneLine(session.title, 120),
		from: session.agent,
		to,
		sourceSessionId: session.id,
		cwd: session.cwd,
		gitBranch: session.gitBranch,
		status: "open",
		created: now,
		updated: now,
		path: path.join(dir, `${id}.md`),
	}

	const body = [
		renderBriefing(session),
		"",
		"## Handoff",
		"",
		`Handed from ${AGENT_LABELS[session.agent]} to ${AGENT_LABELS[to]}.`,
		"",
		"### Next steps",
		"",
		nextSteps.length > 0
			? nextSteps.map((step) => `- [ ] ${step}`).join("\n")
			: "- [ ] _None recorded — read the briefing and decide._",
		"",
		...(notes ? ["### Notes from the previous agent", "", notes, ""] : []),
		"### Log",
		"",
		`- ${now} — created by ${AGENT_LABELS[session.agent]}`,
		"",
	].join("\n")

	const markdown = `${serializeFrontmatter(meta)}\n${body}`

	await atomicWrite(meta.path, markdown)

	return { ...meta, markdown, body }
}

export function listHandoffs(filter: { cwd?: string; status?: HandoffStatus; to?: AgentKind; limit?: number } = {}) {
	const dir = handoffDir()
	let files: string[]

	try {
		files = fs.readdirSync(dir).filter((name) => name.endsWith(".md"))
	} catch {
		return []
	}

	const handoffs = files
		.map((name) => readHandoffFile(path.join(dir, name)))
		.filter((handoff): handoff is Handoff => handoff !== undefined)
		.filter((handoff) => (filter.cwd ? samePathish(handoff.cwd, filter.cwd) : true))
		.filter((handoff) => (filter.status ? handoff.status === filter.status : true))
		.filter((handoff) => (filter.to ? handoff.to === filter.to : true))
		.sort((a, b) => b.updated.localeCompare(a.updated))

	return filter.limit ? handoffs.slice(0, filter.limit) : handoffs
}

export function readHandoff(id: string): Handoff | undefined {
	if (!/^[A-Za-z0-9._-]+$/.test(id)) {
		return undefined
	}

	return readHandoffFile(path.join(handoffDir(), `${id}.md`))
}

export async function updateHandoff(
	id: string,
	update: UpdateHandoffOptions,
	io: HandoffIo = defaultIo,
): Promise<Handoff | undefined> {
	if (!/^[A-Za-z0-9._-]+$/.test(id)) return undefined
	const file = path.join(handoffDir(), `${id}.md`)
	if (!readBaseHandoffFile(file)) return undefined

	const created = new Date().toISOString()
	const revision = `${created.replace(/[:.]/g, "")}-${randomUUID()}`
	const operation: HandoffUpdateOperation = {
		revision,
		created,
		status: update.status,
		pickedUpBy: update.pickedUpBy,
		pickedUpSessionId: update.pickedUpSessionId,
		note: update.note,
	}
	const operationFile = path.join(updateDir(file), `${revision}.json`)

	await atomicWrite(operationFile, `${JSON.stringify(operation)}\n`, io)

	return readHandoffFile(file)
}

/** One-line-per-handoff listing for tool output. */
export function renderHandoffList(handoffs: Handoff[]): string {
	if (handoffs.length === 0) {
		return "No handoffs."
	}

	const lines = ["| id | from → to | status | updated | title |", "| --- | --- | --- | --- | --- |"]

	for (const handoff of handoffs) {
		lines.push(
			`| \`${handoff.id}\` | ${handoff.from} → ${handoff.to} | ${handoff.status} | ${handoff.updated.slice(0, 16).replace("T", " ")} | ${handoff.title.replace(/\|/g, "\\|")} |`,
		)
	}

	return lines.join("\n")
}

/** Frontmatter-only view, for callers that do not want the whole document. */
export function handoffSummary(handoff: Handoff): string {
	return [`# ${handoff.title}`, "", ...metaSummaryLines(handoff)].join("\n")
}

function metaSummaryLines(handoff: Handoff): string[] {
	return [
		`**Handoff:** \`${handoff.id}\` · ${AGENT_LABELS[handoff.from]} → ${AGENT_LABELS[handoff.to]} · **Status:** ${handoff.status}`,
		`**Source session:** \`${handoff.sourceSessionId}\`${handoff.cwd ? ` · **Workspace:** \`${handoff.cwd}\`` : ""}`,
		`**Created:** ${handoff.created} · **Updated:** ${handoff.updated}`,
	]
}

function readHandoffFile(file: string): Handoff | undefined {
	const base = readBaseHandoffFile(file)
	if (!base) return undefined

	return foldOperations(base, readUpdateOperations(file))
}

function readBaseHandoffFile(file: string): Handoff | undefined {
	let raw: string

	try {
		raw = fs.readFileSync(file, "utf8")
	} catch {
		return undefined
	}

	const parsed = parseFrontmatter(raw)

	if (!parsed) {
		return undefined
	}

	const { fields, body } = parsed
	const id = fields.id ?? path.basename(file, ".md")

	return {
		id,
		title: fields.title ?? id,
		from: asAgent(fields.from) ?? "claude-code",
		to: asAgent(fields.to) ?? "tumble-code",
		sourceSessionId: fields.sourceSessionId ?? "",
		cwd: fields.cwd,
		gitBranch: fields.gitBranch,
		status: asStatus(fields.status),
		created: fields.created ?? "",
		updated: fields.updated ?? fields.created ?? "",
		pickedUpBy: asAgent(fields.pickedUpBy),
		pickedUpSessionId: fields.pickedUpSessionId,
		path: file,
		markdown: raw,
		body,
	}
}

function readUpdateOperations(file: string): HandoffUpdateOperation[] {
	let names: string[]
	try {
		names = fs.readdirSync(updateDir(file)).filter((name) => name.endsWith(".json"))
	} catch {
		return []
	}

	return names
		.map((name) => readUpdateOperation(path.join(updateDir(file), name)))
		.filter((operation): operation is HandoffUpdateOperation => operation !== undefined)
		.sort((a, b) => a.revision.localeCompare(b.revision))
}

function readUpdateOperation(file: string): HandoffUpdateOperation | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HandoffUpdateOperation>
		if (
			typeof parsed.revision !== "string" ||
			typeof parsed.created !== "string" ||
			(parsed.status !== undefined && !isStatus(parsed.status)) ||
			(parsed.pickedUpBy !== undefined && !asAgent(parsed.pickedUpBy)) ||
			(parsed.pickedUpSessionId !== undefined && typeof parsed.pickedUpSessionId !== "string") ||
			(parsed.note !== undefined && typeof parsed.note !== "string")
		) {
			return undefined
		}
		return parsed as HandoffUpdateOperation
	} catch {
		return undefined
	}
}

function foldOperations(base: Handoff, operations: HandoffUpdateOperation[]): Handoff {
	let status = base.status
	let pickedUpBy = base.pickedUpBy
	let pickedUpSessionId = base.pickedUpSessionId
	let updated = base.updated
	let body = base.body

	for (const operation of operations) {
		if (operation.status && STATUS_ORDER[operation.status] > STATUS_ORDER[status]) {
			status = operation.status
		}
		pickedUpBy = operation.pickedUpBy ?? pickedUpBy
		pickedUpSessionId = operation.pickedUpSessionId ?? pickedUpSessionId
		updated = operation.created > updated ? operation.created : updated
		const logEntry = operation.note
			? `- ${operation.created} — ${operation.note}`
			: operation.status
				? `- ${operation.created} — status → ${operation.status}`
				: undefined
		if (logEntry) body = appendToLog(body, logEntry)
	}

	const meta: HandoffMeta = { ...base, status, pickedUpBy, pickedUpSessionId, updated }
	const markdown = `${serializeFrontmatter(meta)}\n${body}`
	return { ...meta, markdown, body }
}

function updateDir(file: string): string {
	return `${file}.updates`
}

/**
 * Frontmatter is written and read by this module alone, so a flat `key: value`
 * subset of YAML is enough — no nesting, no anchors. Values are quoted when
 * they could otherwise be misread.
 */
function serializeFrontmatter(meta: HandoffMeta): string {
	const lines = ["---"]

	for (const key of FRONTMATTER_KEYS) {
		const value = meta[key]

		if (value === undefined || value === "") {
			continue
		}

		lines.push(`${key}: ${quote(String(value))}`)
	}

	lines.push("---")

	return lines.join("\n")
}

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } | undefined {
	if (!raw.startsWith("---")) {
		return undefined
	}

	const end = raw.indexOf("\n---", 3)

	if (end === -1) {
		return undefined
	}

	const header = raw.slice(3, end)
	const body = raw.slice(end + 4).replace(/^\n/, "")
	const fields: Record<string, string> = {}

	for (const line of header.split("\n")) {
		const match = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)

		if (match) {
			fields[match[1]!] = unquote(match[2]!.trim())
		}
	}

	return { fields, body }
}

function appendToLog(body: string, entry: string): string {
	const marker = "### Log"
	const index = body.lastIndexOf(marker)

	if (index === -1) {
		return `${body.trimEnd()}\n\n### Log\n\n${entry}\n`
	}

	return `${body.trimEnd()}\n${entry}\n`
}

function handoffId(from: AgentKind, to: AgentKind, isoTime: string): string {
	const stamp = isoTime.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")
	const shortFrom = from === "claude-code" ? "cc" : "tc"
	const shortTo = to === "claude-code" ? "cc" : "tc"

	return `${stamp}-${shortFrom}2${shortTo}-${randomUUID().slice(0, 4)}`
}

function asAgent(value: string | undefined): AgentKind | undefined {
	return value === "claude-code" || value === "tumble-code" ? value : undefined
}

function asStatus(value: string | undefined): HandoffStatus {
	return value === "picked-up" || value === "done" || value === "abandoned" ? value : "open"
}

function isStatus(value: unknown): value is HandoffStatus {
	return value === "open" || value === "picked-up" || value === "done" || value === "abandoned"
}

function quote(value: string): string {
	return /^[A-Za-z0-9._/-]+$/.test(value) ? value : JSON.stringify(value)
}

function unquote(value: string): string {
	if (value.startsWith('"')) {
		try {
			return JSON.parse(value) as string
		} catch {
			return value
		}
	}

	return value
}

function samePathish(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) {
		return false
	}

	return path.resolve(a) === path.resolve(b)
}

async function atomicWrite(file: string, content: string, io: HandoffIo = defaultIo): Promise<void> {
	await fsPromises.mkdir(path.dirname(file), { recursive: true })
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
	let handle: fsPromises.FileHandle | undefined

	try {
		handle = await fsPromises.open(temporary, "wx", 0o600)
		await handle.writeFile(content, "utf8")
		await handle.sync()
		await handle.close()
		handle = undefined
		await io.rename(temporary, file)
	} finally {
		await handle?.close().catch(() => undefined)
		await fsPromises.rm(temporary, { force: true }).catch(() => undefined)
	}
}
