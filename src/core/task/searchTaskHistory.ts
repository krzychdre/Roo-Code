import * as fs from "fs/promises"
import * as path from "path"

import type { Anthropic } from "@anthropic-ai/sdk"

import { ARTIFACT_DIRECTORIES, isValidArtifactId } from "../artifacts/ArtifactStore"
import type { ApiMessage } from "../task-persistence/apiMessages"

/**
 * Search over a task's OWN stored history.
 *
 * ## Why this exists
 *
 * A long task loses its early turns twice over:
 *
 * 1. Condense replaces the older prefix with a summary. That pass is
 *    non-destructive on disk (`src/core/condense/index.ts` tags the prefix with
 *    `condenseParent` and keeps every message), so text the model can no longer
 *    see after a condense is still in `api_conversation_history.json` verbatim.
 * 2. The deterministic pruner (`src/core/condense/toolResultPruner.ts`) and the
 *    tool-result spill policy (`src/core/artifacts/spillPolicy.ts`) MOVE text
 *    out of the messages and write the replacement back to the same persisted
 *    file, so the middle of a pruned tool result exists ONLY in its
 *    `artifacts/prune-*.txt`.
 *
 * The corpus therefore has to be BOTH. Searching one without the other would
 * leave a hole exactly where the model is most likely to be missing something.
 *
 * ## Purity
 *
 * Everything except {@link readTaskArtifacts} is pure: sources go in, a
 * formatted string comes out. The tool wires the two halves together, and the
 * unit tests exercise the search without touching the extension host.
 */

/** Tunables of the history search, in one place so the tests and the tool agree. */
export const HISTORY_SEARCH_DEFAULTS = {
	/** Hits returned when the model does not ask for a number. */
	DEFAULT_MAX_RESULTS: 10,
	/** Hard cap, whatever the model asks for. */
	MAX_MAX_RESULTS: 50,
	/** Lines of context kept on each side of a matching line. */
	CONTEXT_LINES: 2,
	/** Byte cap for one formatted hit block (context included). */
	MAX_HIT_BYTES: 800,
	/** Character cap for a single line inside a hit block. */
	MAX_LINE_CHARS: 400,
	/**
	 * Characters of a line the pattern is actually tested against.
	 *
	 * Backtracking cost grows with the length of the text, so an unbounded line
	 * (a 10 MB single-line JSON blob is a normal artifact) turns a merely slow
	 * pattern into a frozen extension host. The cap is far above any line a
	 * human wrote and is stated in the tool description.
	 */
	MAX_TESTED_LINE_CHARS: 2_000,
	/**
	 * Wall-clock budget for the whole scan, in milliseconds.
	 *
	 * A JavaScript regular expression cannot be interrupted once `test` is
	 * running, so this is checked BETWEEN lines. It bounds the aggregate, while
	 * {@link isCatastrophicPattern} bounds the single worst line by refusing the
	 * shape that makes one line take exponential time.
	 */
	MAX_SEARCH_MILLIS: 2_000,
	/** How many lines are scanned between two clock checks. */
	BUDGET_CHECK_INTERVAL: 256,
	/**
	 * Hard cap on collected matches.
	 *
	 * The clock only bounds the scan; sorting and deduplicating the matches runs
	 * after it, and its cost grows with the match count (measured: ~4 s extra on
	 * two million matches, reported as within budget). Above this cap the query
	 * is too broad to produce a useful answer anyway, so the scan stops and the
	 * call is reported exactly like a budget breach: same outcome, same advice.
	 */
	MAX_COLLECTED_MATCHES: 10_000,
	/** Bytes read from any single artifact file. */
	MAX_ARTIFACT_SCAN_BYTES: 2 * 1024 * 1024,
	/** Bytes read from all artifact files of a task, together. */
	MAX_TOTAL_ARTIFACT_SCAN_BYTES: 16 * 1024 * 1024,
} as const

/** Marker that opens every result this tool produces. */
export const SEARCH_TASK_HISTORY_RESULT_MARKER = "[search_task_history]"

/**
 * Names under which this tool can appear in a stored `tool_use` block.
 *
 * `TaskStreamProcessor` records the name the model used, so an alias would land
 * here verbatim; there is no alias today, and the set is the place to add one.
 */
