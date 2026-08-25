import { Anthropic } from "@anthropic-ai/sdk"

import type { ClineAsk, ToolProgressStatus, ToolGroup, ToolName, GenerateImageParams } from "@roo-code/types"

export type ToolResponse = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>

export type AskApproval = (
	type: ClineAsk,
	partialMessage?: string,
	progressStatus?: ToolProgressStatus,
	forceApproval?: boolean,
) => Promise<boolean>

/**
 * @param toolName Tool the failed call was addressed to. Passed through to
 * `formatResponse.toolError` so a malformed call comes back with that tool's minimal
 * valid invocation as a structured field. Optional: generic failures omit it.
 */
export type HandleError = (action: string, error: Error, toolName?: string) => Promise<void>

export type PushToolResult = (content: ToolResponse) => void

export type AskFinishSubTaskApproval = () => Promise<boolean>

export interface TextContent {
	type: "text"
	content: string
	partial: boolean
}

export const toolParamNames = [
	"command",
	"path",
	"content",
	"regex",
	"file_pattern",
	"recursive",
	"action",
	"url",
	"coordinate",
	"text",
	"server_name",
	"tool_name",
	"arguments",
	"uri",
	"question",
	"result",
	"diff",
	"mode_slug",
	"reason",
	"line",
	"mode",
	"message",
	"cwd",
	"follow_up",
	"task",
	"size",
	"query",
	"args",
	"skill", // skill tool parameter
	"start_line",
	"end_line",
	"todos",
	"prompt",
	"image",
	// read_file parameters (native protocol)
	"operations", // search_and_replace parameter for multiple operations
	"patch", // apply_patch parameter
	"file_path", // search_replace and edit_file parameter
	"old_string", // search_replace and edit_file parameter
	"new_string", // search_replace and edit_file parameter
	"replace_all", // edit tool parameter for replacing all occurrences
	"expected_replacements", // edit_file parameter for multiple occurrences
	"timeout", // execute_command parameter
	"artifact_id", // read_artifact parameter
	"search", // read_artifact parameter for grep-like search
	"offset", // read_artifact and read_file parameter
	"limit", // read_artifact and read_file parameter
	// read_file indentation mode parameters
	"indentation",
	"anchor_line",
	"max_levels",
	"include_siblings",
	"include_header",
	"max_lines",
	// read_file legacy format parameter (backward compatibility)
	"files",
	"line_ranges",
	// web_search parameter (array of 1-4 queries)
	"queries",
	// search_task_history parameter (`query` is already listed above, shared
	// with codebase_search)
	"max_results",
] as const

export type ToolParamName = (typeof toolParamNames)[number]

/**
 * Type map defining the native (typed) argument structure for each tool.
 * Tools not listed here will fall back to `any` for backward compatibility.
 */
export type NativeToolArgs = {
	access_mcp_resource: { server_name: string; uri: string }
	read_file: import("@roo-code/types").ReadFileToolParams
	read_artifact: { artifact_id: string; search?: string; offset?: number; limit?: number }
	read_command_output: { artifact_id: string; search?: string; offset?: number; limit?: number }
	attempt_completion: { result: string }
	execute_command: { command: string; cwd?: string; timeout?: number | null }
	apply_diff: { path: string; diff: string }
	edit: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }
	search_and_replace: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }
	search_replace: { file_path: string; old_string: string; new_string: string }
	edit_file: { file_path: string; old_string: string; new_string: string; expected_replacements?: number }
	apply_patch: { patch: string }
	list_files: { path: string; recursive?: boolean }
	new_task: { mode: string; message: string; todos?: string }
	run_parallel_tasks: {
		subtasks: Array<{ message: string; mode?: string | null }>
		maxConcurrency?: number | null
	}
	ask_followup_question: {
		question: string
		follow_up: Array<{ text: string; mode?: string }>
	}
	codebase_search: { query: string; path?: string }
	generate_image: GenerateImageParams
	run_slash_command: { command: string; args?: string }
	skill: { skill: string; args?: string }
	search_files: { path: string; regex: string; file_pattern?: string | null }
	search_task_history: { query: string; max_results?: number }
	switch_mode: { mode_slug: string; reason: string }
	update_todo_list: { todos: string }
	use_mcp_tool: { server_name: string; tool_name: string; arguments?: Record<string, unknown> }
	write_to_file: { path: string; content: string }
	tools_load: { names: string[] }
	web_search: { queries: string[] }
	web_fetch: { url: string }
	// Add more tools as they are migrated to native protocol
}

