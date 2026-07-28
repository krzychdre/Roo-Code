import { Anthropic } from "@anthropic-ai/sdk"

import type { TodoItem } from "@roo-code/types"

import { ApiMessage } from "../../task-persistence/apiMessages"
import { getEffectiveApiHistory } from "../../condense"

import {
	FILE_MUTATION_TOOLS,
	FILE_READ_TOOLS,
	classifyToolResultOutcome,
	extractEnvelopeFeedback,
	extractToolSubject,
	extractUserInstructions,
	isValidationCommand,
	toBoundedText,
	toSingleLine,
} from "./classify"
import type { ContextLedger, LedgerFact } from "./types"

/**
 * Upper bound on the goal fact.
 *
 * Measured over the 375 tasks where the resume snapshot applies, the task statement runs
 * median 1,740 chars / p75 4,516 / p90 8,480. The previous 400-char cap fit only 37% of them and
 * threw away a median of 3,348 chars from the rest — of the one fact that cannot be recovered by
 * re-reading anything. 2,000 fits 53% outright and costs at most ~800 tokens against a median
 * 16k-char snapshot; the rest keep both ends via {@link toBoundedText} rather than losing the
 * second half. Raising it further (4,000 fits 70%) buys exact fits that the head+tail shape
 * already approximates, at double the worst case.
 */
export const LEDGER_GOAL_MAX_CHARS = 2000

/**
 * Upper bound on one `user_instruction`.
 *
 * Mid-task instructions run median 83 chars and p90 317 over the task store, so 400 keeps ~90% of
 * them whole; the p100 is a 118 KB paste, which is precisely what the bound exists for. Same
 * head+tail treatment as the goal — a correction's trailing clause is the part that binds.
 */
export const LEDGER_USER_INSTRUCTION_MAX_CHARS = 400

/**
 * Upper bound on `userInstructions`, newest kept.
 *
 * Per task the count is median 0 / p90 2 / max 12, so 8 covers all but the outliers, and the
 * outliers are the tasks where the oldest corrections have long since been superseded anyway.
 */
export const MAX_LEDGER_USER_INSTRUCTIONS = 8

/** Upper bound on `artifacts`; the ledger is a checklist, not a file index. */
export const MAX_LEDGER_ARTIFACTS = 24

/** Upper bound on `fileChanges`; long refactors touch hundreds of files. */
export const MAX_LEDGER_FILE_CHANGES = 40

/** Upper bound on `openErrors`, newest first — old unresolved noise is not actionable. */
export const MAX_LEDGER_OPEN_ERRORS = 10

export interface BuildLedgerOptions {
	/** Current todo list — the authoritative record of the plan. */
	todos?: readonly TodoItem[]
}

interface ToolResultRecord {
	toolUseId: string
	toolName: string
	subject?: string
	text: string
	outcome: ReturnType<typeof classifyToolResultOutcome>
	index: number
}

function toolResultText(content: Anthropic.Messages.ToolResultBlockParam["content"]): string {
	if (typeof content === "string") {
		return content
	}
	if (Array.isArray(content)) {
		return content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
	}
	return ""
}

/**
 * The first user turn that actually says something, with its position.
 *
 * The position matters as much as the text: that message is the goal, and it is also the one turn
 * whose `<user_message>` must NOT become a `user_instruction`, or every task would open with its
 * own request restated as a mid-task correction.
 */
function firstUserText(messages: ApiMessage[]): { text: string; messageIndex: number } | undefined {
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex]
		if (message.role !== "user") {
			continue
		}
		if (typeof message.content === "string") {
			return { text: message.content, messageIndex }
		}
		if (Array.isArray(message.content)) {
			// Skip turns that only carry tool results — those are not the task statement.
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => (block as Anthropic.Messages.TextBlockParam).text)
				.join("\n")
			if (text.trim()) {
				return { text, messageIndex }
			}
		}
	}
	return undefined
}

/**
 * Strips the environment/reminder wrappers Roo appends to the first user turn, so the goal fact
 * is the user's actual request rather than a directory listing.
 *
 * `<user_message>` is the wrapper this fork actually emits for a task statement
 * (`TaskLifecycle.startTask`); `<task>` is the upstream shape, still handled because old histories
 * on disk carry it. Unwrapping matters twice over: the tags are noise in the prompt, and they used
 * to eat characters out of the goal's own budget.
 */
