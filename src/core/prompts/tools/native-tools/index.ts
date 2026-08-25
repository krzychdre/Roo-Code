import type OpenAI from "openai"
import accessMcpResource from "./access_mcp_resource"
import { apply_diff } from "./apply_diff"
import applyPatch from "./apply_patch"
import askFollowupQuestion from "./ask_followup_question"
import attemptCompletion from "./attempt_completion"
import codebaseSearch from "./codebase_search"
import editTool from "./edit"
import executeCommand from "./execute_command"
import generateImage from "./generate_image"
import listFiles from "./list_files"
import newTask from "./new_task"
import readArtifact from "./read_artifact"
import { createReadFileTool, type ReadFileToolOptions } from "./read_file"
import runParallelTasks from "./run_parallel_tasks"
import runSlashCommand from "./run_slash_command"
import skill from "./skill"
import searchReplace from "./search_replace"
import edit_file from "./edit_file"
import searchFiles from "./search_files"
import searchTaskHistory from "./search_task_history"
import switchMode from "./switch_mode"
import toolsLoad from "./tools_load"
import updateTodoList from "./update_todo_list"
import webFetch from "./web_fetch"
import webSearch from "./web_search"
import writeToFile from "./write_to_file"

export { getMcpServerTools } from "./mcp_server"
export { convertOpenAIToolToAnthropic, convertOpenAIToolsToAnthropic } from "./converters"
export type { ReadFileToolOptions } from "./read_file"

/**
 * Options for customizing the native tools array.
 */
export interface NativeToolsOptions {
	/** Whether the model supports image processing (default: false) */
	supportsImages?: boolean
}

/**
 * Get native tools array, optionally customizing based on settings.
 *
 * @param options - Configuration options for the tools
 * @returns Array of native tool definitions
 */
export function getNativeTools(options: NativeToolsOptions = {}): OpenAI.Chat.ChatCompletionTool[] {
	const { supportsImages = false } = options

	const readFileOptions: ReadFileToolOptions = {
		supportsImages,
	}

	return [
		accessMcpResource,
		apply_diff,
		applyPatch,
		askFollowupQuestion,
		attemptCompletion,
		codebaseSearch,
		executeCommand,
		generateImage,
		listFiles,
		newTask,
		readArtifact,
		createReadFileTool(readFileOptions),
		runParallelTasks,
		runSlashCommand,
		skill,
		searchReplace,
		edit_file,
		editTool,
		searchFiles,
		switchMode,
		toolsLoad,
		updateTodoList,
		webFetch,
		webSearch,
		writeToFile,
		// Appended at the tail on purpose (WS-F prefix-stability contract): the
		// tools array is part of the cached request prefix, so a new schema
		// inserted in the middle would move every schema after it and cost
		// existing users their tool-array cache hit. New tools go last.
		searchTaskHistory,
	] satisfies OpenAI.Chat.ChatCompletionTool[]
}

// Backward compatibility: export default tools with line ranges enabled
export const nativeTools = getNativeTools()
