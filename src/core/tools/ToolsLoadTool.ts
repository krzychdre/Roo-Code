import type OpenAI from "openai"

import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { ALWAYS_AVAILABLE_TOOLS } from "../../shared/tools"

interface ToolsLoadParams {
	names: string[]
}

interface LoadedToolPayload {
	name: string
	description: string
	parameters: unknown
}

interface ToolsLoadResult {
	loaded: LoadedToolPayload[]
	already_active: string[]
	unknown: string[]
}

const ALWAYS_LOAD_SET: ReadonlySet<string> = new Set(ALWAYS_AVAILABLE_TOOLS)

const MAX_GUIDANCE_NAMES = 30

/**
 * Meta-tool: resolves deferred tool names back into their full
 * `{name, description, parameters}` schemas and marks them as materialized
 * on the current Task so subsequent turns include them in the active tools
 * array.
 *
 * This is Roo Code's userland port of Claude Code's `ToolSearch` tool.
 * See `ai_plans/deferred-tool-loading.md` §2 for the design contract and
 * §8 (Hardening for weak models) for the tolerance layer below.
 */
export class ToolsLoadTool extends BaseTool<"tools_load"> {
	readonly name = "tools_load" as const

	/**
	 * Override the BaseTool entry point so the generic `nativeArgs === undefined`
	 * branch (which `throw`s and reports a parse error) no longer fires for
	 * `tools_load`. Weak tool-calling models routinely emit `tools_load` with
	 * no `input` field; we convert each known degenerate shape into a
	 * structured guidance tool-result instead of an error, so the model can
	 * recover on the next turn.
	 *
	 * Tolerated shapes:
	 *   - no `nativeArgs` at all          → guidance with the current list + example
	 *   - `{}`                            → guidance with the current list + example
	 *   - `{ names: "single_string" }`    → coerced to `["single_string"]`
	 *   - `{ name: "foo" }` (singular)    → coerced to `{ names: ["foo"] }`
	 *   - `{ names: [] }`                 → guidance (covered in execute())
	 *
	 * Partial blocks are still handed off to BaseTool's default no-op handler.
	 */
	override async handle(task: Task, block: ToolUse<"tools_load">, callbacks: ToolCallbacks): Promise<void> {
		if (block.partial) {
			// Inherit BaseTool's partial-handling path (no-op for tools_load).
			return super.handle(task, block, callbacks)
		}

		const coerced = coerceToolsLoadArgs(block.nativeArgs)
		await this.execute(coerced, task, callbacks)
	}

	async execute(params: ToolsLoadParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks

		try {
			const names = Array.isArray(params?.names) ? params.names : []

			if (names.length === 0) {
				// Guidance — NOT an error. Do NOT increment the mistake counter:
				// the model can recover on the next turn with a correct call.
				pushToolResult(buildMissingNamesGuidance(task))
				return
			}

			const directory = task.deferredToolDirectory
			const materialized = task.materializedDeferredTools

			const result: ToolsLoadResult = {
				loaded: [],
				already_active: [],
				unknown: [],
			}

			for (const rawName of names) {
				const name = typeof rawName === "string" ? rawName.trim() : ""
				if (!name) {
					continue
				}

				// Already materialized on this Task or part of the always-load set?
				if (ALWAYS_LOAD_SET.has(name) || materialized?.has(name)) {
					result.already_active.push(name)
					continue
				}

				const entry = directory?.get(name)
				if (!entry) {
					result.unknown.push(name)
					continue
				}

				const fn = (entry as OpenAI.Chat.ChatCompletionFunctionTool).function
				result.loaded.push({
					name: fn.name,
					description: fn.description ?? "",
					parameters: fn.parameters ?? { type: "object", properties: {} },
				})
				materialized?.add(name)
			}

			task.consecutiveMistakeCount = 0
			pushToolResult(formatToolsLoadResult(result))
		} catch (error) {
			await handleError(
				"executing tools_load",
				error instanceof Error ? error : new Error(String(error)),
				this.name,
			)
		}
	}
}

