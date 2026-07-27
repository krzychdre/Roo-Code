/**
 * Critical-fact validation for condense output.
 *
 * A condense summary is written by an LLM — often a small, cheap background model — and there
 * is no guarantee it kept the handful of facts that cannot be re-derived: what the user asked
 * for, what is still broken, and what has already been changed on disk. Losing any of those
 * makes the post-condense agent confidently wrong: it re-implements finished work, or reports
 * success over an unresolved failure.
 *
 * This module checks the summary against the typed state ledger and, for anything the summary
 * dropped, appends a deterministic addendum. It NEVER retries the model and NEVER fails the
 * condense: a weak model that writes a poor summary still ends up with a correct one, at zero
 * extra model calls. That property is the whole point — the check has to work on GLM/Qwen/local
 * Llama output, which is exactly where it is most likely to be needed.
 *
 * Matching is deliberately lexical (token overlap), not semantic: a semantic check would need a
 * model call, which would reintroduce the failure mode it is meant to guard against.
 */

import type { ContextLedger, LedgerFact, LedgerFactClass } from "../context-management/ledger/types"
import { CRITICAL_FACT_CLASSES } from "../context-management/ledger/types"

/** Shortest token that can distinguish one fact from another; below this it is noise. */
const MIN_TOKEN_LENGTH = 4

/**
 * Share of a fact's distinctive tokens that must appear in the summary for the fact to count as
 * retained. Half is deliberate: it tolerates paraphrase and word-form drift ("failed"/"failing")
 * while still rejecting a summary that merely name-drops the file without carrying the fact —
 * mentioning a path is 1 token out of the ~6 an error probe carries.
 */
export const FACT_COVERAGE_THRESHOLD = 0.5

/** Upper bound on probe size, so one enormous fact cannot dominate the check. */
const MAX_PROBE_TOKENS = 12

/** Upper bound on addendum entries. Anything past this is reported, never silently dropped. */
export const MAX_ADDENDUM_FACTS = 20

/**
 * Words that appear in almost every summary, so their presence proves nothing. Kept short on
 * purpose: a long stopword list is a tuning surface that would need its own evidence.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
	"about",
	"after",
	"also",
	"been",
	"before",
	"being",
	"between",
	"both",
	"code",
	"could",
	"does",
	"done",
	"file",
	"files",
	"from",
	"have",
	"into",
	"just",
	"more",
	"most",
	"must",
	"need",
	"only",
	"other",
	"over",
	"same",
	"should",
	"some",
	"such",
	"than",
	"that",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"this",
	"those",
	"through",
	"user",
	"using",
	"very",
	"were",
	"what",
	"when",
	"where",
	"which",
	"while",
	"will",
	"with",
	"would",
	"your",
])

/** Human labels for the addendum. Explicit nouns beat class slugs for a weak reader. */
const FACT_LABELS: Record<LedgerFactClass, string> = {
	goal: "GOAL",
	decision: "PLAN",
	file_change: "ALREADY CHANGED",
	open_error: "STILL BROKEN",
	validation: "VALIDATION",
	artifact: "READ",
}

/** Splits on anything that is not a letter or digit, so `src/a-b.ts` yields `src a b ts`. */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
}

/** Lowercased, deduped, stopword-free tokens long enough to identify something. */
function distinctiveTokens(text: string): string[] {
	const seen = new Set<string>()
	for (const token of tokenize(text)) {
		if (token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token)) {
			seen.add(token)
		}
	}
	return [...seen]
}

/** True for something that looks like a path rather than prose. */
function isPathLike(subject: string): boolean {
	return !/\s/.test(subject) && /[/\\]/.test(subject)
}

/**
 * A path's directory prefix is noise a summary is entitled to drop — `microcompact.ts` is a
 * perfectly good reference to `src/core/context-management/microcompact.ts`. Reducing to the
 * file name keeps the probe on the part that actually identifies the file.
 */
function fileNameOf(subject: string): string {
	const parts = subject.split(/[/\\]/)
	return parts[parts.length - 1] || subject
}

/**
 * The tokens whose survival decides whether a fact survived.
 *
 * The probe text differs by class so that one uniform coverage rule produces the right strictness
 * everywhere:
 *  - `goal` probes the request itself — 50% overlap answers "is the summary about this task".
 *  - `file_change` probes only the file name — one token, so it must be present.
 *  - `open_error` probes the file/command AND the failure text, so a summary that mentions the
 *    file but drops the failure falls under the threshold and gets the fact restored.
 */
export function factProbeTokens(fact: LedgerFact): string[] {
	if (fact.class === "file_change") {
		return distinctiveTokens(fact.subject ? fileNameOf(fact.subject) : fact.text).slice(0, MAX_PROBE_TOKENS)
	}

	if (fact.subject && isPathLike(fact.subject)) {
		// Replace every occurrence of the full path with its file name so the directory
		// segments do not pad the probe with tokens a summary would never repeat.
		const reduced = fact.text.split(fact.subject).join(fileNameOf(fact.subject))
		return distinctiveTokens(reduced).slice(0, MAX_PROBE_TOKENS)
	}

	return distinctiveTokens(fact.text).slice(0, MAX_PROBE_TOKENS)
}

