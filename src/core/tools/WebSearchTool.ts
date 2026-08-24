import { resolveWebToolsConfig, WEB_TOOLS_DEFAULTS } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"
import {
	createSearchBackend,
	formatSearchResults,
	WebSearchError,
	WebSearchService,
	type WebSearchBackendClient,
} from "../../services/web/WebSearchService"

import { BaseTool, ToolCallbacks } from "./BaseTool"

/**
 * Parameters accepted by the web_search tool.
 */
interface WebSearchParams {
	/** 1 to 4 search queries, run in one call so a weak model gets breadth per turn. */
	queries: string[]
}

/**
 * WebSearchTool queries the configured search backend (SearXNG in v1) and
 * returns `title / url / snippet` blocks per query.
 *
 * Every failure path is a tool error carrying corrective text: the tool never
 * throws out of `execute` and never ends the turn, so a backend outage costs
 * the model one turn instead of the task.
 */
export class WebSearchTool extends BaseTool<"web_search"> {
	readonly name = "web_search" as const

	async execute(params: WebSearchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, pushToolResult, toolCallId } = callbacks

		const queries = Array.isArray(params?.queries) ? params.queries.filter((q) => typeof q === "string") : []

		if (queries.length === 0) {
			task.consecutiveMistakeCount++
			task.recordToolError("web_search")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("web_search", "queries"))
			return
		}

		const effectiveQueries = queries.slice(0, WEB_TOOLS_DEFAULTS.MAX_QUERIES_PER_CALL)

		// Configuration is validated BEFORE asking for approval: there is no
		// point making the user approve a search that would instantly error.
		const state = await task.providerRef.deref()?.getState()
		const config = resolveWebToolsConfig(state)

		if (!config.enabled) {
			task.consecutiveMistakeCount++
			task.recordToolError("web_search")
			task.didToolFailInCurrentTurn = true
			pushToolResult(
				formatResponse.toolError(
					"web_search is disabled; ask the user to enable web tools in Settings > Web tools, or continue without web data",
				),
			)
			return
		}

		let backend: WebSearchBackendClient
		try {
			backend = createSearchBackend(config)
		} catch (error) {
			task.consecutiveMistakeCount++
			task.recordToolError("web_search")
			task.didToolFailInCurrentTurn = true

			const message = error instanceof WebSearchError ? error.message : String(error)
			await task.say("error", message)
			pushToolResult(formatResponse.toolError(message))
			return
		}

		const didApprove = await askApproval(
			"tool",
			JSON.stringify({
				tool: "webSearch",
				queries: effectiveQueries,
				isOutsideWorkspace: false,
				toolCallId,
			}),
		)

		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return
		}

		try {
			const blocks = await new WebSearchService(backend, config).search(effectiveQueries)

			task.consecutiveMistakeCount = 0
			pushToolResult(formatSearchResults(blocks))
		} catch (error) {
			task.consecutiveMistakeCount++
			task.recordToolError("web_search")
			task.didToolFailInCurrentTurn = true

			const message =
				error instanceof WebSearchError
					? error.message
					: `web_search failed: ${error instanceof Error ? error.message : String(error)}; tell the user or continue without web data`

			await task.say("error", message)
			pushToolResult(formatResponse.toolError(message))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"web_search">): Promise<void> {
		const queries = block.nativeArgs?.queries

		await task
			.ask(
				"tool",
				JSON.stringify({
					tool: "webSearch",
					queries: Array.isArray(queries) ? queries : [],
					isOutsideWorkspace: false,
					toolCallId: block.id,
				}),
				block.partial,
			)
			.catch(() => {})
	}
}

export const webSearchTool = new WebSearchTool()
