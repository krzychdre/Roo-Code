/**
 * Execution snapshot for task resumption.
 *
 * Resuming a task replays the conversation: `resumeTaskFromHistory()` reloads the full persisted
 * history and sends it as the first request after the pause. Measured on this workspace's task
 * store, that first request is a median of ~44k tokens and up to 384k, and in 70 of 78 resumes it
 * was LARGER than the last request before the pause — the interruption costs more than the work.
 *
 * This module replaces that replay with a snapshot of the execution *state*: the goal, the plan,
 * what changed, what is still broken, what was proven, and what can be cited. All of it comes
 * from the typed ledger, which is derived mechanically from the same history — so the snapshot
 * needs NO model call and cannot hallucinate. That is the whole reason it is not persisted at
 * checkpoint time: a deterministic function of already-persisted data is cheaper to recompute
 * than to store, and recomputing it cannot go stale, drift out of sync with the history, or need
 * a version migration.
 *
 * What CAN go stale is the workspace: the user may edit files while the task is paused, which
 * makes "already changed" and "tests passed" claims wrong. That is checked directly, per file,
 * against the mtimes of the files the ledger says were changed — a finer-grained binding than a
 * repo-wide hash, which can only say that *something* moved.
 *
 * Applying the snapshot is non-destructive, using the same tagging as condense: older messages
 * get a `condenseParent` and stay on disk, so rewind and the UI transcript are unaffected.
 * Every failure mode degrades to today's behaviour — a full replay — never to lost history.
 */

import * as path from "path"
import * as fsPromises from "fs/promises"
import crypto from "crypto"

import type { ApiMessage } from "../task-persistence/apiMessages"
import { computeCondenseKeepBoundary, getEffectiveApiHistory } from "../condense"
import type { ContextLedger, LedgerFact } from "./ledger/types"
import { buildContextLedger } from "./ledger/buildLedger"

/**
 * Bumped when the rendered shape changes. It is emitted in the snapshot header so a transcript
 * shows which format produced it; nothing is read back, so there is no migration path to own.
 */
export const EXECUTION_SNAPSHOT_VERSION = 1

/**
 * Raw turns kept verbatim after the snapshot. Smaller than the condense tail
 * (`CONDENSE_KEEP_RECENT_MESSAGES = 6`) because a resume already carries the whole state in the
 * snapshot and the tail exists only to anchor an interrupted tool call.
 *
 * This is the floor, not the value: it holds when the snapshot really does carry the state, and is
 * widened when it does not — see `RESUME_THIN_KEEP_RECENT_MESSAGES`.
 */
export const RESUME_KEEP_RECENT_MESSAGES = 4

/**
 * Below this, replaying the history is cheaper than the snapshot is worth. Measured in characters
 * rather than tokens so the gate stays synchronous and free — no tokenizer, no API handler. The
 * value is ~15k tokens at the usual ~4 chars/token, which sits well under the observed 44k median
 * first request after resume, so the expensive resumes are caught and short tasks are untouched.
 */
export const RESUME_SNAPSHOT_MIN_CHARS = 60_000

/**
 * Upper bound on the tail when the ledger is thin — see `isLedgerThin`.
 *
 * A thin ledger means the snapshot can say what was asked and what was read, and nothing about
 * what was done, because nothing the ledger can type was done: the work so far lives in the
 * reading and the reasoning about it. 29% of the resumes in the local store are that shape, and
 * they were dropping a median 111k characters to replace them with a goal and a list of paths.
 * Keeping more raw turns is the only way to carry that state, since the alternative — inventing a
 * prose summary — is the model call this module exists to avoid.
 */
export const RESUME_THIN_KEEP_RECENT_MESSAGES = 16

/**
 * Character ceiling on the widened tail. Deliberately the same number as the gate above: a tail
 * this size is one we would not have bothered compressing in the first place, so it is the natural
 * point at which widening stops paying. It matters because message count is a poor proxy for size
 * on exactly these tasks — a flat 12-message tail measured p90 185k / max 557k, while the budget
 * holds p90 and max at their 4-message values and still lifts the median tail from 26k to 52k.
 */
export const RESUME_THIN_TAIL_MAX_CHARS = RESUME_SNAPSHOT_MIN_CHARS

/**
 * Slack around the task's last activity before an mtime counts as an outside edit. Covers write
 * flushes and clock jitter around our own final tool call; a human editing during a pause takes
 * far longer than this.
 */
export const STALE_MTIME_GRACE_MS = 5_000