export interface FactCoverage {
	fact: LedgerFact
	/** Share of the fact's probe tokens present in the summary, in [0, 1]. */
	coverage: number
}

export interface FactValidationResult {
	/** Facts that were checked (critical classes only). */
	checked: number
	/** Facts whose coverage fell below the threshold, in addendum order. */
	missing: FactCoverage[]
	/** Ready-to-append reminder block; `""` when nothing is missing. */
	addendum: string
}

const EMPTY_RESULT: FactValidationResult = { checked: 0, missing: [], addendum: "" }

/**
 * What survives the condense verbatim: the raw tail kept after the summary. A fact still present
 * there was never at risk, so restating it in the addendum would spend tokens on nothing.
 */
export interface RetainedContext {
	/** Text of the retained tail. */
	text?: string
	/**
	 * `tool_use` ids whose results survive in the tail.
	 *
	 * This is exact evidence, and it is why the tail's *text* is not folded into the lexical
	 * haystack for tool-derived facts: a file-change probe is a single token (the file name), so
	 * comparing it against a large raw tail suppresses the fact whenever anything in the tail
	 * happens to mention the file — including a message about something else entirely. An id
	 * either survives or it does not.
	 */
	toolUseIds?: ReadonlySet<string>
}

/**
 * Orders the addendum by how expensive the fact is to lose: the task statement first, then
 * unresolved failures (a wrong conclusion), then completed changes (duplicated work).
 */
const CLASS_ORDER: LedgerFactClass[] = ["goal", "open_error", "file_change", "validation", "decision", "artifact"]

/**
 * Checks a condense summary against the ledger's critical facts.
 *
 * @param summary the summary text the model produced
 * @param ledger the deterministic ledger for the history being condensed
 * @param retained what survives the condense verbatim; see {@link RetainedContext}
 */
export function validateSummaryFacts(
	summary: string,
	ledger: ContextLedger | undefined,
	retained: RetainedContext = {},
): FactValidationResult {
	if (!ledger) {
		return EMPTY_RESULT
	}

	// Tool-derived facts are settled by id, so only the summary is searched for them; facts with
	// no id of their own (the goal, plan items) fall back to the text of everything that survives.
	const summaryHaystack = new Set(tokenize(summary))
	const textHaystack = retained.text ? new Set(tokenize(`${summary}\n${retained.text}`)) : summaryHaystack

	const critical = ledger.facts.filter((fact) => CRITICAL_FACT_CLASSES.has(fact.class))
	const missing: FactCoverage[] = []

	for (const fact of critical) {
		if (fact.toolUseId && retained.toolUseIds?.has(fact.toolUseId)) {
			// The result this fact was derived from is still in the conversation, in full.
			continue
		}

		const haystack = fact.toolUseId ? summaryHaystack : textHaystack
		const probe = factProbeTokens(fact)
		if (probe.length === 0) {
			// Nothing distinctive to look for — the fact carries no evidence it was lost, and
			// guessing would only produce noise. Bias is always toward NOT flagging on unknowns.
			continue
		}
		const hits = probe.reduce((count, token) => (haystack.has(token) ? count + 1 : count), 0)
		const coverage = hits / probe.length
		if (coverage < FACT_COVERAGE_THRESHOLD) {
			missing.push({ fact, coverage })
		}
	}

	missing.sort((a, b) => CLASS_ORDER.indexOf(a.fact.class) - CLASS_ORDER.indexOf(b.fact.class))

	return { checked: critical.length, missing, addendum: buildFactAddendum(missing) }
}

/**
 * Renders the missing facts as a system-reminder block.
 *
 * Shape is chosen for a weak reader: one heading, one instruction sentence, one fact per line,
 * each line prefixed with an explicit label. No nesting, no prose the model has to parse.
 */
export function buildFactAddendum(missing: readonly FactCoverage[]): string {
	if (missing.length === 0) {
		return ""
	}

	const shown = missing.slice(0, MAX_ADDENDUM_FACTS)
	const lines = shown.map(({ fact }) => `- ${FACT_LABELS[fact.class]}: ${fact.text}`)

	const overflow = missing.length - shown.length
	if (overflow > 0) {
		// Never truncate silently: a hidden cap reads as "everything was carried over".
		lines.push(`- (${overflow} further fact${overflow === 1 ? "" : "s"} omitted for length)`)
	}

	return `<system-reminder>
## Facts Carried Over From The Condensed History
The summary above did not mention the following. They are still true — treat them as part of the summary and do not redo or contradict them.

${lines.join("\n")}
</system-reminder>`
}
