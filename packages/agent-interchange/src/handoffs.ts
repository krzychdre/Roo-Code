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

interface LockMetadata {
	token: string
	pid: number
	createdAt: number
}

interface HeldLock {
	file: string
	token: string
	dev: number
	ino: number
	handle: fsPromises.FileHandle
	heartbeat: NodeJS.Timeout
}

const defaultIo: HandoffIo = { rename: fsPromises.rename }

const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 15_000
const LOCK_RETRY_MIN_MS = 20
const LOCK_RETRY_MAX_MS = 100

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

	await serializeWrite(meta.path, () => withFileLock(meta.path, () => atomicWrite(meta.path, markdown)))

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
	return serializeWrite(file, () =>
		withFileLock(file, async () => {
			const existing = readHandoffFile(file)

			if (!existing) {
				return undefined
			}

			const now = new Date().toISOString()
			const meta: HandoffMeta = {
				...existing,
				status: update.status ?? existing.status,
				pickedUpBy: update.pickedUpBy ?? existing.pickedUpBy,
				pickedUpSessionId: update.pickedUpSessionId ?? existing.pickedUpSessionId,
				updated: now,
			}

			const logEntry = update.note
				? `- ${now} — ${update.note}`
				: update.status
					? `- ${now} — status → ${update.status}`
					: undefined

			const body = logEntry ? appendToLog(existing.body, logEntry) : existing.body
			const markdown = `${serializeFrontmatter(meta)}\n${body}`

			await atomicWrite(meta.path, markdown, io)

			return { ...meta, markdown, body }
		}),
	)
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

const writeQueues = new Map<string, Promise<unknown>>()

function serializeWrite<T>(file: string, operation: () => Promise<T>): Promise<T> {
	const previous = writeQueues.get(file) ?? Promise.resolve()
	const current = previous.catch(() => undefined).then(operation)
	writeQueues.set(file, current)
	return current.finally(() => {
		if (writeQueues.get(file) === current) writeQueues.delete(file)
	})
}

async function withFileLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
	const lock = await acquireFileLock(`${target}.lock`)

	try {
		return await operation()
	} finally {
		await releaseFileLock(lock)
	}
}

async function acquireFileLock(file: string): Promise<HeldLock> {
	await fsPromises.mkdir(path.dirname(file), { recursive: true })
	const deadline = Date.now() + LOCK_WAIT_MS
	let attempt = 0

	while (true) {
		const token = randomUUID()
		let handle: fsPromises.FileHandle | undefined
		let createdStat: fs.Stats | undefined

		try {
			handle = await fsPromises.open(file, "wx", 0o600)
			createdStat = await handle.stat()
			const metadata: LockMetadata = { token, pid: process.pid, createdAt: Date.now() }
			await handle.writeFile(JSON.stringify(metadata), "utf8")
			await handle.sync()

			const heartbeat = setInterval(
				() => {
					const now = new Date()
					void handle?.utimes(now, now).catch(() => undefined)
				},
				Math.max(1_000, Math.floor(LOCK_STALE_MS / 3)),
			)
			heartbeat.unref()

			return { file, token, dev: createdStat.dev, ino: createdStat.ino, handle, heartbeat }
		} catch (error) {
			await handle?.close().catch(() => undefined)

			if (!isAlreadyExists(error)) {
				if (createdStat) {
					await unlinkMatchingInode(file, createdStat.dev, createdStat.ino).catch(() => undefined)
				}
				throw error
			}
		}

		if (await recoverStaleLock(file)) {
			continue
		}

		const remaining = deadline - Date.now()
		if (remaining <= 0) {
			throw new Error(`Timed out waiting ${LOCK_WAIT_MS}ms for handoff lock: ${file}`)
		}

		const backoff = Math.min(LOCK_RETRY_MAX_MS, LOCK_RETRY_MIN_MS * 2 ** Math.min(attempt++, 3))
		await sleep(Math.min(remaining, backoff + Math.floor(Math.random() * LOCK_RETRY_MIN_MS)))
	}
}

async function releaseFileLock(lock: HeldLock): Promise<void> {
	clearInterval(lock.heartbeat)

	try {
		const [stat, metadata] = await Promise.all([fsPromises.lstat(lock.file), readLockMetadata(lock.file)])

		if (stat.dev === lock.dev && stat.ino === lock.ino && metadata?.token === lock.token) {
			await fsPromises.unlink(lock.file)
		}
	} catch (error) {
		if (!isMissing(error)) {
			throw error
		}
	} finally {
		await lock.handle.close().catch(() => undefined)
	}
}

async function unlinkMatchingInode(file: string, dev: number, ino: number): Promise<void> {
	const stat = await fsPromises.lstat(file)
	if (stat.dev === dev && stat.ino === ino) {
		await fsPromises.unlink(file)
	}
}

async function recoverStaleLock(file: string): Promise<boolean> {
	let initialStat: fs.Stats
	let initialMetadata: LockMetadata | undefined

	try {
		;[initialStat, initialMetadata] = await Promise.all([fsPromises.lstat(file), readLockMetadata(file)])
	} catch (error) {
		return isMissing(error)
	}

	const timestamp = Math.max(initialStat.mtimeMs, initialMetadata?.createdAt ?? 0)
	if (Date.now() - timestamp <= LOCK_STALE_MS) {
		return false
	}

	const claim = `${file}.recovery-${process.pid}-${randomUUID()}`

	try {
		await fsPromises.link(file, claim)
		const [lockStat, claimStat, claimMetadata] = await Promise.all([
			fsPromises.lstat(file),
			fsPromises.lstat(claim),
			readLockMetadata(claim),
		])
		const sameLock =
			lockStat.dev === initialStat.dev &&
			lockStat.ino === initialStat.ino &&
			claimStat.dev === initialStat.dev &&
			claimStat.ino === initialStat.ino &&
			claimStat.nlink === 2 &&
			claimMetadata?.token === initialMetadata?.token &&
			Date.now() - Math.max(lockStat.mtimeMs, claimMetadata?.createdAt ?? 0) > LOCK_STALE_MS

		if (!sameLock) {
			return false
		}

		// The hard-link claim pins the validated inode. A replacement cannot occupy
		// the lock path until this exact inode is unlinked, and competing reclaimers
		// observe nlink > 2 and leave it alone.
		await fsPromises.unlink(file)
		return true
	} catch (error) {
		return isMissing(error)
	} finally {
		await fsPromises.rm(claim, { force: true }).catch(() => undefined)
	}
}

async function readLockMetadata(file: string): Promise<LockMetadata | undefined> {
	try {
		const parsed = JSON.parse(await fsPromises.readFile(file, "utf8")) as Partial<LockMetadata>
		return typeof parsed.token === "string" &&
			typeof parsed.pid === "number" &&
			typeof parsed.createdAt === "number"
			? (parsed as LockMetadata)
			: undefined
	} catch {
		return undefined
	}
}

function isAlreadyExists(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "EEXIST"
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT"
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
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