const SEARCH_TASK_HISTORY_TOOL_NAMES: ReadonlySet<string> = new Set(["search_task_history"])

/** Marker put in front of a truncated line or block. */
const TRUNCATION_SUFFIX = " ...[truncated]"

/** How the query was interpreted. */
export type HistoryQueryMode =
	/** Compiled and used as a regular expression. */
	| "regex"
	/** Did not compile, so it was searched for as plain text. */
	| "literal"
	/** Compiled, but its shape can backtrack exponentially, so it was searched for as plain text. */
	| "unsafe"

/**
 * One searchable unit of the corpus: a stored message, or an artifact file.
 *
 * `timestamp` and `order` are the chronological sort key. Both a message `ts`
 * and an artifact id carry epoch milliseconds, so the two kinds interleave
 * correctly without any extra bookkeeping.
 */
export interface HistorySearchSource {
	/** Human-readable origin, printed above every hit from this source. */
	label: string
	/** The searchable text, already flattened out of content blocks. */
	text: string
	/** Epoch milliseconds used to order hits across sources. */
	timestamp: number
	/** Tie-break inside one timestamp (message index, or artifact position). */
	order: number
}

/** One formatted hit, ready to print. */
export interface HistorySearchHit {
	/** The source label, e.g. `message 12 (user) at 2026-08-24T09:15:00.000Z`. */
	label: string
	/** 1-indexed line number of the matching line inside its source. */
	lineNumber: number
	/** The matching line plus its context, line-numbered and truncated. */
	block: string
}

/** Everything the formatter needs to explain what happened. */
export interface HistorySearchOutcome {
	/** The hits that survived the cap, oldest first. */
	hits: HistorySearchHit[]
	/** Matching lines found, before duplicate copies were removed. */
	totalMatches: number
	/** Matching lines left after duplicate copies were removed. */
	distinctMatches: number
	/** Distinct matches dropped by the cap. */
	omitted: number
	/** How the query was interpreted. */
	mode: HistoryQueryMode
	/** True when the scan hit its wall-clock budget and stopped early. */
	timedOut: boolean
	/** Messages searched. */
	messageCount: number
	/** Artifact files searched. */
	artifactCount: number
}

/** An artifact file loaded for searching. */
export interface TaskArtifactText {
	/** File name, e.g. `prune-1706119234567.txt`, quotable to `read_artifact`. */
	id: string
	/** Text content (possibly cut at the scan cap). */
	text: string
	/** True when only the first bytes of the file were read. */
	truncated?: boolean
}

/** Regular-expression flags accepted in the `/pattern/flags` form. */
const ALLOWED_SLASH_FLAGS = "imsu"

/**
 * Compiles the query the way the tool description promises.
 *
 * Three outcomes, in order:
 *
 * 1. `/pattern/flags` is unwrapped first. Weak models write a slash-delimited
 *    literal far more often than they read the parameter description, and
 *    treating the slashes as content makes such a call silently find nothing.
 * 2. A pattern whose shape can backtrack exponentially (a quantified group that
 *    itself contains an unbounded quantifier, the classic `(a+)+b`) is REFUSED
 *    as a regular expression and searched for literally. There is no way to
 *    interrupt a running `RegExp.test`, so the only safe move is not to start
 *    one; the wall-clock budget in {@link searchHistorySources} is the second
 *    line of defence, not the first.
 * 3. Anything that does not compile is escaped and searched for literally, so a
 *    stray bracket costs no turn.
 *
 * The search is always case-insensitive.
 */
export function compileHistoryQuery(query: string): { regex: RegExp; usedRegex: boolean; mode: HistoryQueryMode } {
	const slashForm = parseSlashDelimited(query)
	const source = slashForm?.pattern ?? query
	const flags = slashForm?.flags ?? "i"

	if (isCatastrophicPattern(source)) {
		return { regex: new RegExp(escapeRegExp(query), "i"), usedRegex: false, mode: "unsafe" }
	}

	try {
		return { regex: new RegExp(source, flags), usedRegex: true, mode: "regex" }
	} catch {
		return { regex: new RegExp(escapeRegExp(query), "i"), usedRegex: false, mode: "literal" }
	}
}

