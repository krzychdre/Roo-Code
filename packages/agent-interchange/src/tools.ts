import type { ActionKind, InterchangeMessage, ToolAction } from "./types.js"

/**
 * The two tool vocabularies, collapsed onto one set of verbs.
 *
 * Claude Code calls it `Edit`, Tumble Code calls it `apply_diff`; a briefing
 * only ever needs to say "wrote this file". Anything unmapped becomes `other`
 * and still shows up in the tool tally, so a new tool is never silently lost.
 */
const CLAUDE_TOOLS: Record<string, ActionKind> = {
	Read: "read",
	NotebookRead: "read",
	Write: "write",
	Edit: "write",
	MultiEdit: "write",
	NotebookEdit: "write",
	Bash: "command",
	BashOutput: "command",
	KillShell: "command",
	Glob: "search",
	Grep: "search",
	ExitPlanMode: "plan",
	TodoWrite: "todo",
	AskUserQuestion: "question",
	Task: "delegate",
	Agent: "delegate",
	WebFetch: "web",
	WebSearch: "web",
}

const TUMBLE_TOOLS: Record<string, ActionKind> = {
	read_file: "read",
	list_files: "read",
	list_code_definition_names: "read",
	write_to_file: "write",
	apply_diff: "write",
	apply_patch: "write",
	edit: "write",
	edit_file: "write",
	insert_content: "write",
	search_and_replace: "write",
	search_replace: "write",
	execute_command: "command",
	read_command_output: "command",
	search_files: "search",
	codebase_search: "search",
	update_todo_list: "todo",
	ask_followup_question: "question",
	new_task: "delegate",
	run_parallel_tasks: "delegate",
	attempt_completion: "complete",
	browser_action: "web",
	web_search: "web",
	web_fetch: "web",
	use_mcp_tool: "other",
	access_mcp_resource: "other",
	switch_mode: "other",
	fetch_instructions: "other",
	run_slash_command: "other",
	skill: "other",
	generate_image: "other",
	custom_tool: "other",
	tools_load: "other",
}

const TOOL_KINDS: Record<string, ActionKind> = { ...CLAUDE_TOOLS, ...TUMBLE_TOOLS }

/** Tumble tool names that appear as XML inside text when tool calls aren't native. */
const XML_TOOL_NAMES = Object.keys(TUMBLE_TOOLS)

export function actionKindOf(tool: string): ActionKind {
	return TOOL_KINDS[tool] ?? "other"
}

/**
 * Every tool call in a conversation, from both call styles.
 *
 * Tumble Code emits native `tool_use` blocks on providers that support them and
 * XML inside a text block otherwise — both styles occur in the same store, so
 * both are parsed here.
 */
export function extractActions(messages: InterchangeMessage[]): ToolAction[] {
	const actions: ToolAction[] = []

	messages.forEach((message, messageIndex) => {
		if (message.role !== "assistant") {
			return
		}

		for (const block of message.blocks) {
			if (block.type === "tool_use") {
				actions.push(fromToolUse(block.name, block.input, messageIndex))
			} else if (block.type === "text") {
				actions.push(...fromXml(block.text, messageIndex))
			}
		}
	})

	return actions
}

function fromToolUse(tool: string, input: unknown, messageIndex: number): ToolAction {
	const kind = actionKindOf(tool)
	const params = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
	const action: ToolAction = { kind, tool, messageIndex }

	const paths = collectPaths(params)

	if (paths.length > 0) {
		action.paths = paths
	}

	const command = str(params.command)

	if (command) {
		action.command = command
	}

	const text = collectText(kind, params)

	if (text) {
		action.text = text
	}

	return action
}

