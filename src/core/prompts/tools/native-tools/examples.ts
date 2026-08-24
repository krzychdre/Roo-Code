import type { ToolName } from "@roo-code/types"

/**
 * Minimal correct invocations for every advertised static tool.
 *
 * Weak models (Qwen 27B, GLM, local Llamas) recover from a malformed tool call in one
 * turn when the error text shows them a working call instead of only naming what was
 * wrong. Every corrective message the model receives (missing parameter, unfinalizable
 * native arguments, repetition limit, consecutive-mistake limit) carries the entry from
 * this map, so all of them speak the same vocabulary.
 *
 * The values are plain objects, not strings, and they are embedded as a nested JSON
 * object in the tool result envelope. That matters: a string value would be escaped a
 * second time inside the envelope and the model would have to unescape it before it
 * could copy anything. As objects, they arrive in exactly the wire shape the model has
 * to reproduce in the `arguments` of a native tool call.
 *
 * Each example contains only the parameters the tool schema marks as required (explicit
 * `null` where the schema is `strict` and lists a nullable optional in `required`), and
 * `examples.spec.ts` locks that against schema drift.
 */

/**
 * Tool names that exist in the `ToolName` union but are never advertised to the model
 * under that name, so there is no invocation to teach:
 *
 * - `custom_tool` is only a recording bucket. A custom tool is called by its own
 *   registered name and carries its own schema.
 * - `use_mcp_tool` is never in the advertised tool list either: MCP tools are generated
 *   per server as `mcp--<server>--<tool>` by `getMcpServerTools()`, each with its own
 *   schema.
 *
 * They are excluded by construction rather than filled with a placeholder that a model
 * could copy into a call that would then fail.
 */
export const DYNAMIC_TOOL_NAMES = ["custom_tool", "use_mcp_tool"] as const

export type DynamicToolName = (typeof DYNAMIC_TOOL_NAMES)[number]

/**
 * Tool name that is advertised statically and therefore has a minimal example.
 */
export type StaticToolName = Exclude<ToolName, DynamicToolName>

/**
 * One smallest-valid invocation per statically advertised tool.
 *
 * The `satisfies` clause is the exhaustiveness gate: adding a name to `toolNames`
 * without adding an example here fails `pnpm check-types`.
 */
export const TOOL_MINIMAL_EXAMPLES = {
	access_mcp_resource: { server_name: "my-server", uri: "resource://example" },
	apply_diff: {
		path: "src/app.ts",
		diff: "<<<<<<< SEARCH\n:start_line:12\n-------\nconst a = 1\n=======\nconst a = 2\n>>>>>>> REPLACE",
	},
	apply_patch: {
		patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-const a = 1\n+const a = 2\n*** End Patch",
	},
	ask_followup_question: {
		question: "Which config file should I edit?",
		follow_up: [
			{ text: "./src/config.ts", mode: null },
			{ text: "./config/app.json", mode: null },
		],
	},
	attempt_completion: { result: "Added the retry wrapper to src/api/client.ts." },
	codebase_search: { query: "where is the retry policy configured", path: null },
	edit: { file_path: "src/app.ts", old_string: "const a = 1", new_string: "const a = 2" },
	edit_file: { file_path: "src/app.ts", old_string: "const a = 1", new_string: "const a = 2" },
	execute_command: { command: "npm test", cwd: null, timeout: null },
	generate_image: { prompt: "a red circle on a white background", path: "assets/circle.png", image: null },
	list_files: { path: "src", recursive: false },
	new_task: { mode: "code", message: "Add a retry wrapper to the API client.", todos: null },
	// The id must satisfy ArtifactStore's ARTIFACT_ID_PATTERN (`<kind>-<digits>.txt`,
	// kinds: cmd, tool, prune, fetch), or read_artifact rejects it before it looks.
	read_artifact: { artifact_id: "cmd-1706119234567.txt" },
	read_command_output: { artifact_id: "cmd-1706119234567.txt" },
	read_file: { path: "src/app.ts" },
	run_parallel_tasks: { subtasks: [{ message: "Update the README.", mode: null }], maxConcurrency: null },
	run_slash_command: { command: "init", args: null },
	search_and_replace: { file_path: "src/app.ts", old_string: "const a = 1", new_string: "const a = 2" },
	search_files: { path: "src", regex: "retryPolicy", file_pattern: null },
	search_replace: { file_path: "src/app.ts", old_string: "const a = 1", new_string: "const a = 2" },
	// `create-mode` is named in the skill tool's own parameter description.
	skill: { skill: "create-mode", args: null },
	switch_mode: { mode_slug: "code", reason: "The plan is approved and needs implementing." },
	tools_load: { names: ["web_search"] },
	update_todo_list: { todos: "[x] Read the failing test\n[-] Fix the retry wrapper\n[ ] Run the suite" },
	web_fetch: { url: "https://example.com/docs/quickstart" },
	web_search: { queries: ["vitest mock fs promises"] },
	write_to_file: { path: "src/app.ts", content: "export const a = 1\n" },
} satisfies Record<StaticToolName, Record<string, unknown>>

/**
 * Returns the minimal valid `arguments` object for a tool, or `undefined` when the name
 * is not a statically advertised tool (dynamic MCP tools, custom tools, unknown names).
 *
 * Embed the returned value as a nested object in a JSON envelope. Never `JSON.stringify`
 * it into a string field: that escapes it a second time and the model can no longer copy
 * it verbatim.
 */
export function getToolMinimalExample(toolName: string | undefined): Record<string, unknown> | undefined {
	if (!toolName) {
		return undefined
	}

	return (TOOL_MINIMAL_EXAMPLES as Record<string, Record<string, unknown> | undefined>)[toolName]
}