/**
 * Recognises `/pattern/flags` and returns its parts.
 *
 * Only `i`, `m`, `s` and `u` are accepted as flags: `g` and `y` make
 * `RegExp.test` stateful through `lastIndex`, which would make the same pattern
 * match every other line. `i` is always added, because the tool promises a
 * case-insensitive search whatever the model wrote.
 */
function parseSlashDelimited(query: string): { pattern: string; flags: string } | undefined {
	if (query.length < 3 || !query.startsWith("/")) {
		return undefined
	}

	const closing = query.lastIndexOf("/")
	if (closing <= 0) {
		return undefined
	}

	const pattern = query.slice(1, closing)
	const rawFlags = query.slice(closing + 1)

	if (pattern.length === 0) {
		return undefined
	}

	if (![...rawFlags].every((flag) => ALLOWED_SLASH_FLAGS.includes(flag))) {
		return undefined
	}

	const flags = ["i", ...new Set(rawFlags)].filter((flag, index, all) => all.indexOf(flag) === index).join("")

	return { pattern, flags }
}

/**
 * True when the pattern contains a quantified group whose body already carries
 * an unbounded quantifier, which is the shape that backtracks exponentially.
 *
 * Deliberately syntactic and conservative: it walks the pattern once, tracking
 * escapes and character classes, and only reports the nesting it can actually
 * see. `(foo|bar)+` is fine; `(a+)+`, `(a*)*`, `(?:\d+)*` and `(x|y+)*` are not.
 *
 * Two deliberate over-approximations, both paid for with a literal fallback
 * rather than an error:
 *
 * - A body's quantifier survives group nesting even when the inner group is
 *   itself unquantified, so `((a+))+` is refused like `(a+)+`. This also
 *   refuses safe shapes such as `((a+)b)+`.
 * - `?` in a body counts as a quantifier, because a nullable body under an
 *   unbounded group quantifier (`(a?)+`, `(?:\d?)*`) is the classic blow-up.
 *   The `?` that is group syntax (`(?:`, `(?=`, `(?!`, `(?<`) does not count,
 *   so `(?:foo)+` stays a live regex.
 */
function isCatastrophicPattern(pattern: string): boolean {
	/** For each open group, whether its body carries an unbounded quantifier. */
	const groupBodyQuantified: boolean[] = []
	let inCharClass = false
	let escaped = false
	/** True when the previous character was an unescaped `(`. */
	let afterGroupOpen = false

	const markCurrentGroup = () => {
		if (groupBodyQuantified.length > 0) {
			groupBodyQuantified[groupBodyQuantified.length - 1] = true
		}
	}

	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i]
		const wasAfterGroupOpen = afterGroupOpen
		afterGroupOpen = false

		if (escaped) {
			escaped = false
			continue
		}

		if (char === "\\") {
			escaped = true
			continue
		}

		if (inCharClass) {
			if (char === "]") {
				inCharClass = false
			}
			continue
		}

		switch (char) {
			case "[":
				inCharClass = true
				break
			case "(":
				groupBodyQuantified.push(false)
				afterGroupOpen = true
				break
			case ")": {
				const bodyQuantified = groupBodyQuantified.pop() ?? false
				const quantified = isUnboundedQuantifierAt(pattern, i + 1)

				if (bodyQuantified && quantified) {
					return true
				}
				if (bodyQuantified || quantified) {
					// A quantified group is itself an unbounded quantifier as far
					// as any enclosing group is concerned, and a quantifier in the
					// body survives the nesting: `((a+))` still carries the `+`,
					// so `((a+))+` must be refused like `(a+)+`.
					markCurrentGroup()
				}
				break
			}
			case "*":
			case "+":
				markCurrentGroup()
				break
			case "?":
				// A nullable body under an unbounded group quantifier ((a?)+) is
				// the classic exponential shape. `?` right after an unescaped `(`
				// is group syntax ((?:, (?=, (?!, (?<), not a quantifier.
				if (!wasAfterGroupOpen) {
					markCurrentGroup()
				}
				break
			case "{":
				if (isUnboundedQuantifierAt(pattern, i)) {
					markCurrentGroup()
				}
				break
			default:
				break
		}
	}

	return false
}