/** Upper bound on files stat'ed for the staleness check, matching the ledger's own cap. */
export const MAX_STALE_CHECK_FILES = 40

/** Upper bound on entries rendered per section. Overflow is reported, never silently dropped. */
export const MAX_SNAPSHOT_SECTION_ITEMS = 20

/** A file the ledger says we changed, which then moved underneath us. */
export interface StaleFile {
	/** The path exactly as the ledger recorded it, so it matches the lines above it. */
	path: string
	reason: "modified" | "removed"
}

/** Injectable for tests; defaults to real `fs`. */
export interface StatLike {
	(filePath: string): Promise<{ mtimeMs: number }>
}

/**
 * Finds which of the ledger's changed files were touched outside the task since it last acted.
 *
 * Bias is toward reporting: a missed edit makes the agent confidently wrong about the state of
 * the disk, while a false report only asks it to re-read a file. Unreadable-for-other-reasons is
 * the one case that stays silent — a permissions error says nothing about the content.
 */
export async function detectStaleFileChanges(
	ledger: ContextLedger,
	cwd: string,
	sinceMs: number,
	stat: StatLike = (filePath) => fsPromises.stat(filePath),
): Promise<StaleFile[]> {
	const seen = new Set<string>()
	const subjects: string[] = []
	for (const fact of ledger.fileChanges) {
		if (fact.subject && !seen.has(fact.subject)) {
			seen.add(fact.subject)
			subjects.push(fact.subject)
			if (subjects.length >= MAX_STALE_CHECK_FILES) {
				break
			}
		}
	}

	const threshold = sinceMs + STALE_MTIME_GRACE_MS

	const results = await Promise.all(
		subjects.map(async (subject): Promise<StaleFile | undefined> => {
			try {
				const stats = await stat(path.resolve(cwd, subject))
				return stats.mtimeMs > threshold ? { path: subject, reason: "modified" } : undefined
			} catch (error) {
				const code = (error as NodeJS.ErrnoException)?.code
				if (code === "ENOENT") {
					// A file we created that is now gone is exactly the case where "already
					// changed, do not redo" would send the agent in the wrong direction.
					return { path: subject, reason: "removed" }
				}
				return undefined
			}
		}),
	)

	return results.filter((entry): entry is StaleFile => entry !== undefined)
}

/** One bullet per fact, with the section's overflow reported rather than hidden. */
function renderSection(title: string, note: string, facts: readonly LedgerFact[]): string[] {
	if (facts.length === 0) {
		return []
	}

	const shown = facts.slice(0, MAX_SNAPSHOT_SECTION_ITEMS)
	const lines = [`### ${title}`, note, ...shown.map((fact) => `- ${fact.text}`)]

	const overflow = facts.length - shown.length
	if (overflow > 0) {
		lines.push(`- (${overflow} more, omitted for length)`)
	}
	lines.push("")
	return lines
}

/**
 * Renders the ledger as the snapshot text.
 *
 * Shape is chosen for a weak reader: flat headings, one item per line, no nesting, and an
 * explicit instruction under each heading saying what to do with it. A local Llama that only
 * skims headings still comes away with "do not redo these files" and "this is still broken".
 */
export function renderExecutionSnapshot(ledger: ContextLedger, stale: readonly StaleFile[] = []): string {
	const lines: string[] = [
		`## Execution Snapshot (v${EXECUTION_SNAPSHOT_VERSION})`,
		"",
		"This task was interrupted and has now been resumed. The earlier turns are no longer in context — this snapshot replaces them. Everything below was derived mechanically from the conversation, so it is accurate. Continue the task from here; do not start it over.",
		"",
	]

	if (ledger.goal) {
		lines.push("### Goal", "This is what the user originally asked for. It has not changed.", ledger.goal.text, "")
	}

	lines.push(
		...renderSection(
			"What the user said after that",
			"The user sent these while the task was running, oldest first. They correct or add to the goal above, and the last line is the most recent thing you were told. Follow them.",
			ledger.userInstructions,
		),
	)
	lines.push(...renderSection("Plan", "The current todo list and its state.", ledger.decisions))
	if (ledger.fileChanges.length > 0) {
		lines.push(
			...renderSection(
				"Already changed",
				"These edits are already on disk. Do NOT make them again.",
				ledger.fileChanges,
			),
		)
	} else {
		// Silence here is ambiguous, and the ambiguity runs the wrong way: an agent that assumes the
		// edits landed will move on to the next step and leave the task half-done. Stating the
		// absence costs two lines and is a claim about the record, not about the disk — a shell
		// command can have written a file without any edit tool seeing it.
		lines.push(
			"### Already changed",
			"Nothing. No file edit was recorded before the interruption. If you expected one to exist already, check the file instead of assuming.",
			"",
		)
	}
	lines.push(
		...renderSection(
			"Still broken",
			"These failures had no later success. The task is not finished while they stand.",
			ledger.openErrors,
		),
	)
	lines.push(
		...renderSection(
			"Validation results",
			"The most recent outcome of each check that was run.",
			ledger.validations,
		),
	)
	lines.push(
		...renderSection(
			"Already read",
			"These files were read earlier. Re-read one only if you need its exact contents.",
			ledger.artifacts,
		),
	)

	if (stale.length > 0) {
		lines.push(
			"### Changed outside this task while it was paused",
			"These files no longer match what this task left on disk, so anything above about them may now be wrong. Re-read them before relying on it, and re-run the validations above rather than trusting their results.",
			...stale.map((entry) => `- ${entry.path} (${entry.reason})`),
			"",
		)
	}

	lines.push(
		"If you need a detail that is not in this snapshot, re-read the file or re-run the command rather than guessing.",
	)

	return lines.join("\n")
}

