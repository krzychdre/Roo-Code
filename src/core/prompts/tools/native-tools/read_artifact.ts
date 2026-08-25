import type OpenAI from "openai"

/**
 * Native tool definition for read_artifact.
 *
 * This tool retrieves text that was too large to keep in the conversation:
 * the full output of a truncated `execute_command`, and any tool result that
 * exceeded the inline budget and was spilled to an artifact. Both cases quote
 * an artifact_id that this tool reads, searches or paginates through.
 */

const READ_ARTIFACT_DESCRIPTION = `Retrieve the full text of an output that was saved as an artifact instead of being kept inline. Use this tool when:
1. An execute_command result says the output was persisted with an artifact id like "cmd-1706119234567.txt"
2. A tool result starts with "[Tool result: ... saved as artifact "tool-1706119234567.txt" ...]"
3. You need more than the preview showed, or you want to search inside the full text

The tool supports two modes:
- **Read mode**: Read from a byte offset with an optional limit
- **Search mode**: Filter lines matching a regex or literal pattern (like grep)

Parameters:
- artifact_id: (required) The artifact filename quoted in the message that created it (e.g., "cmd-1706119234567.txt" for command output, "tool-1706119234567.txt" for a spilled tool result)
- search: (optional) Pattern to filter lines. Supports regex or literal strings. Case-insensitive. **Omit this parameter entirely if you don't need to filter - do not pass null or empty string.**
- offset: (optional) Byte offset to start reading from. Default: 0. Use for pagination.
- limit: (optional) Maximum bytes to return. Defaults to the inline result budget (24KB) and is capped by it; page with offset for more.

Example: Reading truncated command output
{ "artifact_id": "cmd-1706119234567.txt" }

Example: Reading a spilled tool result
{ "artifact_id": "tool-1706119234567.txt" }

Example: Reading with pagination (after the first window)
{ "artifact_id": "cmd-1706119234567.txt", "offset": 24576 }

Example: Searching for errors in build output
{ "artifact_id": "cmd-1706119234567.txt", "search": "error|failed|Error" }

Example: Finding a match beyond the preview of a spilled search result
{ "artifact_id": "tool-1706119234567.txt", "search": "TODO" }`

const ARTIFACT_ID_DESCRIPTION = `The artifact filename quoted in the message that created it (e.g., "cmd-1706119234567.txt" or "tool-1706119234567.txt")`

const SEARCH_DESCRIPTION = `Optional regex or literal pattern to filter lines (case-insensitive, like grep). Omit this parameter if not searching - do not pass null or empty string.`

const OFFSET_DESCRIPTION = `Byte offset to start reading from (default: 0, for pagination)`

const LIMIT_DESCRIPTION = `Maximum bytes to return (default and cap: the inline result budget, 24KB by default)`

export default {
	type: "function",
	function: {
		name: "read_artifact",
		description: READ_ARTIFACT_DESCRIPTION,
		// Note: strict mode is intentionally disabled for this tool.
		// With strict: true, OpenAI requires ALL properties to be in the 'required' array,
		// which forces the LLM to always provide explicit values (even null) for optional params.
		// This creates verbose tool calls and poor UX. By disabling strict mode, the LLM can
		// omit optional parameters entirely, making the tool easier to use.
		parameters: {
			type: "object",
			properties: {
				artifact_id: {
					type: "string",
					description: ARTIFACT_ID_DESCRIPTION,
				},
				search: {
					type: "string",
					description: SEARCH_DESCRIPTION,
				},
				offset: {
					type: "number",
					description: OFFSET_DESCRIPTION,
				},
				limit: {
					type: "number",
					description: LIMIT_DESCRIPTION,
				},
			},
			required: ["artifact_id"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