/** True when position `index` starts `*`, `+` or an open-ended `{n,}`. */
function isUnboundedQuantifierAt(pattern: string, index: number): boolean {
	const char = pattern[index]

	if (char === "*" || char === "+") {
		return true
	}

	if (char !== "{") {
		return false
	}

	const close = pattern.indexOf("}", index)
	if (close < 0) {
		return false
	}

	// `{n,}` is unbounded; `{n}` and `{n,m}` are not.
	return /^\d+,$/.test(pattern.slice(index + 1, close))
}

/** Escapes every regex metacharacter so a string matches itself. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Flattens one stored message into searchable text.
 *
 * Tool calls are included as `[tool_use <name>] <json>` because the arguments
 * are frequently the thing worth recovering (the path that was read, the exact
 * command that was run). Tool results are included as their text. Images and
 * other binary blocks contribute nothing and are skipped.
 *
 * ## The self-echo carve-out
 *
 * Two block kinds are dropped on purpose, and the tool is unusable without it:
 *
 * - a `tool_use` block calling THIS tool. The assistant turn is persisted
 *   BEFORE its tools run (`TaskApiLoop.finalizeStreamAndProcessResults` calls
 *   `assembleAndSaveAssistantMessage` first), and the block carries the
 *   arguments verbatim, so the query would always find its own invocation as
 *   the newest match. Every search would report at least one hit, the zero-hit
 *   corrective path would be unreachable, and `max_results: 1` would return
 *   nothing but the echo.
 * - a `tool_result` block holding an earlier result of THIS tool. Those results
 *   quote the query and the matched lines, so by the fourth round a repeated
 *   search finds mostly its own past output and the real hit falls off the end
 *   of the cap.
 */
export function extractMessageText(message: ApiMessage): string {
	const parts: string[] = []
	const content = message.content as Anthropic.MessageParam["content"]

	if (typeof content === "string") {
		parts.push(content)
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (isSelfEchoBlock(block)) {
				continue
			}
			parts.push(extractBlockText(block))
		}
	}

	// Reasoning items store their text outside `content`.
	if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
		parts.push(message.reasoning_content)
	}
	if (typeof message.text === "string" && message.text.length > 0) {
		parts.push(message.text)
	}

	return parts.filter((part) => part.length > 0).join("\n")
}

/** True for a call to this tool, or for a result this tool produced. */
function isSelfEchoBlock(block: unknown): boolean {
	if (!block || typeof block !== "object") {
		return false
	}

	const typed = block as Record<string, any>

	if (typed.type === "tool_use") {
		return typeof typed.name === "string" && SEARCH_TASK_HISTORY_TOOL_NAMES.has(typed.name)
	}

	if (typed.type === "tool_result") {
		return isSearchResultText(extractBlockText(block))
	}

	return false
}

/** True when text is (the start of) a result this tool wrote. */
export function isSearchResultText(text: string): boolean {
	return text.trimStart().startsWith(SEARCH_TASK_HISTORY_RESULT_MARKER)
}

/** Flattens a single content block; returns "" for blocks with no text. */
function extractBlockText(block: unknown): string {
	if (typeof block === "string") {
		return block
	}

	if (!block || typeof block !== "object") {
		return ""
	}

	const typed = block as Record<string, any>

	switch (typed.type) {
		case "text":
			return typeof typed.text === "string" ? typed.text : ""
		case "thinking":
			return typeof typed.thinking === "string" ? typed.thinking : ""
		case "tool_use": {
			const name = typeof typed.name === "string" ? typed.name : "tool"
			let args = ""
			try {
				args = JSON.stringify(typed.input ?? {})
			} catch {
				args = "{}"
			}
			return `[tool_use ${name}] ${args}`
		}
		case "tool_result": {
			const inner = typed.content
			if (typeof inner === "string") {
				return inner
			}
			if (Array.isArray(inner)) {
				return inner
					.map((entry) => extractBlockText(entry))
					.filter((entry) => entry.length > 0)
					.join("\n")
			}
			return ""
		}
		default:
			return typeof typed.text === "string" ? typed.text : ""
	}
}

/**
 * Turns stored messages into search sources.
 *
 * Messages without a `ts` inherit the last timestamp seen, so a history that
 * predates timestamping still sorts in file order instead of collapsing to 0.
 */
