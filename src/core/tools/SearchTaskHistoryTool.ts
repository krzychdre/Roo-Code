import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { getTaskDirectoryPath } from "../../utils/storage"
import { readApiMessages } from "../task-persistence/apiMessages"
import {
	HISTORY_SEARCH_DEFAULTS,
	clampMaxResults,
	readTaskArtifacts,
	searchTaskHistoryCorpus,
} from "../task/searchTaskHistory"

import { BaseTool, ToolCallbacks } from "./BaseTool"

/**
 * Parameters accepted by the search_task_history tool.
 */
interface SearchTaskHistoryParams {
	/**
	 * Text to look for. Compiled as a case-insensitive JavaScript regular
	 * expression when it compiles, used as case-insensitive literal text when
	 * it does not.
	 */
	query: string
	/** How many matches to return (default 10, hard cap 50). */
	max_results?: number
}

/**
 * SearchTaskHistoryTool lets the model search the CURRENT task's own history,
 * including everything that has already left the live context.
 *
 * ## What it searches, and why both halves are needed
 *
 * - `api_conversation_history.json`, the persisted message file. Condense is
 *   non-destructive on disk (it tags the older prefix with `condenseParent`
 *   and keeps the messages), so text the model can no longer see after a
 *   condense is still in this file verbatim.
 * - the task's artifact files (`command-output/cmd-*.txt` and
 *   `artifacts/{tool,prune,fetch}-*.txt`). The pruner and the spill policy MOVE
 *   text out of the messages and write the replacement back to the same
 *   persisted file, so the middle of a pruned tool result exists ONLY in its
 *   artifact.
 *
 * Searching one without the other would leave a hole exactly where the model is
 * most likely to be missing something.
 *
 * ## Result handling
 *
 * The result is pushed like any other tool result, which means it passes
 * through the tool-result spill policy. A search that returns more than the
 * inline budget therefore spills to an artifact of its own, and the model reads
 * the rest with `read_artifact`. That is intentional: this tool must not be a
 * hole in the context budget it exists to work around.
 *
 * ## Approval
 *
 * Read-only over the task's own storage, so it follows `read_artifact` and runs
 * without an approval round trip. There is nothing here the user has not
 * already seen: it is their own conversation.
 */
export class SearchTaskHistoryTool extends BaseTool<"search_task_history"> {
	readonly name = "search_task_history" as const

	async execute(params: SearchTaskHistoryParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks

		const query = typeof params?.query === "string" ? params.query : ""

		if (query.trim().length === 0) {
			task.consecutiveMistakeCount++
			task.recordToolError("search_task_history")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("search_task_history", "query"))
			return
		}

		const maxResults = clampMaxResults(
			typeof params?.max_results === "number" ? params.max_results : HISTORY_SEARCH_DEFAULTS.DEFAULT_MAX_RESULTS,
		)

		try {
			const provider = task.providerRef.deref()
			const globalStoragePath = provider?.context?.globalStorageUri?.fsPath

			if (!globalStoragePath) {
				const errorMsg =
					"search_task_history cannot reach the task storage on this machine; continue without the older history or ask the user."
				await task.say("error", errorMsg)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(errorMsg))
				return
			}

			const [messages, artifacts] = await Promise.all([
				readApiMessages({ taskId: task.taskId, globalStoragePath }),
				getTaskDirectoryPath(globalStoragePath, task.taskId).then((taskDir) => readTaskArtifacts(taskDir)),
			])

			const { text, timedOut } = searchTaskHistoryCorpus({ messages, artifacts, query, maxResults })

			await task.say(
				"tool",
				JSON.stringify({
					tool: "searchTaskHistory",
					query,
					totalBytes: Buffer.byteLength(text, "utf8"),
				}),
			)

			// A scan stopped by its wall-clock budget produced no answer, only an
			// explanation. It goes back as a tool ERROR so the turn's failure
			// bookkeeping (and the teaching example) treats it like any other
			// unusable call, instead of letting the model read a partial result
			// as a complete one.
			if (timedOut) {
				task.consecutiveMistakeCount++
				task.recordToolError("search_task_history")
				task.didToolFailInCurrentTurn = true
				await task.say("error", text)
				pushToolResult(formatResponse.toolError(text, "search_task_history"))
				return
			}

			task.consecutiveMistakeCount = 0
			pushToolResult(text)
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			const errorMsg = `search_task_history failed: ${detail}; continue without the older history or ask the user for the missing detail.`
			await task.say("error", errorMsg)
			task.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(errorMsg, this.name))
		}
	}
}

/** Singleton instance of the SearchTaskHistoryTool */
export const searchTaskHistoryTool = new SearchTaskHistoryTool()
