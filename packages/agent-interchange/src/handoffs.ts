import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import * as path from "node:path"

import { renderBriefing } from "./briefing.js"
import { handoffDir, samePath } from "./locate.js"
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
	now?: () => Date
	randomUUID?: () => string
	syncDirectory?: (directory: string) => Promise<void>
}

interface HandoffUpdateOperation {
	revision: string
	created: string
	status?: HandoffStatus
	pickedUpBy?: AgentKind
	pickedUpSessionId?: string
	note?: string
}

export interface HandoffUpdateResult extends Handoff {
	mutation: {
		revision?: string
		status?: boolean
		pickedUpBy?: boolean
		pickedUpSessionId?: boolean
		note?: "recorded"
	}
}

/**
 * The base document, what it already carries, and how it got there.
 *
 * Every mutable field is a last-writer-wins register: the document records the
 * revision that last set it, so folding is independent of the order operations
 * arrive in. Without that, an operation whose `rename` lands after a compaction
 * — a stalled writer, a skewed clock — would be applied on top of revisions
 * newer than itself and would win by being late.
 *
 * `foldedRevisions` is a membership set rather than a high-water mark for the
 * same reason: it says which log entries the Markdown already carries and which
 * operation files are therefore spent.
 */
interface BaseDocument {
	handoff: Handoff
	foldedRevisions: Set<string>
	registers: FieldRegisters
}

/** Revision that last set each field; `""` when the base document set it. */
interface FieldRegisters {
	status: string
	pickedUpBy: string
	pickedUpSessionId: string
}

interface FoldResult {
	handoff: Handoff
	registers: FieldRegisters
}

const REGISTER_KEYS = ["status", "pickedUpBy", "pickedUpSessionId"] as const

const defaultIo: HandoffIo = { rename: fsPromises.rename, syncDirectory }

/** How many times a read restarts because a compaction replaced the base under it. */
const READ_ATTEMPTS = 3

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
		.filter((handoff) => (filter.cwd ? samePath(handoff.cwd, filter.cwd) : true))
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
): Promise<HandoffUpdateResult | undefined> {
	if (!/^[A-Za-z0-9._-]+$/.test(id)) return undefined
	const file = path.join(handoffDir(), `${id}.md`)
	if (!readBaseHandoffFile(file)) return undefined

	// An update that carries nothing would publish a revision that folds to
	// nothing. A model retrying a call must not grow the journal for free.
	if (!update.status && !update.note && !update.pickedUpBy && !update.pickedUpSessionId) {
		const handoff = readHandoffFile(file)
		return handoff ? { ...handoff, mutation: {} } : undefined
	}

	const created = (io.now?.() ?? new Date()).toISOString()
	const revision = await reserveRevision(file, io.randomUUID?.() ?? randomUUID())
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
	await compact(file, io)

	const current = readHandoffState(file)
	if (!current) return undefined

	return {
		...current.handoff,
		mutation: {
			revision,
			status: update.status === undefined ? undefined : current.registers.status === revision,
			pickedUpBy: update.pickedUpBy === undefined ? undefined : current.registers.pickedUpBy === revision,
			pickedUpSessionId:
				update.pickedUpSessionId === undefined ? undefined : current.registers.pickedUpSessionId === revision,
			note: update.note === undefined ? undefined : "recorded",
		},
	}
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

/**
 * The current state: the base document with every operation it does not yet
 * carry folded on top.
 *
 * A compaction landing between reading the base and listing the journal would
 * otherwise hide operations that the older base does not contain — the base is
 * replaced by `rename`, so a changed identity means "start over".
 */
function readHandoffFile(file: string): Handoff | undefined {
	return readHandoffState(file)?.handoff
}

function readHandoffState(file: string): FoldResult | undefined {
	for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
		const identity = fileIdentity(file)
		const base = readBaseDocument(file)

		if (!base) return undefined

		const operations = readUpdateOperations(file, base.foldedRevisions)

		if (fileIdentity(file) === identity) {
			return foldOperations(base.handoff, operations, base.registers)
		}
	}

	const base = readBaseDocument(file)

	return base
		? foldOperations(base.handoff, readUpdateOperations(file, base.foldedRevisions), base.registers)
		: undefined
}