export function messageSearchSources(messages: ApiMessage[]): HistorySearchSource[] {
	const sources: HistorySearchSource[] = []
	let lastTimestamp = 0

	messages.forEach((message, index) => {
		const text = extractMessageText(message)
		if (typeof message.ts === "number" && Number.isFinite(message.ts)) {
			lastTimestamp = message.ts
		}

		if (text.length === 0) {
			return
		}

		const when = typeof message.ts === "number" && Number.isFinite(message.ts) ? formatTimestamp(message.ts) : ""
		const role = message.role ?? "unknown"

		sources.push({
			label: `message ${index} (${role})${when ? ` at ${when}` : ""}`,
			text,
			timestamp: lastTimestamp,
			order: index,
		})
	})

	return sources
}

/**
 * Turns artifact files into search sources.
 *
 * The epoch milliseconds in the id are the artifact's timestamp, which is what
 * puts a pruned result back in its chronological place among the messages.
 */
export function artifactSearchSources(artifacts: TaskArtifactText[]): HistorySearchSource[] {
	return artifacts
		.filter((artifact) => artifact.text.length > 0)
		.map((artifact, index) => ({
			label: `artifact ${artifact.id}${artifact.truncated ? " (scanned partially)" : ""}`,
			text: artifact.text,
			timestamp: artifactTimestamp(artifact.id),
			// Artifacts sort after a message written in the same millisecond:
			// the artifact is always produced by a tool result that already
			// exists in the conversation.
			order: Number.MAX_SAFE_INTEGER - 1_000_000 + index,
		}))
}

/** Epoch milliseconds encoded in an artifact id, or 0 when it is not one. */
function artifactTimestamp(artifactId: string): number {
	const match = artifactId.match(/-(\d+)\.txt$/)
	return match ? Number(match[1]) : 0
}

/** ISO-8601 rendering, or "" for an unusable number. */
function formatTimestamp(value: number): string {
	try {
		return new Date(value).toISOString()
	} catch {
		return ""
	}
}

/**
 * Runs the search over already-built sources.
 *
 * ## Ordering
 *
 * Selection keeps the NEWEST matches, presentation is chronological. The oldest
 * occurrence of a repeated phrase is rarely the useful one (WS-G asks for
 * newest-first priority), but a model reading three snippets of one
 * conversation needs them in the order they happened.
 *
 * ## Deduplication
 *
 * Keyed on the whitespace-normalised text of the matching line, keeping the
 * LATEST copy. A pruned tool result leaves a head/tail preview in the
 * conversation AND the full text in an artifact, so the same line legitimately
 * appears twice and the model should not pay context for both. Keeping the
 * latest is what makes the cap honest: the header promises the most recent
 * matches, so returning an older copy with its older (and, for a preview,
 * truncated) context would contradict it. The artifact copy also carries the
 * better context, because it is the untruncated text.
 *
 * Both counts are reported, so "matched 7, 3 after removing duplicate copies"
 * never looks like a lost match.
 *
 * ## Cost control
 *
 * Each line is tested only up to `MAX_TESTED_LINE_CHARS`, and the clock is
 * checked every `BUDGET_CHECK_INTERVAL` lines. On expiry the scan stops and
 * `timedOut` is set; the caller turns that into a corrective tool error rather
 * than a partial result the model would read as complete.
 */