export interface ApplyExecutionSnapshotOptions {
	/** Full persisted history, tags included. */
	messages: ApiMessage[]
	/** Files that moved while the task was paused; rendered as a warning section. */
	stale?: readonly StaleFile[]
	/** Raw turns kept after the snapshot. A floor: a thin ledger is allowed to keep more. */
	keepRecent?: number
	/** Size gate, in characters of effective history. */
	minChars?: number
	/** Ceiling on the widened tail a thin ledger earns, in messages. */
	maxThinKeepRecent?: number
	/** Ceiling on the widened tail a thin ledger earns, in characters. */
	maxThinTailChars?: number
	/**
	 * Pre-built ledger for `messages`. Callers that already needed one — the staleness check needs
	 * its file list — pass it here rather than paying for a second identical build.
	 */
	ledger?: ContextLedger
}

export interface ApplyExecutionSnapshotResult {
	/** The history to persist — unchanged when the snapshot did not apply. */
	messages: ApiMessage[]
	applied: boolean
	/** Messages hidden behind the snapshot (still on disk). */
	hiddenMessages: number
	/** Raw turns kept verbatim after it. Above `keepRecent` when the ledger earned a wider tail. */
	tailMessages: number
	/** Effective-history characters before and after, for the resume-cost metric. */
	charsBefore: number
	charsAfter: number
	/** Why it did not apply, for logging. `undefined` when it did. */
	skipReason?: "too-small" | "no-tail" | "nothing-to-hide" | "no-facts"
}

/** Characters of one message — a free, synchronous proxy for what it will cost to send. */
function messageChars(message: ApiMessage): number {
	return typeof message.content === "string" ? message.content.length : JSON.stringify(message.content ?? "").length
}

/** Characters of an effective history — a free, synchronous proxy for what the request will cost. */
function effectiveChars(messages: ApiMessage[]): number {
	let total = 0
	for (const message of messages) {
		total += messageChars(message)
	}
	return total
}

/**
 * True when the ledger holds no record of work being done — only of what was asked and what was
 * looked at.
 *
 * The four classes checked are the ones that describe an effect: an edit, a failure, a proof, a
 * plan. `goal`, `user_instruction` and `artifact` are deliberately excluded — a goal is always
 * present, and a list of read paths says where the agent has been, not what it concluded there.
 * A snapshot built from those alone is honest but nearly empty, which is why this predicate buys
 * back raw turns rather than tightening the gate: refusing to apply at all would forfeit the
 * saving entirely on a shape that is 29% of all resumes.
 */
export function isLedgerThin(ledger: ContextLedger): boolean {
	return (
		ledger.fileChanges.length === 0 &&
		ledger.openErrors.length === 0 &&
		ledger.validations.length === 0 &&
		ledger.decisions.length === 0
	)
}

/**
 * Grows the kept tail as far as the character budget allows, starting from `keepRecent`.
 *
 * Each candidate goes through `computeCondenseKeepBoundary`, so every tail considered is one that
 * does not split a tool pair. A larger `keepRecent` can come back *worse* — the boundary is held
 * in place by pair snapping, or the whole tail gate trips and it returns `messages.length` — and
 * neither is a reason to stop, so those candidates are skipped rather than accepted or broken on.
 * The budget is checked against the tail the candidate would actually keep, which is what makes
 * this safe on read-heavy histories where one message can be 200k characters on its own.
 */