/**
 * Generic ToolUse interface that provides proper typing for both protocols.
 *
 * @template TName - The specific tool name, which determines the nativeArgs type
 */
export interface ToolUse<TName extends ToolName = ToolName> {
	type: "tool_use"
	id?: string // Optional ID to track tool calls
	name: TName
	/**
	 * The original tool name as called by the model (e.g. an alias like "edit_file"),
	 * if it differs from the canonical tool name used for execution.
	 * Used to preserve tool names in API conversation history.
	 */
	originalName?: string
	// params is a partial record, allowing only some or none of the possible parameters to be used
	params: Partial<Record<ToolParamName, string>>
	partial: boolean
	// nativeArgs is properly typed based on TName if it's in NativeToolArgs, otherwise never
	nativeArgs?: TName extends keyof NativeToolArgs ? NativeToolArgs[TName] : never
	/**
	 * Flag indicating whether the tool call used a legacy/deprecated format.
	 * Used for telemetry tracking to monitor migration from old formats.
	 */
	usedLegacyFormat?: boolean
}

/**
 * Represents a native MCP tool call from the model.
 * In native mode, MCP tools are called directly with their prefixed name (e.g., "mcp_serverName_toolName")
 * rather than through the use_mcp_tool wrapper. This type preserves the original tool name
 * so it appears correctly in API conversation history.
 */
export interface McpToolUse {
	type: "mcp_tool_use"
	id?: string // Tool call ID from the API
	/** The original tool name from the API (e.g., "mcp_serverName_toolName") */
	name: string
	/** Extracted server name from the tool name */
	serverName: string
	/** Extracted tool name from the tool name */
	toolName: string
	/** Arguments passed to the MCP tool */
	arguments: Record<string, unknown>
	partial: boolean
}

export interface ExecuteCommandToolUse extends ToolUse<"execute_command"> {
	name: "execute_command"
	// Pick<Record<ToolParamName, string>, "command"> makes "command" required, but Partial<> makes it optional
	params: Partial<Pick<Record<ToolParamName, string>, "command" | "cwd" | "timeout">>
}

export interface ReadFileToolUse extends ToolUse<"read_file"> {
	name: "read_file"
	params: Partial<
		Pick<
			Record<ToolParamName, string>,
			| "args"
			| "path"
			| "start_line"
			| "end_line"
			| "mode"
			| "offset"
			| "limit"
			| "indentation"
			| "anchor_line"
			| "max_levels"
			| "include_siblings"
			| "include_header"
		>
	>
}

export interface WriteToFileToolUse extends ToolUse<"write_to_file"> {
	name: "write_to_file"
	params: Partial<Pick<Record<ToolParamName, string>, "path" | "content">>
}

export interface CodebaseSearchToolUse extends ToolUse<"codebase_search"> {
	name: "codebase_search"
	params: Partial<Pick<Record<ToolParamName, string>, "query" | "path">>
}

export interface SearchFilesToolUse extends ToolUse<"search_files"> {
	name: "search_files"
	params: Partial<Pick<Record<ToolParamName, string>, "path" | "regex" | "file_pattern">>
}

export interface ListFilesToolUse extends ToolUse<"list_files"> {
	name: "list_files"
	params: Partial<Pick<Record<ToolParamName, string>, "path" | "recursive">>
}