export function searchHistorySources(
	sources: HistorySearchSource[],
	query: string,
	maxResults: number,
	options: { messageCount?: number; artifactCount?: number; now?: () => number } = {},
): HistorySearchOutcome {
	const { regex, mode } = compileHistoryQuery(query)
	const cap = clampMaxResults(maxResults)
	const now = options.now ?? Date.now
	const deadline = now() + HISTORY_SEARCH_DEFAULTS.MAX_SEARCH_MILLIS

	const lineCache = new Map<number, string[]>()
	const matches: Array<{ sourceIndex: number; lineIndex: number; line: string }> = []
	let timedOut = false
	let scanned = 0

	for (let sourceIndex = 0; sourceIndex < sources.length && !timedOut; sourceIndex++) {
		// `\r?\n` so a CRLF corpus (Windows line endings in logs and command
		// output) does not leave a trailing `\r` that silently defeats every
		// `$`-anchored query. The cache feeds display too, so hit blocks stay
		// clean as well.
		const lines = sources[sourceIndex].text.split(/\r?\n/)
		lineCache.set(sourceIndex, lines)

		for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
			scanned++
			if (scanned % HISTORY_SEARCH_DEFAULTS.BUDGET_CHECK_INTERVAL === 0 && now() > deadline) {
				timedOut = true
				break
			}

			const line = lines[lineIndex]
			const tested =
				line.length > HISTORY_SEARCH_DEFAULTS.MAX_TESTED_LINE_CHARS
					? line.slice(0, HISTORY_SEARCH_DEFAULTS.MAX_TESTED_LINE_CHARS)
					: line

			if (regex.test(tested)) {
				matches.push({ sourceIndex, lineIndex, line })

				// The clock cannot bound the post-scan sort/dedup, so the match
				// count has to: see MAX_COLLECTED_MATCHES.
				if (matches.length >= HISTORY_SEARCH_DEFAULTS.MAX_COLLECTED_MATCHES) {
					timedOut = true
					break
				}
			}
		}
	}

	// The interval check above can miss a breach on the last stretch of lines;
	// nothing below is worth starting once the budget is spent.
	if (!timedOut && now() > deadline) {
		timedOut = true
	}

	const messageCount = options.messageCount ?? 0
	const artifactCount = options.artifactCount ?? 0

	if (timedOut) {
		return {
			hits: [],
			totalMatches: matches.length,
			distinctMatches: 0,
			omitted: 0,
			mode,
			timedOut: true,
			messageCount,
			artifactCount,
		}
	}

	// Chronological order first, so "keep the newest" and "print oldest first"
	// are both slices of the same sorted array.
	matches.sort((a, b) => {
		const left = sources[a.sourceIndex]
		const right = sources[b.sourceIndex]
		if (left.timestamp !== right.timestamp) {
			return left.timestamp - right.timestamp
		}
		if (left.order !== right.order) {
			return left.order - right.order
		}
		return a.lineIndex - b.lineIndex
	})

	// Walk newest to oldest so the copy that survives a collision is the latest.
	const seen = new Set<string>()
	const dedupedReversed: typeof matches = []
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i]
		const key = match.line.trim().replace(/\s+/g, " ")

		if (key.length > 0) {
			if (seen.has(key)) {
				continue
			}
			seen.add(key)
		}

		dedupedReversed.push(match)
	}
	const deduped = dedupedReversed.reverse()

	const kept = deduped.slice(Math.max(0, deduped.length - cap))

	const hits: HistorySearchHit[] = kept.map((match) => {
		const source = sources[match.sourceIndex]
		const lines = lineCache.get(match.sourceIndex) ?? []
		return {
			label: source.label,
			lineNumber: match.lineIndex + 1,
			block: buildHitBlock(lines, match.lineIndex),
		}
	})

	return {
		hits,
		totalMatches: matches.length,
		distinctMatches: deduped.length,
		omitted: Math.max(0, deduped.length - kept.length),
		mode,
		timedOut: false,
		messageCount,
		artifactCount,
	}
}

/** Clamps a requested result count into [1, MAX_MAX_RESULTS]. */
export function clampMaxResults(requested: number | undefined): number {
	if (typeof requested !== "number" || !Number.isFinite(requested)) {
		return HISTORY_SEARCH_DEFAULTS.DEFAULT_MAX_RESULTS
	}
	const rounded = Math.floor(requested)
	if (rounded < 1) {
		return 1
	}
	return Math.min(rounded, HISTORY_SEARCH_DEFAULTS.MAX_MAX_RESULTS)
}

/**
 * Builds the printable block for one match: the matching line marked with `>`,
 * with `CONTEXT_LINES` lines on each side, every line numbered and truncated,
 * and the whole block capped at `MAX_HIT_BYTES`.
 */
function buildHitBlock(lines: string[], lineIndex: number): string {
	const first = Math.max(0, lineIndex - HISTORY_SEARCH_DEFAULTS.CONTEXT_LINES)
	const last = Math.min(lines.length - 1, lineIndex + HISTORY_SEARCH_DEFAULTS.CONTEXT_LINES)
	const width = String(last + 1).length

	const rendered: string[] = []
	for (let i = first; i <= last; i++) {
		const marker = i === lineIndex ? ">" : " "
		rendered.push(`${marker} ${String(i + 1).padStart(width)} | ${truncateLine(lines[i])}`)
	}

	return capBytes(rendered.join("\n"), HISTORY_SEARCH_DEFAULTS.MAX_HIT_BYTES)
}

