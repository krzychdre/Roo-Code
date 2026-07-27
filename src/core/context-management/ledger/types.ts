/**
 * Typed state ledger — shared, deterministic view of "what actually matters" in a task.
 *
 * Derived from the conversation with NO model call, so it cannot fail or hallucinate on a
 * weak local model (GLM/Qwen/Llama). Three consumers read it:
 *
 *  1. adaptive microcompaction — protects results that carry a critical fact
 *  2. condense validation      — checks the LLM summary retained the critical facts
 *  3. resume                   — serialises it as a semantic execution snapshot
 *
 * The six classes map onto the six things a coding agent must not silently lose when its
 * context is compressed: what it was asked to do, what it decided, what it changed, what is
 * still broken, what it proved, and what it can cite without re-reading.
 */

export type LedgerFactClass =
	/** The task goal — the first user request. */
	| "goal"
	/** A planning decision — an entry of the current todo list. */
	| "decision"
	/** A file the agent created or modified. */
	| "file_change"
	/** A tool failure with no later success on the same subject. */
	| "open_error"
	/** The outcome of a test / build / lint / typecheck run. */
	| "validation"
	/** A path the agent read and may need to cite again. */
	| "artifact"

export interface LedgerFact {
	class: LedgerFactClass
	/**
	 * Short, self-contained statement of the fact, safe to paste into a prompt.
	 * Kept terse on purpose: the ledger is a checklist, not a transcript.
	 */
	text: string
	/**
	 * What the fact is about — a file path, a command, or a tool name. Used to decide whether a
	 * later result supersedes an earlier one (an error on `src/a.ts` is closed by a later success
	 * on `src/a.ts`, not by an unrelated success).
	 */
	subject?: string
	/** The `tool_use_id` this fact was derived from, when it came from a tool result. */
	toolUseId?: string
	/** Position in the effective history; later facts win on the same subject. */
	index: number
}

export interface ContextLedger {
	/** The task goal, when a first user message exists. */
	goal?: LedgerFact
	/** Current plan entries, from the todo list. */
	decisions: LedgerFact[]
	/** Files created or modified, most recent last. */
	fileChanges: LedgerFact[]
	/** Failures with no later success on the same subject. */
	openErrors: LedgerFact[]
	/** Most recent outcome per validation command. */
	validations: LedgerFact[]
	/** Recently read paths, most recent first, capped. */
	artifacts: LedgerFact[]
	/** Every fact above, flattened in class order. */
	facts: LedgerFact[]
	/**
	 * `tool_use_id`s whose results carry a critical fact (an open error or a validation
	 * outcome). Consumed by microcompaction as a protection list — see
	 * `selectMicrocompactTargets`, which still size-gates them so a 140 KB failing build log
	 * remains clearable.
	 */
	criticalToolUseIds: ReadonlySet<string>
}

/** Classes whose loss is not recoverable by re-reading a file or re-running a command. */
export const CRITICAL_FACT_CLASSES: ReadonlySet<LedgerFactClass> = new Set<LedgerFactClass>([
	"goal",
	"open_error",
	"file_change",
])
