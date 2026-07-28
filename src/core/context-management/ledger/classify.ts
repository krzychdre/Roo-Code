/**
 * Deterministic classifiers for the typed state ledger.
 *
 * Every function here is pure and string-based. None of them calls a model, so none of them can
 * hallucinate; the only failure mode is a rule that is too narrow (a fact is missed) or too wide
 * (something ordinary is treated as important). Both consumers are built so that the second case
 * only costs reclaim, never data — see `selectMicrocompactTargets`.
 */

export type ToolResultOutcome = "ok" | "error" | "denied"

/**
 * Results longer than this are never classified as errors by *textual* heuristics.
 *
 * Measured against the on-disk task store (563 tasks): real failures have a median length of
 * 123 chars while successful results run 1,275 chars median and up to 192 KB. A large search or
 * file read that merely *contains* the word "Error:" (source code, a log grep) would otherwise be
 * misclassified, which is exactly the "błędne klasyfikowanie ważności" risk raised in review.
 * Explicit envelopes (`{"status":"error"}`, a leading `Error:`, `<error_details>`) are trusted at
 * any size; only the weaker "contains an error line" rule is size-gated.
 */
export const MAX_TEXTUAL_ERROR_CHARS = 4000

/** Cheap pre-check so we only attempt `JSON.parse` on something shaped like a status envelope. */
function looksLikeStatusEnvelope(text: string): boolean {
	return text.startsWith("{") && text.slice(0, 64).includes('"status"')
}

/**
 * Classifies a tool result as ok / error / denied.
 *
 * The Anthropic `is_error` flag is deliberately only one signal among several: in the real task
 * store it is set on 22 of 5,414 stored results, because Roo returns failures as the structured
 * envelopes built by `formatResponse.toolError` / `toolDenied` and as plain `Error:` text. A
 * classifier that trusted the flag alone would be a no-op in practice.
 */
export function classifyToolResultOutcome(text: string, isErrorFlag?: boolean): ToolResultOutcome {
	const trimmed = text.trim()

	// Structured envelopes: `formatResponse.toolError`, `toolDenied`, `rooIgnoreError`, ...
	if (looksLikeStatusEnvelope(trimmed)) {
		try {
			const parsed = JSON.parse(trimmed) as { status?: unknown }
			if (parsed && typeof parsed === "object") {
				if (parsed.status === "error") {
					return "error"
				}
				if (parsed.status === "denied") {
					return "denied"
				}
				if (parsed.status === "approved" || parsed.status === "success") {
					return "ok"
				}
			}
		} catch {
			// Not valid JSON after all — fall through to the textual rules.
		}
	}

	// Explicit markers, trusted at any size.
	if (
		/^(\[ERROR\]|Error:|ERROR:)/.test(trimmed) ||
		trimmed.startsWith("<error>") ||
		trimmed.startsWith("<error_details>") ||
		trimmed.startsWith("The tool execution failed")
	) {
		return "error"
	}

	if (isErrorFlag) {
		return "error"
	}

	// Weak rule, size-gated: an error line embedded in an otherwise small result, e.g. the
	// per-file `File: x.ts Error: ENOENT ...` shape emitted by multi-file reads.
	if (trimmed.length <= MAX_TEXTUAL_ERROR_CHARS && /(^|\n|\s)Error: \S/.test(trimmed)) {
		return "error"
	}

	return "ok"
}

/**
 * Commands whose result is a *proof* rather than data: tests, builds, type checks, linters.
 *
 * Their outcome is the single most expensive thing to lose — re-running them costs minutes of
 * wall clock, unlike re-reading a file. Matched on the executable at the start of the command or
 * immediately after a shell separator, so `echo "run npm test"` does not match.
 */
