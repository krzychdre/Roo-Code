import * as path from "node:path"

import { oneLine, textOf } from "./normalize.js"
import { extractActions } from "./tools.js"
import { AGENT_LABELS, type InterchangeMessage, type Session, type SessionSummary, type ToolAction } from "./types.js"

/**
 * A session, reduced to what another agent needs in order to take it over.
 *
 * Everything here is *derived* from the transcript — files touched, commands
 * run, the plan, the open questions — so the briefing does not depend on the
 * previous model having been accurate about its own work. Prose the model wrote
 * is included too, but always labelled as such.
 */

export interface BriefingOptions {
	/** Characters of the opening request to keep. Default 2000. */
	maxRequestChars?: number
	/** How many of the model's closing notes to quote. Default 3. */
	assistantNotes?: number
	/** Append the pointer that explains how to read the raw transcript. */
	includeSourcePointer?: boolean
}

export interface BriefingFacts {
	request: string
	followUps: string[]
	filesWritten: string[]
	filesRead: string[]
	commands: string[]
	plans: string[]
	planFiles: string[]
	todos?: string
	questions: string[]
	outcome?: string
	assistantNotes: string[]
	toolTally: Array<{ tool: string; count: number }>
	delegations: string[]
}

/**
 * Wrappers each agent adds around what the user actually typed.
 *
 * Claude Code injects `<system-reminder>` and `<ide_selection>`; Tumble Code
 * wraps the prompt in `<task>`/`<user_message>`/`<feedback>` and appends an
 * `<environment_details>` block the size of a directory listing. None of it is
 * the request, and all of it drowns the briefing if left in.
 */
const SYSTEM_NOISE = [
	/<system-reminder>[\s\S]*?<\/system-reminder>/g,
	/<ide_selection>[\s\S]*?<\/ide_selection>/g,
	/<environment_details>[\s\S]*?<\/environment_details>/g,
	/<\/?(?:task|user_message|feedback|answer)>/g,
]

export function collectFacts(session: Session, options: BriefingOptions = {}): BriefingFacts {
	const { maxRequestChars = 2000, assistantNotes = 3 } = options
	const actions = extractActions(session.messages)
	const userTexts = session.messages
		.filter((message) => message.role === "user")
		.map((message) => clean(textOf(message.blocks)))
		.filter(Boolean)

	const facts: BriefingFacts = {
		request: truncate(userTexts[0] ?? "", maxRequestChars),
		followUps: userTexts.slice(1).map((text) => oneLine(text, 160)),
		filesWritten: pathsOf(actions, "write"),
		filesRead: pathsOf(actions, "read"),
		commands: unique(actions.filter((action) => action.command).map((action) => oneLine(action.command!, 160))),
		plans: actions.filter((action) => action.kind === "plan" && action.text).map((action) => action.text!),
		planFiles: planFilesOf(actions),
		todos: lastText(actions, "todo"),
		questions: unique(actions.filter((action) => action.kind === "question" && action.text).map((a) => a.text!)),
		outcome: lastText(actions, "complete") ?? session.resultSummary,
		assistantNotes: closingNotes(session.messages, assistantNotes),
		toolTally: tally(actions),
		delegations: unique(
			actions.filter((action) => action.kind === "delegate" && action.text).map((a) => oneLine(a.text!, 160)),
		),
	}

	return facts
}

export function renderBriefing(session: Session, options: BriefingOptions = {}): string {
	const facts = collectFacts(session, options)
	const lines: string[] = []

	lines.push(`# ${session.title}`, "")
	lines.push(...metaLines(session), "")

	if (facts.request) {
		lines.push("## The request", "", facts.request, "")
	}

	if (facts.followUps.length > 0) {
		lines.push("## What the user added along the way", "")
		lines.push(...facts.followUps.map((text) => `- ${text}`), "")
	}

	if (facts.plans.length > 0) {
		lines.push("## Plan the agent settled on", "", facts.plans[facts.plans.length - 1]!, "")
	}

	if (facts.planFiles.length > 0) {
		lines.push("## Plan documents referenced", "")
		lines.push(...facts.planFiles.map((file) => `- \`${file}\``), "")
	}

	if (facts.filesWritten.length > 0) {
		lines.push(`## Files changed (${facts.filesWritten.length})`, "")
		lines.push(...facts.filesWritten.map((file) => `- \`${file}\``), "")
	}

	if (facts.filesRead.length > 0) {
		lines.push(`## Files read (${facts.filesRead.length})`, "")
		lines.push(...capped(facts.filesRead, 40).map((file) => `- \`${file}\``), "")
	}

	if (facts.commands.length > 0) {
		lines.push(`## Commands run (${facts.commands.length})`, "")
		lines.push(...capped(facts.commands, 25).map((command) => `- \`${command}\``), "")
	}

	if (facts.delegations.length > 0) {
		lines.push("## Subtasks delegated", "")
		lines.push(...facts.delegations.map((text) => `- ${text}`), "")
	}

	if (facts.todos) {
		lines.push("## Task list, last state", "", facts.todos, "")
	}

	if (facts.questions.length > 0) {
		lines.push("## Questions the agent asked", "")
		lines.push(...facts.questions.map((text) => `- ${oneLine(text, 200)}`), "")
	}

	if (facts.assistantNotes.length > 0) {
		lines.push("## The agent's own closing notes", "")

		for (const note of facts.assistantNotes) {
			lines.push(`> ${note.split("\n").join("\n> ")}`, "")
		}
	}

	if (facts.outcome) {
		lines.push("## Reported outcome", "", truncate(facts.outcome, 2000), "")
	}

	if (facts.toolTally.length > 0) {
		lines.push("## Tool usage", "", facts.toolTally.map((entry) => `${entry.tool} ×${entry.count}`).join(", "), "")
	}

	if (options.includeSourcePointer !== false) {
		lines.push("## Source", "")
		lines.push(`- Agent: ${AGENT_LABELS[session.agent]}`)
		lines.push(`- Session id: \`${session.id}\``)
		lines.push(`- Store: \`${session.path}\``)
		lines.push(
			`- Full transcript: \`read_session\` with \`format: "transcript"\` — ${session.messages.length} messages` +
				(session.sidechainMessages?.length ? `, plus ${session.sidechainMessages.length} subagent turns` : "") +
				".",
		)
		lines.push("")
	}

	return (
		lines
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd() + "\n"
	)
}