/** `undefined` when the file is absent; the identity changes on every replacement. */
function fileIdentity(file: string): string | undefined {
	try {
		const stat = fs.statSync(file)
		return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
	} catch {
		return undefined
	}
}

function readBaseDocument(file: string): BaseDocument | undefined {
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

	return {
		handoff: baseHandoff(file, raw, parsed.fields, parsed.body),
		foldedRevisions: new Set(
			(parsed.fields.foldedRevisions ?? "")
				.split(",")
				.map((revision) => revision.trim())
				.filter(Boolean),
		),
		registers: {
			status: parsed.fields.statusRevision ?? "",
			pickedUpBy: parsed.fields.pickedUpByRevision ?? "",
			pickedUpSessionId: parsed.fields.pickedUpSessionIdRevision ?? "",
		},
	}
}

function readBaseHandoffFile(file: string): Handoff | undefined {
	return readBaseDocument(file)?.handoff
}

function baseHandoff(file: string, raw: string, fields: Record<string, string>, body: string): Handoff {
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

function readUpdateOperations(file: string, folded: Set<string> = new Set()): HandoffUpdateOperation[] {
	return operationFileNames(file)
		.map((name) => readUpdateOperation(path.join(updateDir(file), name)))
		.filter((operation): operation is HandoffUpdateOperation => operation !== undefined)
		.filter((operation) => !folded.has(operation.revision))
		.sort((a, b) => compareRevisions(a.revision, b.revision))
}

function operationFileNames(file: string): string[] {
	try {
		return fs.readdirSync(updateDir(file)).filter((name) => name.endsWith(".json"))
	} catch {
		return []
	}
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

function foldOperations(
	base: Handoff,
	operations: HandoffUpdateOperation[],
	baseRegisters: FieldRegisters = emptyRegisters(),
): FoldResult {
	let status = base.status
	let pickedUpBy = base.pickedUpBy
	let pickedUpSessionId = base.pickedUpSessionId
	let updated = base.updated
	let body = base.body
	const registers = { ...baseRegisters }

	for (const operation of operations) {
		// The newest revision to name a field wins, whenever it arrives. Ranking
		// statuses instead would make the document one-way: a task marked done by
		// mistake could never be reopened, and the tool would answer "done" to a
		// caller that asked for "open".
		if (operation.status !== undefined && compareRevisions(operation.revision, registers.status) > 0) {
			status = operation.status
			registers.status = operation.revision
		}

		if (operation.pickedUpBy !== undefined && compareRevisions(operation.revision, registers.pickedUpBy) > 0) {
			pickedUpBy = operation.pickedUpBy
			registers.pickedUpBy = operation.revision
		}

		if (
			operation.pickedUpSessionId !== undefined &&
			compareRevisions(operation.revision, registers.pickedUpSessionId) > 0
		) {
			pickedUpSessionId = operation.pickedUpSessionId
			registers.pickedUpSessionId = operation.revision
		}

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
	return { handoff: { ...meta, markdown, body }, registers }
}

function emptyRegisters(): FieldRegisters {
	return { status: "", pickedUpBy: "", pickedUpSessionId: "" }
}

function updateDir(file: string): string {
	return `${file}.updates`
}

async function reserveRevision(file: string, suffix: string): Promise<string> {
	const directory = updateDir(file)
	await fsPromises.mkdir(directory, { recursive: true })

	for (;;) {
		let counter = 0
		const base = readBaseDocument(file)

		for (const revision of [
			...(base ? Object.values(base.registers) : []),
			...readUpdateOperations(file).map((operation) => operation.revision),
			...revisionClaims(file),
		]) {
			counter = Math.max(counter, revisionCounter(revision))
		}

		const prefix = `v2-${String(counter + 1).padStart(16, "0")}`
		const revision = `${prefix}-${suffix}`
		let claim: fsPromises.FileHandle | undefined
		try {
			// Every contender for this Lamport counter races on the same pathname.
			// The UUID belongs to the operation identity, not the reservation lock.
			claim = await fsPromises.open(path.join(directory, `${prefix}.claim`), "wx", 0o600)
			await claim.sync()
			await claim.close()
			return revision
		} catch (error) {
			await claim?.close().catch(() => undefined)
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		}
	}
}

function revisionClaims(file: string): string[] {
	try {
		return fs
			.readdirSync(updateDir(file))
			.filter((name) => name.endsWith(".claim"))
			.map((name) => name.slice(0, -".claim".length))
	} catch {
		return []
	}
}

function revisionCounter(revision: string): number {
	const match = /^v2-(\d{16})(?:-|$)/.exec(revision)
	return match ? Number(match[1]) : 0
}

function compareRevisions(left: string, right: string): number {
	const leftCounter = revisionCounter(left)
	const rightCounter = revisionCounter(right)

	if (leftCounter !== rightCounter) return leftCounter - rightCounter
	if (leftCounter > 0) return left.localeCompare(right)
	if (right === "") return left === "" ? 0 : 1
	if (left === "") return -1
	return left.localeCompare(right)
}

/**
 * Fold the journal into the base document so the file on disk says what the
 * tools say. Best effort: the journal remains the source of truth, so a failed
 * compaction costs nothing but a stale Markdown file.
 *
 * Operation files deliberately remain immutable and authoritative after a fold.
 * A stale compactor can therefore replace a newer materialized document without
 * losing state: readers reapply every revision that stale base does not claim.
 * Portable filesystems do not offer compare-and-swap rename, and reclaimable
 * pathname locks cannot safely fence a paused process, so deleting revisions
 * here would make crash recovery and multiprocess compaction unsound.
 */
async function compact(file: string, io: HandoffIo): Promise<void> {
	try {
		const base = readBaseDocument(file)

		if (!base) return

		const pending = readUpdateOperations(file, base.foldedRevisions)

		if (pending.length === 0) return

		const folded = foldOperations(base.handoff, pending, base.registers)
		const revisions = new Set([...base.foldedRevisions, ...pending.map((operation) => operation.revision)])

		await atomicWrite(
			file,
			`${serializeFrontmatter(folded.handoff, revisions, folded.registers)}\n${folded.handoff.body}`,
			io,
		)
	} catch {
		// The journal still holds every update; readers fold it either way.
	}
}

/**
 * Frontmatter is written and read by this module alone, so a flat `key: value`
 * subset of YAML is enough — no nesting, no anchors. Values are quoted when
 * they could otherwise be misread.
 */
function serializeFrontmatter(meta: HandoffMeta, foldedRevisions?: Set<string>, registers?: FieldRegisters): string {
	const lines = ["---"]

	for (const key of FRONTMATTER_KEYS) {
		const value = meta[key]

		if (value === undefined || value === "") {
			continue
		}

		lines.push(`${key}: ${quote(String(value))}`)
	}

	// Bookkeeping the fold needs and a reader can ignore: which revisions the
	// prose already carries, and which revision last set each field.
	if (foldedRevisions && foldedRevisions.size > 0) {
		lines.push(`foldedRevisions: ${quote([...foldedRevisions].sort().join(","))}`)
	}

	for (const key of registers ? REGISTER_KEYS : []) {
		if (registers![key]) {
			lines.push(`${key}Revision: ${quote(registers![key])}`)
		}
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
		// The file fsync makes the bytes durable; syncing the containing directory
		// makes the rename durable on Linux filesystems that support it. macOS may
		// accept the directory handle but does not promise Linux-equivalent metadata
		// durability from fsync; Node cannot open directories on Windows. Some
		// filesystems reject directory fsync altogether, so this is best effort.
		await (io.syncDirectory ?? syncDirectory)(path.dirname(file)).catch(() => undefined)
	} finally {
		await handle?.close().catch(() => undefined)
		await fsPromises.rm(temporary, { force: true }).catch(() => undefined)
	}
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: fsPromises.FileHandle | undefined

	try {
		handle = await fsPromises.open(directory, fs.constants.O_RDONLY)
		await handle.sync()
	} finally {
		await handle?.close().catch(() => undefined)
	}
}