const VALIDATION_PATTERNS: readonly RegExp[] = [
	/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|build|lint|typecheck|type-check|check|verify|ci)\b/,
	/\b(?:npx\s+)?(?:vitest|jest|mocha|playwright|cypress|tsc|eslint|biome|oxlint)\b/,
	/\b(?:pytest|tox|nox|mypy|ruff|flake8|pylint)\b/,
	/\bpython\s+-m\s+(?:pytest|unittest|mypy)\b/,
	/\bcargo\s+(?:test|build|check|clippy)\b/,
	/\bgo\s+(?:test|build|vet)\b/,
	/\b(?:mvn|gradle|gradlew|\.\/gradlew)\s+.*\b(?:test|build|verify|check)\b/,
	/\bdotnet\s+(?:test|build)\b/,
	/\bmake\s+(?:test|check|lint|build|verify)\b/,
	/\b(?:rspec|phpunit|rake\s+test)\b/,
	/\bprettier\s+.*--check\b/,
	/\bblack\s+.*--check\b/,
]

/** True when the command is a test / build / lint / typecheck run. */
export function isValidationCommand(command: string): boolean {
	if (!command) {
		return false
	}
	const normalized = command.toLowerCase()
	return VALIDATION_PATTERNS.some((pattern) => pattern.test(normalized))
}

/** Tools that create or modify a file. Their subject is the written path. */
export const FILE_MUTATION_TOOLS: ReadonlySet<string> = new Set<string>([
	"write_to_file",
	"apply_diff",
	"apply_patch",
	"edit",
	"edit_file",
	"search_replace",
	"search_and_replace",
	"insert_content",
])

/** Tools that read a file or the codebase. Their subject is the read path or query. */
export const FILE_READ_TOOLS: ReadonlySet<string> = new Set<string>([
	"read_file",
	"list_files",
	"search_files",
	"codebase_search",
])

const XML_PATH_RE = /<path>([^<]+)<\/path>/

/**
 * Extracts the subject (path / command) from a tool_use input.
 *
 * Handles both the native tool-calling shape (`{ path: "src/a.ts" }`) and the legacy XML-in-args
 * shape (`{ args: "<file><path>src/a.ts</path></file>" }`) that older histories and some
 * providers still produce.
 */
export function extractToolSubject(toolName: string, input: unknown): string | undefined {
	if (!input || typeof input !== "object") {
		return undefined
	}
	const record = input as Record<string, unknown>

	if (toolName === "execute_command" || toolName === "read_command_output") {
		const command = record.command
		return typeof command === "string" && command.trim() ? command.trim() : undefined
	}

	const path = record.path
	if (typeof path === "string" && path.trim()) {
		return path.trim()
	}

	const args = record.args
	if (typeof args === "string") {
		const match = XML_PATH_RE.exec(args)
		if (match?.[1]?.trim()) {
			return match[1].trim()
		}
	}

	const query = record.query
	if (typeof query === "string" && query.trim()) {
		return query.trim()
	}

	return undefined
}

