import { resolveWebToolsConfig } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"
import { WebFetchError, WebFetchService } from "../../services/web/WebFetchService"

import { BaseTool, ToolCallbacks } from "./BaseTool"

/**
 * Parameters accepted by the web_fetch tool.
 */
interface WebFetchParams {
	/** Absolute http(s) URL of the page to read. */
	url: string
}

/**
 * WebFetchTool fetches one page server-side, converts it to markdown and
 * returns the text, truncated to the configured byte budget.
 *
 * Like `web_search`, every failure is a tool error with corrective text rather
 * than an exception, so a dead link never ends the turn.
 */
export class WebFetchTool extends BaseTool<"web_fetch"> {
	readonly name = "web_fetch" as const

	async execute(params: WebFetchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, pushToolResult, toolCallId } = callbacks
		const url = typeof params?.url === "string" ? params.url.trim() : ""

		if (!url) {
			task.consecutiveMistakeCount++
			task.recordToolError("web_fetch")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("web_fetch", "url"))
			return
		}

		// Configuration is validated BEFORE asking for approval: there is no
		// point making the user approve a fetch that would instantly error.
		const state = await task.providerRef.deref()?.getState()
		const config = resolveWebToolsConfig(state)

		if (!config.enabled) {
			task.consecutiveMistakeCount++
			task.recordToolError("web_fetch")
			task.didToolFailInCurrentTurn = true
			pushToolResult(
				formatResponse.toolError(
					"web_fetch is disabled; ask the user to enable web tools in Settings > Web tools, or continue without the page contents",
				),
			)
			return
		}

		const didApprove = await askApproval(
			"tool",
			JSON.stringify({
				tool: "webFetch",
				fetchedUrl: url,
				isOutsideWorkspace: false,
				toolCallId,
			}),
		)

		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return
		}

		try {
			const result = await new WebFetchService(config).fetch(url)

			task.consecutiveMistakeCount = 0
			pushToolResult(`Fetched ${result.url}\n\n${result.markdown}`)
		} catch (error) {
			task.consecutiveMistakeCount++
			task.recordToolError("web_fetch")
			task.didToolFailInCurrentTurn = true

			const message =
				error instanceof WebFetchError
					? error.message
					: `web_fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}; tell the user or continue without the page contents`

			await task.say("error", message)
			pushToolResult(formatResponse.toolError(message, this.name))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"web_fetch">): Promise<void> {
		const url = block.nativeArgs?.url

		await task
			.ask(
				"tool",
				JSON.stringify({
					tool: "webFetch",
					fetchedUrl: typeof url === "string" ? url : "",
					isOutsideWorkspace: false,
					toolCallId: block.id,
				}),
				block.partial,
			)
			.catch(() => {})
	}
}

export const webFetchTool = new WebFetchTool()