export interface UseMcpToolToolUse extends ToolUse<"use_mcp_tool"> {
	name: "use_mcp_tool"
	params: Partial<Pick<Record<ToolParamName, string>, "server_name" | "tool_name" | "arguments">>
}

export interface AccessMcpResourceToolUse extends ToolUse<"access_mcp_resource"> {
	name: "access_mcp_resource"
	params: Partial<Pick<Record<ToolParamName, string>, "server_name" | "uri">>
}

export interface AskFollowupQuestionToolUse extends ToolUse<"ask_followup_question"> {
	name: "ask_followup_question"
	params: Partial<Pick<Record<ToolParamName, string>, "question" | "follow_up">>
}

export interface AttemptCompletionToolUse extends ToolUse<"attempt_completion"> {
	name: "attempt_completion"
	params: Partial<Pick<Record<ToolParamName, string>, "result">>
}

export interface SwitchModeToolUse extends ToolUse<"switch_mode"> {
	name: "switch_mode"
	params: Partial<Pick<Record<ToolParamName, string>, "mode_slug" | "reason">>
}

export interface NewTaskToolUse extends ToolUse<"new_task"> {
	name: "new_task"
	params: Partial<Pick<Record<ToolParamName, string>, "mode" | "message" | "todos">>
}

export interface RunSlashCommandToolUse extends ToolUse<"run_slash_command"> {
	name: "run_slash_command"
	params: Partial<Pick<Record<ToolParamName, string>, "command" | "args">>
}

export interface SkillToolUse extends ToolUse<"skill"> {
	name: "skill"
	params: Partial<Pick<Record<ToolParamName, string>, "skill" | "args">>
}

export interface GenerateImageToolUse extends ToolUse<"generate_image"> {
	name: "generate_image"
	params: Partial<Pick<Record<ToolParamName, string>, "prompt" | "path" | "image">>
}

// Define tool group configuration
export type ToolGroupConfig = {
	tools: readonly string[]
	alwaysAvailable?: boolean // Whether this group is always available and shouldn't show in prompts view
	customTools?: readonly string[] // Opt-in only tools - only available when explicitly included via model's includedTools
}

export const TOOL_DISPLAY_NAMES: Record<ToolName, string> = {
	execute_command: "run commands",
	read_file: "read files",
	read_artifact: "read artifacts",
	read_command_output: "read artifacts",
	write_to_file: "write files",
	apply_diff: "apply changes",
	edit: "edit files",
	search_and_replace: "apply changes using search and replace",
	search_replace: "apply single search and replace",
	edit_file: "edit files using search and replace",
	apply_patch: "apply patches using codex format",
	search_files: "search files",
	search_task_history: "search this task's history",
	list_files: "list files",
	use_mcp_tool: "use mcp tools",
	access_mcp_resource: "access mcp resources",
	ask_followup_question: "ask questions",
	attempt_completion: "complete tasks",
	switch_mode: "switch modes",
	new_task: "create new task",
	run_parallel_tasks: "run parallel tasks",
	codebase_search: "codebase search",
	update_todo_list: "update todo list",
	run_slash_command: "run slash command",
	skill: "load skill",
	generate_image: "generate images",
	custom_tool: "use custom tools",
	tools_load: "load deferred tool schemas",
	web_search: "search the web",
	web_fetch: "fetch web pages",
} as const

// Define available tool groups.
export const TOOL_GROUPS: Record<ToolGroup, ToolGroupConfig> = {
	read: {
		// `search_task_history` reads the task's OWN stored conversation, not
		// the workspace, so it carries no file-access risk beyond what the user
		// already saw. It lives in `read` (rather than `command`, next to
		// read_artifact) so every read-capable mode, including the md-only
		// ones, can recover a detail that condense or the pruner took away.
		tools: ["read_file", "search_files", "list_files", "codebase_search", "search_task_history"],
	},
	edit: {
		tools: ["apply_diff", "write_to_file", "generate_image"],
		customTools: ["edit", "search_replace", "edit_file", "apply_patch"],
	},
	command: {
		tools: ["execute_command", "read_artifact"],
	},
	mcp: {
		tools: ["use_mcp_tool", "access_mcp_resource"],
	},
	modes: {
		tools: ["switch_mode", "new_task", "run_parallel_tasks"],
		alwaysAvailable: true,
	},
	// Gated by the global `webToolsEnabled` setting: when it is off the group
	// resolves to no tools at all, so builds with the feature disabled produce
	// byte-identical prompts and tool arrays.
	web: {
		tools: ["web_search", "web_fetch"],
	},
}