function widenTail(messages: ApiMessage[], keepRecent: number, maxKeepRecent: number, maxTailChars: number): number {
	let boundary = computeCondenseKeepBoundary(messages, keepRecent)
	if (boundary <= 0 || boundary >= messages.length) {
		return boundary
	}

	const sizes = new Map<number, number>()
	const sizeOf = (index: number): number => {
		let size = sizes.get(index)
		if (size === undefined) {
			size = messageChars(messages[index])
			sizes.set(index, size)
		}
		return size
	}

	let tailChars = 0
	for (let i = boundary; i < messages.length; i++) {
		tailChars += sizeOf(i)
	}

	for (let keep = keepRecent + 1; keep <= maxKeepRecent; keep++) {
		const candidate = computeCondenseKeepBoundary(messages, keep)
		if (candidate <= 0 || candidate >= boundary) {
			continue
		}
		let grown = tailChars
		for (let i = candidate; i < boundary; i++) {
			grown += sizeOf(i)
		}
		if (grown > maxTailChars) {
			break
		}
		boundary = candidate
		tailChars = grown
	}

	return boundary
}

/**
 * Rewrites the history so a resume starts from the snapshot instead of the full replay.
 *
 * Returns the input untouched whenever the snapshot would not clearly help or could not be
 * anchored safely. The caller does not need to handle those cases: an unapplied result is
 * exactly today's behaviour.
 */
export function applyExecutionSnapshot(options: ApplyExecutionSnapshotOptions): ApplyExecutionSnapshotResult {
	const {
		messages,
		stale = [],
		keepRecent = RESUME_KEEP_RECENT_MESSAGES,
		minChars = RESUME_SNAPSHOT_MIN_CHARS,
		maxThinKeepRecent = RESUME_THIN_KEEP_RECENT_MESSAGES,
		maxThinTailChars = RESUME_THIN_TAIL_MAX_CHARS,
	} = options

	const effective = getEffectiveApiHistory(messages)
	const charsBefore = effectiveChars(effective)
	const unchanged = (skipReason: ApplyExecutionSnapshotResult["skipReason"]): ApplyExecutionSnapshotResult => ({
		messages,
		applied: false,
		hiddenMessages: 0,
		tailMessages: messages.length,
		charsBefore,
		charsAfter: charsBefore,
		skipReason,
	})

	if (charsBefore < minChars) {
		return unchanged("too-small")
	}

	const ledger = options.ledger ?? buildContextLedger(messages)
	if (!ledger.goal && ledger.facts.length === 0) {
		// Nothing worth carrying over: hiding the history would be a pure loss.
		return unchanged("no-facts")
	}

	// Reuse the condense boundary: it is the logic that guarantees the kept tail never splits a
	// tool_use/tool_result pair. How much it keeps depends on how much of the state the snapshot
	// actually managed to type — a ledger with no record of work has to lean on the raw turns.
	const boundary = isLedgerThin(ledger)
		? widenTail(messages, keepRecent, Math.max(keepRecent, maxThinKeepRecent), maxThinTailChars)
		: computeCondenseKeepBoundary(messages, keepRecent)

	// `messages.length` means "no tail", which for a resume would leave an interrupted tool call
	// with no `tool_use` to answer — so that case is a skip, not a more aggressive compression.
	if (boundary >= messages.length) {
		return unchanged("no-tail")
	}
	if (boundary <= 0) {
		return unchanged("nothing-to-hide")
	}

	const snapshotId = crypto.randomUUID()
	const lastTs = messages[messages.length - 1]?.ts ?? Date.now()

	const snapshotMessage: ApiMessage = {
		role: "user",
		content: [{ type: "text", text: renderExecutionSnapshot(ledger, stale) }],
		ts: lastTs + 1,
		isSummary: true,
		condenseId: snapshotId,
	}

	const rewritten: ApiMessage[] = []
	for (let i = 0; i < boundary; i++) {
		const message = messages[i]
		// Already-hidden messages keep their original parent; nested hiding is handled by filtering.
		rewritten.push(message.condenseParent ? message : { ...message, condenseParent: snapshotId })
	}
	rewritten.push(snapshotMessage)
	for (let i = boundary; i < messages.length; i++) {
		rewritten.push(messages[i])
	}

	return {
		messages: rewritten,
		applied: true,
		hiddenMessages: boundary,
		tailMessages: messages.length - boundary,
		charsBefore,
		charsAfter: effectiveChars(getEffectiveApiHistory(rewritten)),
	}
}