function collectPaths(params: Record<string, unknown>): string[] {
	const paths: string[] = []

	for (const key of ["file_path", "notebook_path", "path", "filePath"]) {
		const value = str(params[key])

		if (value) {
			paths.push(value)
		}
	}

	// `read_file` batches its targets as an XML fragment in `args`.
	const args = str(params.args)

	if (args) {
		paths.push(...matchAll(args, /<path>([\s\S]*?)<\/path>/g))
	}

	// `apply_patch` carries every target inside the patch envelope.
	const patch = str(params.patch)

	if (patch) {
		paths.push(...matchAll(patch, /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm))
	}

	if (Array.isArray(params.files)) {
		for (const entry of params.files) {
			if (entry && typeof entry === "object") {
				const value = str((entry as Record<string, unknown>).path)

				if (value) {
					paths.push(value)
				}
			}
		}
	}

	return unique(paths)
}

function collectText(kind: ActionKind, params: Record<string, unknown>): string | undefined {
	switch (kind) {
		case "plan":
			return str(params.plan) || undefined
		case "todo":
			return renderTodos(params.todos)
		case "question":
			return renderQuestions(params) || undefined
		case "delegate":
			return (
				[str(params.mode), str(params.description) || str(params.message) || str(params.prompt)]
					.filter(Boolean)
					.join(": ") || undefined
			)
		case "complete":
			return str(params.result) || undefined
		default:
			return undefined
	}
}

function renderTodos(todos: unknown): string | undefined {
	if (typeof todos === "string") {
		return todos.trim() || undefined
	}

	if (!Array.isArray(todos)) {
		return undefined
	}

	const lines = todos
		.map((entry) => {
			if (!entry || typeof entry !== "object") {
				return ""
			}

			const todo = entry as Record<string, unknown>
			const status = str(todo.status)
			const mark = status === "completed" ? "x" : status === "in_progress" ? "-" : " "

			return `- [${mark}] ${str(todo.content)}`
		})
		.filter(Boolean)

	return lines.length > 0 ? lines.join("\n") : undefined
}

function renderQuestions(params: Record<string, unknown>): string {
	const direct = str(params.question)

	if (direct) {
		return direct
	}

	if (!Array.isArray(params.questions)) {
		return ""
	}

	return params.questions
		.map((entry) => (entry && typeof entry === "object" ? str((entry as Record<string, unknown>).question) : ""))
		.filter(Boolean)
		.join("\n")
}

/**
 * Tool calls written as XML inside an assistant text block.
 *
 * Deliberately shallow: the outer tag identifies the tool, and only the
 * parameters a briefing reports (`path`, `command`, `result`, `question`) are
 * pulled out. Nested diff payloads are left alone.
 */
function fromXml(text: string, messageIndex: number): ToolAction[] {
	if (!text.includes("</")) {
		return []
	}

	const actions: ToolAction[] = []

	for (const tool of XML_TOOL_NAMES) {
		const pattern = new RegExp(`<${tool}>([\\s\\S]*?)</${tool}>`, "g")

		for (const body of matchAll(text, pattern)) {
			const kind = actionKindOf(tool)
			const action: ToolAction = { kind, tool, messageIndex }
			const paths = unique([
				...matchAll(body, /<path>([\s\S]*?)<\/path>/g),
				...matchAll(body, /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm),
			])

			if (paths.length > 0) {
				action.paths = paths
			}

			const command = matchAll(body, /<command>([\s\S]*?)<\/command>/g)[0]

			if (command) {
				action.command = command
			}

			const detail =
				matchAll(body, /<result>([\s\S]*?)<\/result>/g)[0] ??
				matchAll(body, /<question>([\s\S]*?)<\/question>/g)[0] ??
				matchAll(body, /<todos>([\s\S]*?)<\/todos>/g)[0] ??
				matchAll(body, /<message>([\s\S]*?)<\/message>/g)[0]

			if (detail) {
				action.text = detail.trim()
			}

			actions.push(action)
		}
	}

	return actions.sort((a, b) => a.tool.localeCompare(b.tool))
}

function matchAll(input: string, pattern: RegExp): string[] {
	const results: string[] = []

	for (const match of input.matchAll(pattern)) {
		const value = match[1]?.trim()

		if (value) {
			results.push(value)
		}
	}

	return results
}

function unique(values: string[]): string[] {
	return values.filter((value, index) => values.indexOf(value) === index)
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : ""
}
