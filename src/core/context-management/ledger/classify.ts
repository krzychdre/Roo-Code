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
