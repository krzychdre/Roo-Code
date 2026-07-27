import { Anthropic } from "@anthropic-ai/sdk"

import type { TodoItem } from "@roo-code/types"

import { ApiMessage } from "../../task-persistence/apiMessages"
import { getEffectiveApiHistory } from "../../condense"

import {
	FILE_MUTATION_TOOLS,
	FILE_READ_TOOLS,
	classifyToolResultOutcome,
	extractToolSubject,
	isValidationCommand,
	toSingleLine,
} from "./classify"
import type { ContextLedger, LedgerFact } from "./types"

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

function firstUserText(messages: ApiMessage[]): string | undefined {
	for (const message of messages) {
		if (message.role !== "user") {
			continue
		}
		if (typeof message.content === "string") {
			return message.content
		}
		if (Array.isArray(message.content)) {
			// Skip turns that only carry tool results — those are not the task statement.
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => (block as Anthropic.Messages.TextBlockParam).text)
				.join("\n")
			if (text.trim()) {
				return text
			}
		}
	}
	return undefined
}

/**
 * Strips the environment/reminder wrappers Roo appends to the first user turn, so the goal fact
 * is the user's actual request rather than a directory listing.
 */
function extractGoalText(raw: string): string {
	const withoutEnvironment = raw.split("<environment_details>")[0] ?? raw
	const withoutReminders = withoutEnvironment.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
	const taskTag = /<task>([\s\S]*?)<\/task>/.exec(withoutReminders)
	return (taskTag?.[1] ?? withoutReminders).trim()
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

	const records: ToolResultRecord[] = []
	let index = 0
	for (const message of effective) {
		if (message.role !== "user" || !Array.isArray(message.content)) {
			continue
		}
		for (const block of message.content) {
			if (block.type !== "tool_result") {
				continue
			}
			const tr = block as Anthropic.Messages.ToolResultBlockParam
			const use = toolUseById.get(tr.tool_use_id)
			if (!use) {
				continue
			}
			const text = toolResultText(tr.content)
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

	// ── goal ────────────────────────────────────────────────────────────────────────────────
	const rawGoal = firstUserText(effective)
	const goalText = rawGoal ? extractGoalText(rawGoal) : ""
	const goal: LedgerFact | undefined = goalText
		? { class: "goal", text: toSingleLine(goalText, 400), index: 0 }
		: undefined

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
	for (const fact of [...openErrors, ...validations, ...fileChanges]) {
		if (fact.toolUseId) {
			criticalToolUseIds.add(fact.toolUseId)
		}
	}

	const facts: LedgerFact[] = [
		...(goal ? [goal] : []),
		...decisions,
		...fileChanges,
		...openErrors,
		...validations,
		...artifacts,
	]

	return { goal, decisions, fileChanges, openErrors, validations, artifacts, facts, criticalToolUseIds }
}