/** Collapses a value to a single short line, for ledger text that goes into a prompt. */
export function toSingleLine(value: string, maxChars = 200): string {
	const collapsed = value.replace(/\s+/g, " ").trim()
	return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}…`
}

/**
 * Below this budget, splitting the text in two leaves neither half long enough to say anything, so
 * plain head truncation is the better shape.
 */
const MIN_ELISION_BUDGET = 200

/**
 * Share of the budget given to the head. The opening states what is wanted; the closing carries the
 * constraints ("...and do not touch the tests"), which is why it is kept at all.
 */
const ELISION_HEAD_SHARE = 0.6

const elisionMarker = (omitted: number) => ` […${omitted} chars omitted…] `

/**
 * Collapses a value to a single line, keeping BOTH ends when it does not fit.
 *
 * `toSingleLine` truncates, which is right for an error message (the diagnostic is at the front)
 * but wrong for anything the user wrote: measured on the task store, the median request is 1,740
 * chars, so head-only truncation silently drops the second half of most requests — including the
 * trailing constraints, which are usually the part that is easiest to violate. Keeping a head and a
 * tail with an explicit, counted marker costs a few chars and never lies about what was dropped.
 */
export function toBoundedText(value: string, maxChars: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim()
	if (collapsed.length <= maxChars) {
		return collapsed
	}

	// Reserve the marker's worst case (the largest possible omitted count) so the result can never
	// exceed maxChars once the real, smaller count is substituted in.
	const budget = maxChars - elisionMarker(collapsed.length).length
	if (budget < MIN_ELISION_BUDGET) {
		return toSingleLine(collapsed, maxChars)
	}

	const head = Math.ceil(budget * ELISION_HEAD_SHARE)
	const tail = budget - head
	const omitted = collapsed.length - head - tail
	return `${collapsed.slice(0, head)}${elisionMarker(omitted)}${collapsed.slice(collapsed.length - tail)}`
}

/**
 * The wrapper every piece of user prose in this fork travels in.
 *
 * Measured over the on-disk store, mid-task user text reaches the model through exactly two shapes,
 * and `<user_message>` is by far the larger: 235 occurrences across 112 of the 375 tasks a resume
 * snapshot applies to. Most of them (191) arrive *inside a tool result* — the user's answer to
 * `ask_followup_question` / `attempt_completion`, or text typed at a running `execute_command` —
 * which is why looking only at standalone user turns finds almost nothing.
 */
const USER_MESSAGE_RE = /<user_message>([\s\S]*?)<\/user_message>/g

/**
 * Wrappers the runtime staples around user text, none of which the user wrote.
 *
 * `[TASK RESUMPTION]` is the preamble on a resumed turn; the other two are the standing context
 * blocks. Removing them keeps an instruction fact about what was asked rather than about the state
 * of the editor.
 */
const INSTRUCTION_NOISE_RE = [
	/<environment_details>[\s\S]*?<\/environment_details>/g,
	/<system-reminder>[\s\S]*?<\/system-reminder>/g,
	/\[TASK RESUMPTION\][\s\S]*?(?=<user_message>|$)/g,
]

/**
 * Replies that acknowledge without instructing.
 *
 * They are real user messages but carry no state, so restating them in a snapshot spends a line to
 * say nothing. Matched only against the WHOLE normalised message, so "continue with the migration"
 * and "no, use pnpm" are kept; both languages this workspace is driven in are listed.
 */
const ACKNOWLEDGEMENTS: ReadonlySet<string> = new Set<string>([
	"continue",
	"continue please",
	"go",
	"go ahead",
	"go on",
	"k",
	"n",
	"next",
	"no",
	"ok",
	"okay",
	"proceed",
	"resume",
	"thanks",
	"thank you",
	"y",
	"yes",
	// Polish
	"dalej",
	"dobra",
	"kontynuuj",
	"nie",
	"ok dalej",
	"tak",
	"zgoda",
])

function isAcknowledgement(text: string): boolean {
	const normalized = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, "")
		.replace(/\s+/g, " ")
		.trim()
	return normalized.length === 0 || ACKNOWLEDGEMENTS.has(normalized)
}

/**
 * Pulls every `<user_message>` body out of a text or tool-result payload.
 *
 * Returns them in the order they appear; a payload with no user prose returns an empty array, which
 * is the overwhelmingly common case, so this stays cheap to call on everything.
 */
export function extractUserInstructions(text: string): string[] {
	if (!text.includes("<user_message>")) {
		return []
	}

	const found: string[] = []
	for (const match of text.matchAll(USER_MESSAGE_RE)) {
		let body = match[1] ?? ""
		for (const pattern of INSTRUCTION_NOISE_RE) {
			body = body.replace(pattern, "")
		}
		body = body.trim()
		if (body && !isAcknowledgement(body)) {
			found.push(body)
		}
	}
	return found
}

/**
 * Pulls the user's note out of a denied / approved / guidance envelope.
 *
 * The second shape user text arrives in, and a much rarer one — 13 occurrences across 9 tasks — but
 * the ones it catches are disproportionately constraints ("do not take 1024 as a default"), and it
 * is the only record of an approval that came with a correction attached.
 */
export function extractEnvelopeFeedback(text: string): string | undefined {
	const trimmed = text.trim()
	if (!looksLikeStatusEnvelope(trimmed) || !trimmed.includes('"feedback"')) {
		return undefined
	}
	try {
		const parsed = JSON.parse(trimmed) as { feedback?: unknown }
		const feedback = typeof parsed?.feedback === "string" ? parsed.feedback.trim() : ""
		return feedback && !isAcknowledgement(feedback) ? feedback : undefined
	} catch {
		return undefined
	}
}