// Tools that are always available to all modes.
export const ALWAYS_AVAILABLE_TOOLS: ToolName[] = [
	"ask_followup_question",
	"attempt_completion",
	"switch_mode",
	"new_task",
	"update_todo_list",
	"run_slash_command",
	"skill",
	"tools_load",
	"run_parallel_tasks",
] as const

/**
 * Tools whose result is protocol or instructions, not data.
 *
 * These results are consumed by the task machinery or steer the next turn
 * (a skill body, a loaded schema, a slash-command expansion, a mode switch
 * acknowledgement). Shrinking or clearing one changes behaviour rather than
 * saving context, so every context-reduction pass has to leave them alone.
 *
 * Single source of truth for two policies that would otherwise drift:
 * - `SPILL_BYPASS_TOOLS` (`src/core/artifacts/spillPolicy.ts`) never spills them,
 * - `COMPACTABLE_TOOL_NAMES` (`src/core/context-management/microcompact.ts`)
 *   never clears them (it is an allowlist, so they are simply absent from it).
 *
 * A unit test asserts both invariants against this list.
 */
export const PROTOCOL_TOOL_NAMES: readonly string[] = [
	"attempt_completion",
	"ask_followup_question",
	"update_todo_list",
	"switch_mode",
	"new_task",
	"run_parallel_tasks",
	"skill",
	"run_slash_command",
	"tools_load",
	"generate_image",
] as const

/**
 * Central registry of tool aliases.
 * Maps alias name -> canonical tool name.
 *
 * This allows models to use alternative names for tools (e.g., "edit_file" instead of "apply_diff").
 * When a model calls a tool by its alias, the system resolves it to the canonical name for execution,
 * but preserves the alias in API conversation history for consistency.
 *
 * To add a new alias, simply add an entry here. No other files need to be modified.
 */
export const TOOL_ALIASES: Record<string, ToolName> = {
	write_file: "write_to_file",
	search_and_replace: "edit",
	// `read_artifact` generalizes the old command-output-only tool. The old
	// name stays dispatchable so histories written before the rename, and
	// models that learned the old habit, still reach the implementation.
	read_command_output: "read_artifact",
} as const

export type DiffResult =
	| { success: true; content: string; failParts?: DiffResult[] }
	| ({
			success: false
			error?: string
			details?: {
				similarity?: number
				threshold?: number
				matchedRange?: { start: number; end: number }
				searchContent?: string
				bestMatch?: string
			}
			failParts?: DiffResult[]
	  } & ({ error: string } | { failParts: DiffResult[] }))

export interface DiffItem {
	content: string
	startLine?: number
}

export interface DiffStrategy {
	/**
	 * Get the name of this diff strategy for analytics and debugging
	 * @returns The name of the diff strategy
	 */
	getName(): string

	/**
	 * Apply a diff to the original content
	 * @param originalContent The original file content
	 * @param diffContent The diff content in the strategy's format (string for legacy, DiffItem[] for new)
	 * @param startLine Optional line number where the search block starts. If not provided, searches the entire file.
	 * @param endLine Optional line number where the search block ends. If not provided, searches the entire file.
	 * @returns A DiffResult object containing either the successful result or error details
	 */
	applyDiff(
		originalContent: string,
		diffContent: string | DiffItem[],
		startLine?: number,
		endLine?: number,
	): Promise<DiffResult>

	getProgressStatus?(toolUse: ToolUse, result?: any): ToolProgressStatus
}
