import type OpenAI from "openai"

/**
 * Native tool definition for search_task_history.
 *
 * Searches the stored history of the CURRENT task, including the turns that
 * condense summarised away and the tool results the pruner moved to artifact
 * files. The description spells out the regex-with-literal-fallback rule in
 * plain words, because a small model that reads "regex" will otherwise either
 * escape everything or send a broken pattern and lose a turn to the error.
 */

const SEARCH_TASK_HISTORY_DESCRIPTION = `Search everything that has been said in THIS task, including older turns that are no longer visible in the conversation. Long tasks are summarised and trimmed to save space; this tool reads the full stored copy on disk, so it can find text that has scrolled out of your context.

Rules:
- Use this when you need a detail from earlier in this task (a file path, a number, an error message, a decision) and you cannot see it anymore.
- Prefer this over asking the user again. If it was said in this task, search for it first; only ask the user when the search finds nothing.
- The query is used as a regular expression when it is a valid one, and as plain text when it is not. Either way the search ignores upper/lower case. You never have to escape anything: if your pattern does not compile, it is searched for literally instead of failing.
- You may write the pattern as /pattern/ or /pattern/i, with the slashes; they are removed for you. The extra flags m, s and u are accepted.
- Avoid a repeat inside another repeat, such as (a+)+ or (.*)*. Such a pattern is searched for as plain text instead, because it can take minutes to run. Very long lines are matched on their first 2000 characters only.
- This searches the conversation only. To search the project's files use search_files, and to read one saved output use read_artifact.
- Your own earlier searches are never found again, so repeating a search does not pile up its own results.

Parameters:
- query: (required) The text or pattern to look for. Short and distinctive works best, for example an identifier, a file name, or an error code.
- max_results: (optional) How many matches to return. Default 10, maximum 50. Matches are returned with 2 lines of surrounding context each.

Example: Finding a decision made earlier
{ "query": "we decided to use" }

Example: Finding an identifier that scrolled out of context
{ "query": "resolveMaxInlineToolResultBytes" }

Example: Two spellings at once, with a larger budget
{ "query": "timeout|timed out", "max_results": 20 }`

const QUERY_PARAMETER_DESCRIPTION = `Text or regular expression to look for in this task's own history. Case-insensitive. An invalid pattern is searched for as plain text instead of failing.`

const MAX_RESULTS_PARAMETER_DESCRIPTION = `How many matches to return (default 10, maximum 50).`

export default {
	type: "function",
	function: {
		name: "search_task_history",
		description: SEARCH_TASK_HISTORY_DESCRIPTION,
		// Note: strict mode is intentionally disabled, matching read_artifact.
		// With strict: true every property must be listed in `required`, which
		// forces a weak model to send an explicit value (or null) for
		// max_results on every call.
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: QUERY_PARAMETER_DESCRIPTION,
				},
				max_results: {
					type: "number",
					description: MAX_RESULTS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