function extractGoalText(raw: string): string {
	const withoutEnvironment = raw.split("<environment_details>")[0] ?? raw
	const withoutReminders = withoutEnvironment.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
	const tagged = /<(?:task|user_message)>([\s\S]*?)<\/(?:task|user_message)>/.exec(withoutReminders)
	return (tagged?.[1] ?? withoutReminders).trim()
}

/**
 * Builds the typed state ledger from an API conversation history.
 *
 * Deterministic and side-effect free: one linear pass over the effective (non-condensed,
 * non-truncated) history. Safe to call per request; callers that need it more than once per turn
 * should memoise on the message array reference.
 */
export function buildContextLedger(messages: ApiMessage[], options: BuildLedgerOptions = {}): ContextLedger {
	const effective = getEffectiveApiHistory(messages)

	// tool_use_id -> (name, input), so results can be attributed to a tool and a subject.
	const toolUseById = new Map<string, { name: string; input: unknown }>()
	for (const message of effective) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "tool_use") {
					toolUseById.set(block.id, { name: block.name, input: block.input })
				}
			}
		}
	}

	// ── goal ────────────────────────────────────────────────────────────────────────────────
	const rawGoal = firstUserText(effective)
	const goalText = rawGoal ? extractGoalText(rawGoal.text) : ""
	const goal: LedgerFact | undefined = goalText
		? { class: "goal", text: toBoundedText(goalText, LEDGER_GOAL_MAX_CHARS), index: 0 }
		: undefined

	const records: ToolResultRecord[] = []
	// ── user instructions ───────────────────────────────────────────────────────────────────
	// Keyed by the rendered text so a repeated instruction collapses onto its latest occurrence
	// instead of filling the cap with copies of itself.
	const instructionByText = new Map<string, LedgerFact>()
	let index = 0

	const recordInstruction = (body: string, toolUseId?: string) => {
		const text = toBoundedText(body, LEDGER_USER_INSTRUCTION_MAX_CHARS)
		instructionByText.set(text, { class: "user_instruction", text, toolUseId, index: index++ })
	}

	for (let messageIndex = 0; messageIndex < effective.length; messageIndex++) {
		const message = effective[messageIndex]
		if (message.role !== "user") {
			continue
		}
		// The task statement is already the goal fact; recording it again would open every
		// snapshot with the request restated as a correction to itself.
		const isGoalMessage = messageIndex === rawGoal?.messageIndex

		if (typeof message.content === "string") {
			if (!isGoalMessage) {
				extractUserInstructions(message.content).forEach((body) => recordInstruction(body))
			}
			continue
		}
		if (!Array.isArray(message.content)) {
			continue
		}

		for (const block of message.content) {
			if (block.type === "text") {
				if (!isGoalMessage) {
					extractUserInstructions(block.text).forEach((body) => recordInstruction(body))
				}
				continue
			}
			if (block.type !== "tool_result") {
				continue
			}
			const tr = block as Anthropic.Messages.ToolResultBlockParam
			const text = toolResultText(tr.content)

			// Attributed to the tool_use so the result carrying it earns compaction protection —
			// `execute_command` is compactable, and it is one of the tools user text arrives through.
			extractUserInstructions(text).forEach((body) => recordInstruction(body, tr.tool_use_id))
			const feedback = extractEnvelopeFeedback(text)
			if (feedback) {
				recordInstruction(feedback, tr.tool_use_id)
			}

			const use = toolUseById.get(tr.tool_use_id)
			if (!use) {
				continue
			}
			records.push({
				toolUseId: tr.tool_use_id,
				toolName: use.name,
				subject: extractToolSubject(use.name, use.input),
				text,
				outcome: classifyToolResultOutcome(text, tr.is_error),
				index: index++,
			})
		}
	}

	// ── decisions (the plan) ────────────────────────────────────────────────────────────────
	const decisions: LedgerFact[] = (options.todos ?? []).map((todo, i) => ({
		class: "decision" as const,
		text: `[${todo.status}] ${toSingleLine(todo.content, 160)}`,
		subject: todo.id,
		index: i,
	}))

	// ── file changes ────────────────────────────────────────────────────────────────────────
	// Keyed by path so a file edited five times yields one fact carrying the latest state.
	const fileChangeByPath = new Map<string, LedgerFact>()
	// ── open errors ─────────────────────────────────────────────────────────────────────────
	// A failure is *closed* by a later ok result on the same subject; keying by subject and
	// overwriting in encounter order implements that without a second pass.
	const errorBySubject = new Map<string, LedgerFact | undefined>()
	// ── validations ─────────────────────────────────────────────────────────────────────────
	const validationByCommand = new Map<string, LedgerFact>()
	// ── artifacts ───────────────────────────────────────────────────────────────────────────
	const artifactByPath = new Map<string, LedgerFact>()

	for (const record of records) {
		const subjectKey = record.subject ?? record.toolName

		if (record.outcome === "ok") {
			// Any success on a subject closes a previously recorded failure on it.
			if (errorBySubject.has(subjectKey)) {
				errorBySubject.set(subjectKey, undefined)
			}
		} else {
			const label = record.outcome === "denied" ? "denied by user" : "failed"
			errorBySubject.set(subjectKey, {
				class: "open_error",
				text: `${record.toolName} ${label} on ${toSingleLine(subjectKey, 120)}: ${toSingleLine(record.text, 200)}`,
				subject: subjectKey,
				toolUseId: record.toolUseId,
				index: record.index,
			})
		}

		if (FILE_MUTATION_TOOLS.has(record.toolName) && record.subject && record.outcome === "ok") {
			fileChangeByPath.set(record.subject, {
				class: "file_change",
				text: `${record.subject} (${record.toolName})`,
				subject: record.subject,
				toolUseId: record.toolUseId,
				index: record.index,
			})
		}

		if (record.toolName === "execute_command" && record.subject && isValidationCommand(record.subject)) {
			validationByCommand.set(record.subject, {
				class: "validation",
				text: `${toSingleLine(record.subject, 120)} → ${record.outcome === "ok" ? "passed" : record.outcome}`,
				subject: record.subject,
				toolUseId: record.toolUseId,
				index: record.index,
			})
		}

		if (FILE_READ_TOOLS.has(record.toolName) && record.subject && record.outcome === "ok") {
			artifactByPath.set(record.subject, {
				class: "artifact",
				text: record.subject,
				subject: record.subject,
				toolUseId: record.toolUseId,
				index: record.index,
			})
		}
	}

	const byIndexDesc = (a: LedgerFact, b: LedgerFact) => b.index - a.index

	// Newest kept, then put back in the order they were said: a later instruction supersedes an
	// earlier one, and that only reads correctly if the last line is the last thing the user said.
	const userInstructions = [...instructionByText.values()]
		.sort(byIndexDesc)
		.slice(0, MAX_LEDGER_USER_INSTRUCTIONS)
		.reverse()

	const fileChanges = [...fileChangeByPath.values()].sort(byIndexDesc).slice(0, MAX_LEDGER_FILE_CHANGES).reverse()

	const openErrors = [...errorBySubject.values()]
		.filter((fact): fact is LedgerFact => fact !== undefined)
		.sort(byIndexDesc)
		.slice(0, MAX_LEDGER_OPEN_ERRORS)

	const validations = [...validationByCommand.values()].sort(byIndexDesc)

	const artifacts = [...artifactByPath.values()].sort(byIndexDesc).slice(0, MAX_LEDGER_ARTIFACTS)

	// Only classes that cannot be re-derived cheaply earn protection. A file read is excluded on
	// purpose: re-reading it costs one tool call, while a lost failure costs a wrong conclusion.
	const criticalToolUseIds = new Set<string>()
	for (const fact of [...openErrors, ...validations, ...fileChanges, ...userInstructions]) {
		if (fact.toolUseId) {
			criticalToolUseIds.add(fact.toolUseId)
		}
	}

	const facts: LedgerFact[] = [
		...(goal ? [goal] : []),
		...userInstructions,
		...decisions,
		...fileChanges,
		...openErrors,
		...validations,
		...artifacts,
	]

	return {
		goal,
		userInstructions,
		decisions,
		fileChanges,
		openErrors,
		validations,
		artifacts,
		facts,
		criticalToolUseIds,
	}
}