/** Cuts one line at the character cap. */
function truncateLine(line: string): string {
	if (line.length <= HISTORY_SEARCH_DEFAULTS.MAX_LINE_CHARS) {
		return line
	}
	return `${line.slice(0, HISTORY_SEARCH_DEFAULTS.MAX_LINE_CHARS)}${TRUNCATION_SUFFIX}`
}

/** Cuts a block at a byte cap, dropping a trailing partial character. */
function capBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) {
		return text
	}

	const kept = Buffer.from(text, "utf8")
		.subarray(0, Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_SUFFIX, "utf8")))
		.toString("utf8")
		.replace(/\uFFFD$/, "")

	return `${kept}${TRUNCATION_SUFFIX}`
}

/** Plain-words explanation of how the query was interpreted. */
function describeMode(mode: HistoryQueryMode): string {
	switch (mode) {
		case "regex":
			return "The query was used as a regular expression."
		case "unsafe":
			return (
				"The query looks like a regular expression that can take exponential time (a repeated group inside " +
				"another repeat, such as (a+)+), so it was searched for as plain text instead. Rewrite it without the " +
				"nested repeat if you meant it as a pattern."
			)
		default:
			return "The query was used as literal text, because it is not a valid regular expression."
	}
}

/**
 * Renders the outcome as the tool result the model reads.
 *
 * Every ending is an instruction, not just a fact: a small model that receives
 * "no matches" and nothing else re-runs the same query with a synonym, while
 * "drop the punctuation and search one word" gets it to a useful call in one
 * turn. Each result opens with {@link SEARCH_TASK_HISTORY_RESULT_MARKER}, which
 * is also what keeps the next search from finding this one.
 */
export function formatHistorySearchOutcome(outcome: HistorySearchOutcome, query: string): string {
	const corpus = `${outcome.messageCount} stored message(s) and ${outcome.artifactCount} artifact file(s)`

	if (outcome.timedOut) {
		return [
			`${SEARCH_TASK_HISTORY_RESULT_MARKER} The search was stopped after ${HISTORY_SEARCH_DEFAULTS.MAX_SEARCH_MILLIS} ms because this pattern is too expensive to run over the stored history.`,
			"Search again for a plain distinctive fragment (an identifier, a file name, an error code) instead of a pattern,",
			"or simplify the pattern by removing repeats such as .* and +.",
		].join(" ")
	}

	// Only when there is genuinely nothing to search. Checked after the hits, so
	// a caller that omits the corpus counts can never hide real matches behind
	// this message.
	if (outcome.hits.length === 0 && outcome.messageCount === 0 && outcome.artifactCount === 0) {
		return [
			`${SEARCH_TASK_HISTORY_RESULT_MARKER} This task has no stored history to search: the conversation file is empty or could not be read.`,
			"Searching again with a different query will not help.",
			"Work from what is still visible in the conversation, or ask the user for the detail you are missing.",
		].join(" ")
	}

	if (outcome.hits.length === 0) {
		return [
			`${SEARCH_TASK_HISTORY_RESULT_MARKER} No match for "${query}" in this task's stored history (${corpus}).`,
			describeMode(outcome.mode),
			"Try a shorter and more distinctive fragment, search one word instead of a phrase, or remove regex punctuation.",
			"This tool only searches THIS task's own conversation. To search the project's files use search_files instead.",
		].join(" ")
	}

	const matchSummary =
		outcome.totalMatches === outcome.distinctMatches
			? `matched ${outcome.totalMatches} line(s)`
			: `matched ${outcome.totalMatches} line(s), ${outcome.distinctMatches} after removing duplicate copies`

	const header = [
		`${SEARCH_TASK_HISTORY_RESULT_MARKER} "${query}" ${matchSummary} in this task's stored history (${corpus}).`,
		describeMode(outcome.mode),
		`Showing the ${outcome.hits.length} most recent match(es), oldest first.`,
	]

	if (outcome.omitted > 0) {
		header.push(
			`${outcome.omitted} older match(es) are not shown; raise max_results (cap ${HISTORY_SEARCH_DEFAULTS.MAX_MAX_RESULTS}) or use a narrower query to see them.`,
		)
	}

	const body = outcome.hits.map((hit) => `--- ${hit.label} ---\n${hit.block}`).join("\n\n")

	return `${header.join(" ")}\n\n${body}`
}