/** One-line-per-fact header shared by briefings and handoffs. */
export function metaLines(summary: SessionSummary): string[] {
	const lines: string[] = []

	lines.push(`**Agent:** ${AGENT_LABELS[summary.agent]} · **Session:** \`${summary.id}\``)

	if (summary.cwd) {
		lines.push(
			`**Workspace:** \`${summary.cwd}\`${summary.gitBranch ? ` · **Branch:** \`${summary.gitBranch}\`` : ""}`,
		)
	}

	const when = [
		`**Started:** ${formatTime(summary.createdAt)}`,
		`**Last activity:** ${formatTime(summary.updatedAt)}`,
	]

	if (summary.messageCount !== undefined) {
		when.push(`**Messages:** ${summary.messageCount}`)
	}

	lines.push(when.join(" · "))

	const how: string[] = []

	if (summary.mode) {
		how.push(`**Mode:** ${summary.mode}`)
	}

	if (summary.model) {
		how.push(`**Model:** ${summary.model}`)
	}

	if (summary.apiConfigName) {
		how.push(`**Profile:** ${summary.apiConfigName}`)
	}

	if (summary.status) {
		how.push(`**Status:** ${summary.status}`)
	}

	if (how.length > 0) {
		lines.push(how.join(" · "))
	}

	const cost: string[] = []

	if (summary.tokensIn || summary.tokensOut) {
		cost.push(`**Tokens:** ${summary.tokensIn ?? 0} in / ${summary.tokensOut ?? 0} out`)
	}

	if (summary.totalCost) {
		cost.push(`**Cost:** $${summary.totalCost.toFixed(4)}`)
	}

	if (cost.length > 0) {
		lines.push(cost.join(" · "))
	}

	return lines
}

/** The compact listing an agent scans before choosing a session. */
export function renderSessionList(summaries: SessionSummary[]): string {
	if (summaries.length === 0) {
		return "No sessions found."
	}

	const lines = ["| agent | id | updated | title |", "| --- | --- | --- | --- |"]

	for (const summary of summaries) {
		lines.push(
			`| ${AGENT_LABELS[summary.agent]} | \`${summary.id}\` | ${formatTime(summary.updatedAt)} | ${escapeCell(
				summary.title,
			)} |`,
		)
	}

	return lines.join("\n")
}

function pathsOf(actions: ToolAction[], kind: ToolAction["kind"]): string[] {
	return unique(actions.filter((action) => action.kind === kind).flatMap((action) => action.paths ?? []))
}

/** Plan documents are recognised by where they live, in either agent's world. */
function planFilesOf(actions: ToolAction[]): string[] {
	const candidates = unique(actions.flatMap((action) => action.paths ?? []))

	return candidates.filter((candidate) => {
		if (!candidate.endsWith(".md")) {
			return false
		}

		const normalized = candidate.split(path.sep).join("/")

		return /(^|\/)ai_plans\//.test(normalized) || /(^|\/)\.claude\/plans\//.test(normalized)
	})
}

function lastText(actions: ToolAction[], kind: ToolAction["kind"]): string | undefined {
	for (let i = actions.length - 1; i >= 0; i--) {
		const action = actions[i]!

		if (action.kind === kind && action.text) {
			return action.text
		}
	}

	return undefined
}

/** The last few substantive prose turns — usually the model's own wrap-up. */
function closingNotes(messages: InterchangeMessage[], count: number): string[] {
	const notes: string[] = []

	for (let i = messages.length - 1; i >= 0 && notes.length < count; i--) {
		const message = messages[i]!

		if (message.role !== "assistant") {
			continue
		}

		const text = clean(textOf(message.blocks))

		if (text.length > 80) {
			notes.unshift(truncate(text, 800))
		}
	}

	return notes
}

function tally(actions: ToolAction[]): Array<{ tool: string; count: number }> {
	const counts = new Map<string, number>()

	for (const action of actions) {
		counts.set(action.tool, (counts.get(action.tool) ?? 0) + 1)
	}

	return [...counts.entries()]
		.map(([tool, count]) => ({ tool, count }))
		.sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
}

function clean(text: string): string {
	let cleaned = text

	for (const pattern of SYSTEM_NOISE) {
		cleaned = cleaned.replace(pattern, "")
	}

	return cleaned.trim()
}

function truncate(text: string, limit: number): string {
	return text.length <= limit
		? text
		: `${text.slice(0, limit)}\n\n…[truncated, ${text.length - limit} more characters]`
}

function capped<T>(values: T[], limit: number): T[] {
	return values.length <= limit ? values : values.slice(0, limit)
}

function unique(values: string[]): string[] {
	return values.filter((value, index) => values.indexOf(value) === index)
}

function escapeCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

export function formatTime(epochMs: number): string {
	if (!epochMs) {
		return "unknown"
	}

	return new Date(epochMs).toISOString().replace("T", " ").slice(0, 16)
}