/**
 * Normalise the wide variety of malformed `nativeArgs` shapes weak models
 * emit into the canonical `{ names: string[] }` form. Unknown shapes pass
 * through with `names: []` so `execute()` falls into the guidance path.
 */
export function coerceToolsLoadArgs(rawArgs: unknown): ToolsLoadParams {
	if (rawArgs == null || typeof rawArgs !== "object") {
		return { names: [] }
	}
	const obj = rawArgs as Record<string, unknown>

	// Canonical shape: { names: string[] }
	if (Array.isArray(obj.names)) {
		const filtered = obj.names.filter((n): n is string => typeof n === "string")
		return { names: filtered }
	}

	// Degenerate: { names: "single_string" }
	if (typeof obj.names === "string") {
		const trimmed = obj.names.trim()
		return { names: trimmed ? [trimmed] : [] }
	}

	// Degenerate: { name: "foo" } (singular, common in weak models)
	if (typeof obj.name === "string") {
		const trimmed = obj.name.trim()
		return { names: trimmed ? [trimmed] : [] }
	}

	// Degenerate: { name: ["foo", "bar"] } (singular plural)
	if (Array.isArray(obj.name)) {
		const filtered = obj.name.filter((n): n is string => typeof n === "string")
		return { names: filtered }
	}

	return { names: [] }
}

/**
 * Build a guidance tool-result for the model. Contains:
 *  - a clear "names is required" message
 *  - the current deferred-tool list (capped to avoid blowing context)
 *  - a literal JSON example mirroring the one in the system prompt
 *
 * Calls into the Task to pull the current deferred-tool directory so the
 * example is grounded in this user's actual installation.
 */
function buildMissingNamesGuidance(task: Task): string {
	const directory = task.deferredToolDirectory
	const allNames = directory ? Array.from(directory.keys()) : []
	const exampleNames = allNames.slice(0, 2)
	const examplePayload =
		exampleNames.length > 0
			? `{"names": [${exampleNames.map((n) => `"${n}"`).join(", ")}]}`
			: `{"names": ["<deferred_tool_name>"]}`
	const exampleCall = `tools_load(${examplePayload})`

	const lines: string[] = []
	lines.push(
		"You called `tools_load` but did not pass `names`. " +
			"`names` MUST be a non-empty array of strings — one entry per deferred " +
			"tool you want to materialize.",
	)
	lines.push("")
	lines.push("Worked example (copy this shape verbatim):")
	lines.push(`    ${exampleCall}`)
	lines.push("")

	if (allNames.length === 0) {
		lines.push("There are currently no deferred tools to load.")
	} else {
		const shown = allNames.slice(0, MAX_GUIDANCE_NAMES)
		lines.push(
			`Currently deferred tool names (${allNames.length} total${allNames.length > shown.length ? `, showing first ${shown.length}` : ""}):`,
		)
		for (const name of shown) {
			lines.push(`  - "${name}"`)
		}
	}

	return lines.join("\n")
}

/**
 * Render the result as a single text block. We use a JSON-with-prelude shape
 * because the model has strong priors on JSON: the prelude is a one-liner
 * telling it what to do next, and the JSON block is the structured payload.
 */
function formatToolsLoadResult(result: ToolsLoadResult): string {
	const lines: string[] = []
	if (result.loaded.length > 0) {
		lines.push(
			`Loaded ${result.loaded.length} tool schema${result.loaded.length === 1 ? "" : "s"}. ` +
				"They are now callable directly on the next turn.",
		)
	}
	if (result.already_active.length > 0) {
		lines.push(
			`${result.already_active.length} tool${result.already_active.length === 1 ? " was" : "s were"} already active — no need to re-load.`,
		)
	}
	if (result.unknown.length > 0) {
		lines.push(
			`Unknown tool name${result.unknown.length === 1 ? "" : "s"}: ${result.unknown.join(", ")}. ` +
				"Check the spelling against the Deferred tools section of the system prompt.",
		)
	}
	if (lines.length === 0) {
		lines.push("No tools resolved.")
	}
	lines.push("```json")
	lines.push(JSON.stringify(result, null, 2))
	lines.push("```")
	return lines.join("\n")
}

export const toolsLoadTool = new ToolsLoadTool()