/**
 * Reads every artifact file of a task, bounded in both directions.
 *
 * Bounds matter here: an artifact may be up to `MAX_ARTIFACT_BYTES` (10 MB) and
 * a long task can hold many of them, so an unbounded read would pull hundreds
 * of megabytes into the extension host just to grep them. Files past the
 * per-file cap are read only up to it and flagged, which is honest (the label
 * says "scanned partially") and still finds anything near the start.
 *
 * Artifacts that hold an earlier result of THIS tool are skipped. The tool is
 * on `SPILL_BYPASS_TOOLS` so no new one can be written, but a task started on
 * an older build may already own one, and searching it would reintroduce the
 * self-echo the message-level carve-out exists to prevent.
 *
 * Missing directories are not an error: a task that never spilled anything
 * simply has no artifacts.
 */
export async function readTaskArtifacts(taskDir: string): Promise<TaskArtifactText[]> {
	const artifacts: TaskArtifactText[] = []
	let totalBytes = 0

	for (const directory of ARTIFACT_DIRECTORIES) {
		const absoluteDir = path.join(taskDir, directory)

		let entries: string[]
		try {
			entries = await fs.readdir(absoluteDir)
		} catch {
			continue
		}

		for (const entry of entries.slice().sort()) {
			if (!isValidArtifactId(entry)) {
				continue
			}

			if (totalBytes >= HISTORY_SEARCH_DEFAULTS.MAX_TOTAL_ARTIFACT_SCAN_BYTES) {
				break
			}

			const absolutePath = path.join(absoluteDir, entry)

			try {
				const stats = await fs.stat(absolutePath)
				const remaining = HISTORY_SEARCH_DEFAULTS.MAX_TOTAL_ARTIFACT_SCAN_BYTES - totalBytes
				const allowance = Math.min(HISTORY_SEARCH_DEFAULTS.MAX_ARTIFACT_SCAN_BYTES, remaining)
				const toRead = Math.min(stats.size, allowance)

				if (toRead <= 0) {
					continue
				}

				const handle = await fs.open(absolutePath, "r")
				try {
					const buffer = Buffer.alloc(toRead)
					const { bytesRead } = await handle.read(buffer, 0, toRead, 0)
					const truncated = bytesRead < stats.size
					let text = buffer.subarray(0, bytesRead).toString("utf8")

					if (truncated) {
						// A byte cap can cut a multi-byte character in half, which
						// decodes as a trailing U+FFFD. Same clean-up as capBytes.
						text = text.replace(/\uFFFD$/, "")
					}

					if (isSearchResultText(text)) {
						continue
					}

					totalBytes += bytesRead

					artifacts.push({
						id: entry,
						text,
						truncated,
					})
				} finally {
					await handle.close()
				}
			} catch {
				// An unreadable artifact is skipped, never fatal: the message
				// history alone is still a useful corpus.
			}
		}
	}

	return artifacts
}

/** What one complete search produced. */
export interface HistorySearchResult {
	/** The tool result text. */
	text: string
	/** True when the scan was stopped by its wall-clock budget. */
	timedOut: boolean
}

/**
 * The whole search in one call: build the corpus, search it, format it.
 *
 * Pure with respect to I/O (both inputs are already loaded), which is what the
 * unit tests drive.
 */
export function searchTaskHistoryCorpus(options: {
	messages: ApiMessage[]
	artifacts: TaskArtifactText[]
	query: string
	maxResults?: number
	now?: () => number
}): HistorySearchResult {
	const { messages, artifacts, query, maxResults, now } = options

	const sources = [...messageSearchSources(messages), ...artifactSearchSources(artifacts)]

	const outcome = searchHistorySources(sources, query, clampMaxResults(maxResults), {
		messageCount: messages.length,
		artifactCount: artifacts.length,
		now,
	})

	return { text: formatHistorySearchOutcome(outcome, query), timedOut: outcome.timedOut }
}
