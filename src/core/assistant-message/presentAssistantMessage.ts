import { serializeError } from "serialize-error"
import { Anthropic } from "@anthropic-ai/sdk"

import type { ToolName, ClineAsk, ToolProgressStatus, ArtifactSpillSettings } from "@roo-code/types"
import { ConsecutiveMistakeError, TelemetryEventName, resolveMaxInlineToolResultBytes } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { customToolRegistry } from "@roo-code/core"

import { t } from "../../i18n"

import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import type { ToolParamName, ToolResponse, ToolUse, McpToolUse } from "../../shared/tools"

import { AskIgnoredError } from "../task/AskIgnoredError"
import { Task } from "../task/Task"

import { listFilesTool } from "../tools/ListFilesTool"
import { readFileTool } from "../tools/ReadFileTool"
import { readArtifactTool } from "../tools/ReadArtifactTool"
import { searchTaskHistoryTool } from "../tools/SearchTaskHistoryTool"
import { writeToFileTool } from "../tools/WriteToFileTool"
import { editTool } from "../tools/EditTool"
import { searchReplaceTool } from "../tools/SearchReplaceTool"
import { editFileTool } from "../tools/EditFileTool"
import { applyPatchTool } from "../tools/ApplyPatchTool"
import { searchFilesTool } from "../tools/SearchFilesTool"
import { executeCommandTool } from "../tools/ExecuteCommandTool"
import { useMcpToolTool } from "../tools/UseMcpToolTool"
import { accessMcpResourceTool } from "../tools/accessMcpResourceTool"
import { askFollowupQuestionTool } from "../tools/AskFollowupQuestionTool"
import { switchModeTool } from "../tools/SwitchModeTool"
import { attemptCompletionTool, AttemptCompletionCallbacks } from "../tools/AttemptCompletionTool"
import { newTaskTool } from "../tools/NewTaskTool"
import { runParallelTasksTool } from "../tools/RunParallelTasksTool"
import { updateTodoListTool } from "../tools/UpdateTodoListTool"
import { runSlashCommandTool } from "../tools/RunSlashCommandTool"
import { skillTool } from "../tools/SkillTool"
import { toolsLoadTool } from "../tools/ToolsLoadTool"
import { generateImageTool } from "../tools/GenerateImageTool"
import { applyDiffTool as applyDiffToolClass } from "../tools/ApplyDiffTool"
import { isValidToolName, validateToolUse } from "../tools/validateToolUse"
import { codebaseSearchTool } from "../tools/CodebaseSearchTool"
import { webSearchTool } from "../tools/WebSearchTool"
import { webFetchTool } from "../tools/WebFetchTool"

import { formatResponse } from "../prompts/responses"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { tryAutoMaterializeDirectCall } from "../task/deferred-tools-resolver"

/**
 * Mistake accounting for a tool failure reported through `handleError`.
 *
 * Before this existed, only the malformed-call paths grew `consecutiveMistakeCount`: a tool
 * that failed at RUNTIME on every single turn (unreadable file, failing command, diff that
 * cannot be applied) was invisible to the circuit breaker and to `lastToolErrorName`, so the
 * mistake-limit guidance could not even name the tool that kept failing. Doing it here, in
 * the one callback every tool routes its failures through, means one rule for all call sites
 * and no per-tool bookkeeping to forget in the next tool.
 *
 * Four guards:
 *
 * - No `toolName`: the caller opted out on purpose. The custom-tool catch does its own
 *   accounting under the static `custom_tool` bucket, and counting it here as well would
 *   charge the model twice for one failure.
 * - `AskIgnoredError`: internal control flow (a newer ask superseded an older one), not a
 *   model mistake. The closures already return early on it; this guard keeps the helper
 *   correct on its own.
 * - `abort` / `abandoned`: a user cancel tears tools down mid-flight, and those failures
 *   belong to the cancel, not to the model.
 * - `resultAlreadyDelivered`: the tool ALREADY pushed its result for this block, so the
 *   failure now being reported happened after the call succeeded. Several tools push the
 *   success result and only then run their trailing cleanup (`diffViewProvider.reset()`,
 *   `processQueuedMessages()`) inside the same `try`, and the safety net in
 *   `BaseTool.handle` forwards anything that escapes there to this same closure. Counting
 *   it would charge the model a mistake for a tool that worked and would leave
 *   `lastToolErrorName` pointing at it, while `pushToolResult` drops the error envelope as
 *   a duplicate anyway, so the model never even learns why it was charged.
 */
function recordToolFailureAsMistake(
	cline: Task,
	error: Error,
	toolName: string | undefined,
	resultAlreadyDelivered: boolean,
): void {
	if (!toolName || resultAlreadyDelivered || error instanceof AskIgnoredError || cline.abort || cline.abandoned) {
		return
	}

	cline.consecutiveMistakeCount++
	// The cast is safe for every caller: `toolName` originates either from a tool class's
	// own `name` (typed `ToolName`) or from a static literal in this file.
	cline.recordToolError(toolName as ToolName, error.message)
}

/**
 * Processes and presents assistant message content to the user interface.
 *
 * This function is the core message handling system that:
 * - Sequentially processes content blocks from the assistant's response.
 * - Displays text content to the user.
 * - Executes tool use requests with appropriate user approval.
 * - Manages the flow of conversation by determining when to proceed to the next content block.
 * - Coordinates file system checkpointing for modified files.
 * - Controls the conversation state to determine when to continue to the next request.
 *
 * The function uses a locking mechanism to prevent concurrent execution and handles
 * partial content blocks during streaming. It's designed to work with the streaming
 * API response pattern, where content arrives incrementally and needs to be processed
 * as it becomes available.
 */

/**
 * Makes sure the task can spill an oversized tool result to an artifact.
 *
 * The spill decision happens inside `Task#pushToolResultToUserContent`, which is
 * synchronous, so the artifact store (whose directory resolves asynchronously)
 * has to be primed here, on the dispatch path. Best-effort: a failure leaves the
 * policy off and every result stays inline, exactly as before the policy existed.
 */
async function prepareToolResultSpill(cline: Task, state?: ArtifactSpillSettings): Promise<void> {
	try {
		if (typeof cline.ensureToolResultSpill !== "function") {
			return
		}

		const resolvedState = state ?? (await cline.providerRef.deref()?.getState())
		await cline.ensureToolResultSpill(resolveMaxInlineToolResultBytes(resolvedState))
	} catch (error) {
		console.warn("[presentAssistantMessage] Could not prepare the tool-result spill policy:", error)
	}
}

export async function presentAssistantMessage(cline: Task) {
	if (cline.abort) {
		throw new Error(`[Task#presentAssistantMessage] task ${cline.taskId}.${cline.instanceId} aborted`)
	}

	if (cline.presentAssistantMessageLocked) {
		cline.presentAssistantMessageHasPendingUpdates = true
		return
	}

	cline.presentAssistantMessageLocked = true
	cline.presentAssistantMessageHasPendingUpdates = false

	if (cline.currentStreamingContentIndex >= cline.assistantMessageContent.length) {
		// This may happen if the last content block was completed before
		// streaming could finish. If streaming is finished, and we're out of
		// bounds then this means we already  presented/executed the last
		// content block and are ready to continue to next request.
		if (cline.didCompleteReadingStream) {
			cline.userMessageContentReady = true
		}

		cline.presentAssistantMessageLocked = false
		return
	}

	let block: any
	try {
		// Performance optimization: Use shallow copy instead of deep clone.
		// The block is used read-only throughout this function - we never mutate its properties.
		// We only need to protect against the reference changing during streaming, not nested mutations.
		// This provides 80-90% reduction in cloning overhead (5-100ms saved per block).
		block = { ...cline.assistantMessageContent[cline.currentStreamingContentIndex] }
	} catch (error) {
		console.error(`ERROR cloning block:`, error)
		console.error(
			`Block content:`,
			JSON.stringify(cline.assistantMessageContent[cline.currentStreamingContentIndex], null, 2),
		)
		cline.presentAssistantMessageLocked = false
		return
	}

	switch (block.type) {
		case "mcp_tool_use": {
			// Handle native MCP tool calls (from mcp_serverName_toolName dynamic tools)
			// These are converted to the same execution path as use_mcp_tool but preserve
			// their original name in API history
			const mcpBlock = block as McpToolUse

			if (cline.didRejectTool) {
				// For native protocol, we must send a tool_result for every tool_use to avoid API errors
				const toolCallId = mcpBlock.id
				const errorMessage = !mcpBlock.partial
					? `Skipping MCP tool ${mcpBlock.name} due to user rejecting a previous tool.`
					: `MCP tool ${mcpBlock.name} was interrupted and not executed due to user rejecting a previous tool.`

				if (toolCallId) {
					cline.pushToolResultToUserContent({
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						content: errorMessage,
						is_error: true,
					})
				}
				break
			}

			// Track if we've already pushed a tool result
			let hasToolResult = false
			const toolCallId = mcpBlock.id

			// Store approval feedback to merge into tool result (GitHub #10465)
			let approvalFeedback: { text: string; images?: string[] } | undefined

			const pushToolResult = (content: ToolResponse, feedbackImages?: string[]) => {
				if (hasToolResult) {
					console.warn(
						`[presentAssistantMessage] Skipping duplicate tool_result for mcp_tool_use: ${toolCallId}`,
					)
					return
				}

				let resultContent: string
				let imageBlocks: Anthropic.ImageBlockParam[] = []

				if (typeof content === "string") {
					resultContent = content || "(tool did not return anything)"
				} else {
					const textBlocks = content.filter((item) => item.type === "text")
					imageBlocks = content.filter((item) => item.type === "image") as Anthropic.ImageBlockParam[]
					resultContent =
						textBlocks.map((item) => (item as Anthropic.TextBlockParam).text).join("\n") ||
						"(tool did not return anything)"
				}

				// Merge approval feedback into tool result (GitHub #10465)
				if (approvalFeedback) {
					const feedbackText = formatResponse.toolApprovedWithFeedback(approvalFeedback.text)
					resultContent = `${feedbackText}\n\n${resultContent}`

					// Add feedback images to the image blocks
					if (approvalFeedback.images) {
						const feedbackImageBlocks = formatResponse.imageBlocks(approvalFeedback.images)
						imageBlocks = [...feedbackImageBlocks, ...imageBlocks]
					}
				}

				if (toolCallId) {
					cline.pushToolResultToUserContent(
						{
							type: "tool_result",
							tool_use_id: sanitizeToolUseId(toolCallId),
							content: resultContent,
						},
						{ toolName: "use_mcp_tool" },
					)

					if (imageBlocks.length > 0) {
						cline.userMessageContent.push(...imageBlocks)
					}
				}

				hasToolResult = true
			}

			const toolDescription = () => `[mcp_tool: ${mcpBlock.serverName}/${mcpBlock.toolName}]`

			const askApproval = async (
				type: ClineAsk,
				partialMessage?: string,
				progressStatus?: ToolProgressStatus,
				isProtected?: boolean,
			) => {
				const { response, text, images } = await cline.askSay.ask(
					type,
					partialMessage,
					false,
					progressStatus,
					isProtected || false,
				)

				if (response !== "yesButtonClicked") {
					if (text) {
						await cline.askSay.say("user_feedback", text, images)
						pushToolResult(formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images))
					} else {
						pushToolResult(formatResponse.toolDenied())
					}
					cline.didRejectTool = true
					return false
				}

				// Store approval feedback to be merged into tool result (GitHub #10465)
				// Don't push it as a separate tool_result here - that would create duplicates.
				// The tool will call pushToolResult, which will merge the feedback into the actual result.
				if (text) {
					await cline.askSay.say("user_feedback", text, images)
					approvalFeedback = { text, images }
				}

				return true
			}

			const handleError = async (action: string, error: Error, toolName?: string) => {
				// Silently ignore AskIgnoredError - this is an internal control flow
				// signal, not an actual error. It occurs when a newer ask supersedes an older one.
				if (error instanceof AskIgnoredError) {
					return
				}
				// Count the failure before anything that can itself fail, so a broken UI
				// channel cannot silently drop the accounting. `hasToolResult` reports whether
				// this block already delivered its result: if it did, the tool SUCCEEDED and
				// this error comes from its trailing cleanup, which is not a model mistake
				// (and whose envelope `pushToolResult` drops as a duplicate anyway).
				recordToolFailureAsMistake(cline, error, toolName, hasToolResult)

				const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`

				await cline.askSay.say(
					"error",
					`Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`,
				)

				// `toolName` rides beside the serialized error, never inside it, so the minimal
				// valid example lands as a nested object the model can copy verbatim.
				pushToolResult(formatResponse.toolError(errorString, toolName))
			}

			if (!mcpBlock.partial) {
				cline.recordToolUsage("use_mcp_tool") // Record as use_mcp_tool for analytics
				TelemetryService.instance.captureToolUsage(cline.taskId, "use_mcp_tool")

				// Prepare the tool-result spill policy before the tool runs: MCP
				// servers are a classic source of multi-hundred-KB payloads.
				// Only on the final block, so streaming stays allocation-free.
				await prepareToolResultSpill(cline)

				// Auto-materialize: if the model called a deferred MCP tool directly
				// (without using `tools_load` first), promote it to the active set so
				// the next turn carries the full schema. The live MCP execution below
				// works regardless. Gated on the deferredTools experiment so behaviour
				// is byte-identical with the flag off. See ai_plans/deferred-tool-loading.md §8.3.
				try {
					const stateForResolver = await cline.providerRef.deref()?.getState()
					tryAutoMaterializeDirectCall({
						task: cline,
						blockName: mcpBlock.name,
						nativeArgs: mcpBlock.arguments,
						experiments: stateForResolver?.experiments,
					})
				} catch (resolverErr) {
					// Resolver is best-effort — never block a live MCP execution if it throws.
					console.warn("[presentAssistantMessage] auto-materialize hook failed:", resolverErr)
				}
			}

			// Resolve sanitized server name back to original server name
			// The serverName from parsing is sanitized (e.g., "my_server" from "my server")
			// We need the original name to find the actual MCP connection
			const mcpHub = cline.providerRef.deref()?.getMcpHub()
			let resolvedServerName = mcpBlock.serverName
			if (mcpHub) {
				const originalName = mcpHub.findServerNameBySanitizedName(mcpBlock.serverName)
				if (originalName) {
					resolvedServerName = originalName
				}
			}

			// Execute the MCP tool using the same handler as use_mcp_tool
			// Create a synthetic ToolUse block that the useMcpToolTool can handle
			const syntheticToolUse: ToolUse<"use_mcp_tool"> = {
				type: "tool_use",
				id: mcpBlock.id,
				name: "use_mcp_tool",
				params: {
					server_name: resolvedServerName,
					tool_name: mcpBlock.toolName,
					arguments: JSON.stringify(mcpBlock.arguments),
				},
				partial: mcpBlock.partial,
				nativeArgs: {
					server_name: resolvedServerName,
					tool_name: mcpBlock.toolName,
					arguments: mcpBlock.arguments,
				},
			}

			await useMcpToolTool.handle(cline, syntheticToolUse, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		}
		case "text": {
			if (cline.didRejectTool || cline.didAlreadyUseTool) {
				break
			}

			let content = block.content

			if (content) {
				// Have to do this for partial and complete since sending
				// content in thinking tags to markdown renderer will
				// automatically be removed.
				// Strip any streamed <thinking> tags from text output.
				content = content.replace(/<thinking>\s?/g, "")
				content = content.replace(/\s?<\/thinking>/g, "")
			}

			await cline.askSay.say("text", content, undefined, block.partial)
			break
		}
		case "tool_use": {
			// Native tool calling is the only supported tool calling mechanism.
			// A tool_use block without an id is invalid and cannot be executed.
			const toolCallId = (block as any).id as string | undefined
			if (!toolCallId) {
				const errorMessage =
					"Invalid tool call: missing tool_use.id. XML tool calls are no longer supported. Remove any XML tool markup (e.g. <read_file>...</read_file>) and use native tool calling instead."
				// Record a tool error for visibility/telemetry. Use the reported tool name if present.
				try {
					if (
						typeof (cline as any).recordToolError === "function" &&
						typeof (block as any).name === "string"
					) {
						;(cline as any).recordToolError((block as any).name as ToolName, errorMessage)
					}
				} catch {
					// Best-effort only
				}
				cline.consecutiveMistakeCount++
				await cline.askSay.say("error", errorMessage)
				cline.userMessageContent.push({ type: "text", text: errorMessage })
				cline.didAlreadyUseTool = true
				break
			}

			// Fetch state early so it's available for toolDescription and validation
			const state = await cline.providerRef.deref()?.getState()
			const { mode, customModes, experiments: stateExperiments, disabledTools } = state ?? {}

			// Prepare the tool-result spill policy before the tool runs, so the
			// (synchronous) push below can move an oversized result to disk.
			await prepareToolResultSpill(cline, state)

			const toolDescription = (): string => {
				switch (block.name) {
					case "execute_command":
						return `[${block.name} for '${block.params.command}']`
					case "read_file":
						// Prefer native typed args when available; fall back to legacy params
						// Check if nativeArgs exists (native protocol)
						if (block.nativeArgs) {
							return readFileTool.getReadFileToolDescription(block.name, block.nativeArgs)
						}
						return readFileTool.getReadFileToolDescription(block.name, block.params)
					case "write_to_file":
						return `[${block.name} for '${block.params.path}']`
					case "apply_diff":
						// Native-only: tool args are structured (no XML payloads).
						return block.params?.path ? `[${block.name} for '${block.params.path}']` : `[${block.name}]`
					case "search_files":
						return `[${block.name} for '${block.params.regex}'${
							block.params.file_pattern ? ` in '${block.params.file_pattern}'` : ""
						}]`
					case "edit":
					case "search_and_replace":
						return `[${block.name} for '${block.params.file_path}']`
					case "search_replace":
						return `[${block.name} for '${block.params.file_path}']`
					case "edit_file":
						return `[${block.name} for '${block.params.file_path}']`
					case "apply_patch":
						return `[${block.name}]`
					case "list_files":
						return `[${block.name} for '${block.params.path}']`
					case "use_mcp_tool":
						return `[${block.name} for '${block.params.server_name}']`
					case "access_mcp_resource":
						return `[${block.name} for '${block.params.server_name}']`
					case "ask_followup_question":
						return `[${block.name} for '${block.params.question}']`
					case "attempt_completion":
						return `[${block.name}]`
					case "switch_mode":
						return `[${block.name} to '${block.params.mode_slug}'${block.params.reason ? ` because: ${block.params.reason}` : ""}]`
					case "codebase_search":
						return `[${block.name} for '${block.params.query}']`
					case "read_artifact":
					case "read_command_output":
						return `[${block.name} for '${block.params.artifact_id}']`
					case "search_task_history":
						return `[${block.name} for '${block.params.query}']`
					case "web_search": {
						const nativeArgs = (block as ToolUse<"web_search">).nativeArgs
						const queries = Array.isArray(nativeArgs?.queries) ? nativeArgs.queries : []
						return queries.length > 0 ? `[${block.name} for '${queries.join("', '")}']` : `[${block.name}]`
					}
					case "web_fetch": {
						const nativeArgs = (block as ToolUse<"web_fetch">).nativeArgs
						return nativeArgs?.url ? `[${block.name} for '${nativeArgs.url}']` : `[${block.name}]`
					}
					case "update_todo_list":
						return `[${block.name}]`
					case "new_task": {
						const mode = block.params.mode ?? defaultModeSlug
						const message = block.params.message ?? "(no message)"
						const modeName = getModeBySlug(mode, customModes)?.name ?? mode
						return `[${block.name} in ${modeName} mode: '${message}']`
					}
					case "run_parallel_tasks": {
						const nativeArgs = (block as ToolUse<"run_parallel_tasks">).nativeArgs
						const count = Array.isArray(nativeArgs?.subtasks) ? nativeArgs.subtasks.length : 0
						return `[${block.name}: ${count} subtask(s)]`
					}
					case "run_slash_command":
						return `[${block.name} for '${block.params.command}'${block.params.args ? ` with args: ${block.params.args}` : ""}]`
					case "skill":
						return `[${block.name} for '${block.params.skill}'${block.params.args ? ` with args: ${block.params.args}` : ""}]`
					case "tools_load": {
						const nativeArgs = (block as ToolUse<"tools_load">).nativeArgs
						const names = Array.isArray(nativeArgs?.names) ? nativeArgs.names : []
						const summary = names.length > 0 ? names.join(", ") : "(no names)"
						return `[${block.name} for ${summary}]`
					}
					case "generate_image":
						return `[${block.name} for '${block.params.path}']`
					default:
						return `[${block.name}]`
				}
			}

			if (cline.didRejectTool) {
				// Ignore any tool content after user has rejected tool once.
				// For native tool calling, we must send a tool_result for every tool_use to avoid API errors
				const errorMessage = !block.partial
					? `Skipping tool ${toolDescription()} due to user rejecting a previous tool.`
					: `Tool ${toolDescription()} was interrupted and not executed due to user rejecting a previous tool.`

				cline.pushToolResultToUserContent({
					type: "tool_result",
					tool_use_id: sanitizeToolUseId(toolCallId),
					content: errorMessage,
					is_error: true,
				})

				break
			}

			// Track if we've already pushed a tool result for this tool call (native tool calling only)
			let hasToolResult = false

			// If this is a native tool call but the parser couldn't construct nativeArgs
			// (e.g., malformed/unfinished JSON in a streaming tool call), we must NOT attempt to
			// execute the tool. Instead, emit exactly one structured tool_result so the provider
			// receives a matching tool_result for the tool_use_id.
			//
			// This avoids executing an invalid tool_use block and prevents duplicate/fragmented
			// error reporting.
			if (!block.partial) {
				const customTool = stateExperiments?.customTools ? customToolRegistry.get(block.name) : undefined
				const isKnownTool = isValidToolName(String(block.name), stateExperiments)
				// Allow-list: tools that own their own missing-args handling and
				// MUST be allowed to reach their handler with empty/undefined
				// nativeArgs. Weak tool-calling models routinely emit `tools_load`
				// with `input: {}` — the ToolsLoadTool handler converts that into
				// structured guidance instead of an error. Gated by `deferredTools`
				// so behaviour with the experiment OFF is byte-identical to today.
				// See ai_plans/deferred-tool-loading.md §8.2.
				const allowsEmptyNativeArgs = stateExperiments?.deferredTools === true && block.name === "tools_load"

				// Auto-materialize: a direct call to a deferred tool name without
				// args. Resolver returns `guidance` with the schema inlined so the
				// model can retry next turn with valid args. Gated on the
				// `deferredTools` experiment. See §8.3.
				if (!block.nativeArgs && !customTool && stateExperiments?.deferredTools === true) {
					const outcome = tryAutoMaterializeDirectCall({
						task: cline,
						blockName: block.name,
						nativeArgs: block.nativeArgs,
						experiments: stateExperiments,
					})
					if (outcome && outcome.kind === "guidance") {
						cline.pushToolResultToUserContent({
							type: "tool_result",
							tool_use_id: sanitizeToolUseId(toolCallId),
							content: outcome.payload,
						})
						break
					}
				}

				if (isKnownTool && !block.nativeArgs && !customTool && !allowsEmptyNativeArgs) {
					const errorMessage =
						`Invalid tool call for '${block.name}': missing nativeArgs. ` +
						`This usually means the model streamed invalid or incomplete arguments and the call could not be finalized.`

					cline.consecutiveMistakeCount++
					try {
						cline.recordToolError(block.name as ToolName, errorMessage)
					} catch {
						// Best-effort only
					}

					// Push tool_result directly without setting didAlreadyUseTool so streaming can
					// continue gracefully.
					cline.pushToolResultToUserContent({
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						// This is the hot malformed-call path: the arguments never finalized, so
						// no tool ran and the model has nothing to learn from except the schema.
						// Send the minimal valid invocation with it.
						content: formatResponse.toolError(errorMessage, block.name),
						is_error: true,
					})

					break
				}
			}

			// Store approval feedback to merge into tool result (GitHub #10465)
			let approvalFeedback: { text: string; images?: string[] } | undefined

			const pushToolResult = (content: ToolResponse) => {
				// Native tool calling: only allow ONE tool_result per tool call
				if (hasToolResult) {
					console.warn(
						`[presentAssistantMessage] Skipping duplicate tool_result for tool_use_id: ${toolCallId}`,
					)
					return
				}

				let resultContent: string
				let imageBlocks: Anthropic.ImageBlockParam[] = []

				if (typeof content === "string") {
					resultContent = content || "(tool did not return anything)"
				} else {
					const textBlocks = content.filter((item) => item.type === "text")
					imageBlocks = content.filter((item) => item.type === "image") as Anthropic.ImageBlockParam[]
					resultContent =
						textBlocks.map((item) => (item as Anthropic.TextBlockParam).text).join("\n") ||
						"(tool did not return anything)"
				}

				// Merge approval feedback into tool result (GitHub #10465)
				if (approvalFeedback) {
					const feedbackText = formatResponse.toolApprovedWithFeedback(approvalFeedback.text)
					resultContent = `${feedbackText}\n\n${resultContent}`
					if (approvalFeedback.images) {
						const feedbackImageBlocks = formatResponse.imageBlocks(approvalFeedback.images)
						imageBlocks = [...feedbackImageBlocks, ...imageBlocks]
					}
				}

				cline.pushToolResultToUserContent(
					{
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						content: resultContent,
					},
					{ toolName: String(block.name) },
				)

				if (imageBlocks.length > 0) {
					cline.userMessageContent.push(...imageBlocks)
				}

				hasToolResult = true
			}

			const askApproval = async (
				type: ClineAsk,
				partialMessage?: string,
				progressStatus?: ToolProgressStatus,
				isProtected?: boolean,
			) => {
				const { response, text, images } = await cline.askSay.ask(
					type,
					partialMessage,
					false,
					progressStatus,
					isProtected || false,
				)

				if (response !== "yesButtonClicked") {
					// Handle both messageResponse and noButtonClicked with text.
					if (text) {
						await cline.askSay.say("user_feedback", text, images)
						pushToolResult(formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images))
					} else {
						pushToolResult(formatResponse.toolDenied())
					}
					cline.didRejectTool = true
					return false
				}

				// Store approval feedback to be merged into tool result (GitHub #10465)
				// Don't push it as a separate tool_result here - that would create duplicates.
				// The tool will call pushToolResult, which will merge the feedback into the actual result.
				if (text) {
					await cline.askSay.say("user_feedback", text, images)
					approvalFeedback = { text, images }
				}

				return true
			}

			const askFinishSubTaskApproval = async () => {
				// Ask the user to approve this task has completed, and he has
				// reviewed it, and we can declare task is finished and return
				// control to the parent task to continue running the rest of
				// the sub-tasks.
				const toolMessage = JSON.stringify({ tool: "finishTask" })
				return await askApproval("tool", toolMessage)
			}

			const handleError = async (action: string, error: Error, toolName?: string) => {
				// Silently ignore AskIgnoredError - this is an internal control flow
				// signal, not an actual error. It occurs when a newer ask supersedes an older one.
				if (error instanceof AskIgnoredError) {
					return
				}
				// Count the failure before anything that can itself fail, so a broken UI
				// channel cannot silently drop the accounting. `hasToolResult` reports whether
				// this block already delivered its result: if it did, the tool SUCCEEDED and
				// this error comes from its trailing cleanup, which is not a model mistake
				// (and whose envelope `pushToolResult` drops as a duplicate anyway).
				recordToolFailureAsMistake(cline, error, toolName, hasToolResult)

				const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`

				await cline.askSay.say(
					"error",
					`Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`,
				)

				// `toolName` rides beside the serialized error, never inside it, so the minimal
				// valid example lands as a nested object the model can copy verbatim.
				pushToolResult(formatResponse.toolError(errorString, toolName))
			}

			if (!block.partial) {
				// Check if this is a custom tool - if so, record as "custom_tool" (like MCP tools)
				const isCustomTool = stateExperiments?.customTools && customToolRegistry.has(block.name)
				const recordName = isCustomTool ? "custom_tool" : block.name
				cline.recordToolUsage(recordName)
				TelemetryService.instance.captureToolUsage(cline.taskId, recordName)

				// Track legacy format usage for read_file tool (for migration monitoring)
				if (block.name === "read_file" && block.usedLegacyFormat) {
					const modelInfo = cline.api.getModel()
					TelemetryService.instance.captureEvent(TelemetryEventName.READ_FILE_LEGACY_FORMAT_USED, {
						taskId: cline.taskId,
						model: modelInfo?.id,
					})
				}
			}

			// Validate tool use before execution - ONLY for complete (non-partial) blocks.
			// Validating partial blocks would cause validation errors to be thrown repeatedly
			// during streaming, pushing multiple tool_results for the same tool_use_id and
			// potentially causing the stream to appear frozen.
			if (!block.partial) {
				const modelInfo = cline.api.getModel()
				// Resolve aliases in includedTools before validation
				// e.g., "edit_file" should resolve to "apply_diff"
				const rawIncludedTools = modelInfo?.info?.includedTools
				const { resolveToolAlias } = await import("../prompts/tools/filter-tools-for-mode")
				const includedTools = rawIncludedTools?.map((tool) => resolveToolAlias(tool))

				try {
					const toolRequirements =
						disabledTools?.reduce(
							(acc: Record<string, boolean>, tool: string) => {
								acc[tool] = false
								const resolvedToolName = resolveToolAlias(tool)
								acc[resolvedToolName] = false
								return acc
							},
							{} as Record<string, boolean>,
						) ?? {}

					validateToolUse(
						block.name as ToolName,
						mode ?? defaultModeSlug,
						customModes ?? [],
						toolRequirements,
						block.params,
						stateExperiments,
						includedTools,
						cline.cwd,
					)
				} catch (error) {
					cline.consecutiveMistakeCount++
					// The counter already grew on the line above, so record only the name here:
					// without this, `lastToolErrorName` stays stale and the mistake-limit guidance
					// names the wrong tool (or none) after a run of rejected calls.
					//
					// `validateToolUse` throws for a hallucinated tool name too, and `block.name`
					// is an arbitrary model-supplied string at this point. Recording it would let
					// that string into `Task.toolUsage` and into the `TaskToolFailed` telemetry
					// event, where every consumer expects a real `ToolName`. So record only names
					// that pass the same validity check the dispatcher uses; for an invalid name
					// the counter bump and the error envelope below are the whole response.
					if (isValidToolName(String(block.name), stateExperiments)) {
						cline.recordToolError(block.name as ToolName, error.message)
					}
					// For validation errors (unknown tool, tool not allowed for mode), we need to:
					// 1. Send a tool_result with the error (required for native tool calling)
					// 2. NOT set didAlreadyUseTool = true (the tool was never executed, just failed validation)
					// This prevents the stream from being interrupted with "Response interrupted by tool use result"
					// which would cause the extension to appear to hang
					const errorContent = formatResponse.toolError(error.message, block.name)
					// Push tool_result directly without setting didAlreadyUseTool
					cline.pushToolResultToUserContent({
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						content: typeof errorContent === "string" ? errorContent : "(validation error)",
						is_error: true,
					})

					break
				}
			}

			// Check for identical consecutive tool calls.
			if (!block.partial) {
				// Use the detector to check for repetition, passing the ToolUse
				// block directly.
				const repetitionCheck = cline.toolRepetitionDetector.check(block)

				// If execution is not allowed, notify user and break.
				if (!repetitionCheck.allowExecution && repetitionCheck.askUser) {
					// Handle repetition similar to mistake_limit_reached pattern.
					const { response, text, images } = await cline.askSay.ask(
						repetitionCheck.askUser.messageKey as ClineAsk,
						repetitionCheck.askUser.messageDetail.replace("{toolName}", block.name),
					)

					if (response === "messageResponse") {
						// Add user feedback to userContent.
						cline.userMessageContent.push(
							{
								type: "text" as const,
								text: `Tool repetition limit reached. User feedback: ${text}`,
							},
							...formatResponse.imageBlocks(images),
						)

						// Add user feedback to chat.
						await cline.askSay.say("user_feedback", text, images)
					}

					// Track tool repetition in telemetry via PostHog exception tracking and event.
					TelemetryService.instance.captureConsecutiveMistakeError(cline.taskId)
					TelemetryService.instance.captureException(
						new ConsecutiveMistakeError(
							`Tool repetition limit reached for ${block.name}`,
							cline.taskId,
							cline.consecutiveMistakeCount,
							cline.consecutiveMistakeLimit,
							"tool_repetition",
							cline.apiConfiguration.apiProvider,
							cline.api.getModel().id,
						),
					)

					// Return tool result message about the repetition
					pushToolResult(
						formatResponse.toolError(
							`Tool call repetition limit reached for ${block.name}. Please try a different approach.`,
							block.name,
						),
					)
					break
				}
			}

			switch (block.name) {
				case "write_to_file":
					await checkpointSaveAndMark(cline)
					await writeToFileTool.handle(cline, block as ToolUse<"write_to_file">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "update_todo_list":
					await updateTodoListTool.handle(cline, block as ToolUse<"update_todo_list">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "apply_diff":
					await checkpointSaveAndMark(cline)
					await applyDiffToolClass.handle(cline, block as ToolUse<"apply_diff">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "edit":
				case "search_and_replace":
					await checkpointSaveAndMark(cline)
					await editTool.handle(cline, block as ToolUse<"edit">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "search_replace":
					await checkpointSaveAndMark(cline)
					await searchReplaceTool.handle(cline, block as ToolUse<"search_replace">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "edit_file":
					await checkpointSaveAndMark(cline)
					await editFileTool.handle(cline, block as ToolUse<"edit_file">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "apply_patch":
					await checkpointSaveAndMark(cline)
					await applyPatchTool.handle(cline, block as ToolUse<"apply_patch">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "read_file":
					// Type assertion is safe here because we're in the "read_file" case
					await readFileTool.handle(cline, block as ToolUse<"read_file">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "list_files":
					await listFilesTool.handle(cline, block as ToolUse<"list_files">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "codebase_search":
					await codebaseSearchTool.handle(cline, block as ToolUse<"codebase_search">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "search_files":
					await searchFilesTool.handle(cline, block as ToolUse<"search_files">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "execute_command":
					await executeCommandTool.handle(cline, block as ToolUse<"execute_command">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				// `read_command_output` is resolved to `read_artifact` by the
				// alias table before dispatch; it is listed here only so a
				// replayed legacy block still finds a handler.
				case "read_artifact":
				case "read_command_output":
					await readArtifactTool.handle(cline, block as ToolUse<"read_artifact">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "search_task_history":
					await searchTaskHistoryTool.handle(cline, block as ToolUse<"search_task_history">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "web_search":
					await webSearchTool.handle(cline, block as ToolUse<"web_search">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "web_fetch":
					await webFetchTool.handle(cline, block as ToolUse<"web_fetch">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "use_mcp_tool":
					await useMcpToolTool.handle(cline, block as ToolUse<"use_mcp_tool">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "access_mcp_resource":
					await accessMcpResourceTool.handle(cline, block as ToolUse<"access_mcp_resource">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "ask_followup_question":
					await askFollowupQuestionTool.handle(cline, block as ToolUse<"ask_followup_question">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "switch_mode":
					await switchModeTool.handle(cline, block as ToolUse<"switch_mode">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "new_task":
					await checkpointSaveAndMark(cline)
					await newTaskTool.handle(cline, block as ToolUse<"new_task">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "run_parallel_tasks":
					await runParallelTasksTool.handle(cline, block as ToolUse<"run_parallel_tasks">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "attempt_completion": {
					const completionCallbacks: AttemptCompletionCallbacks = {
						askApproval,
						handleError,
						pushToolResult,
						askFinishSubTaskApproval,
						toolDescription,
					}
					await attemptCompletionTool.handle(
						cline,
						block as ToolUse<"attempt_completion">,
						completionCallbacks,
					)
					break
				}
				case "run_slash_command":
					await runSlashCommandTool.handle(cline, block as ToolUse<"run_slash_command">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "skill":
					await skillTool.handle(cline, block as ToolUse<"skill">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "tools_load":
					await toolsLoadTool.handle(cline, block as ToolUse<"tools_load">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId,
					})
					break
				case "generate_image":
					await checkpointSaveAndMark(cline)
					await generateImageTool.handle(cline, block as ToolUse<"generate_image">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				default: {
					// Handle unknown/invalid tool names OR custom tools
					// This is critical for native tool calling where every tool_use MUST have a tool_result

					// CRITICAL: Don't process partial blocks for unknown tools - just let them stream in.
					// If we try to show errors for partial blocks, we'd show the error on every streaming chunk,
					// creating a loop that appears to freeze the extension. Only handle complete blocks.
					if (block.partial) {
						break
					}

					const customTool = stateExperiments?.customTools ? customToolRegistry.get(block.name) : undefined

					if (customTool) {
						try {
							let customToolArgs

							if (customTool.parameters) {
								try {
									customToolArgs = customTool.parameters.parse(block.nativeArgs || block.params || {})
								} catch (parseParamsError) {
									const message = `Custom tool "${block.name}" argument validation failed: ${parseParamsError.message}`
									console.error(message)
									cline.consecutiveMistakeCount++
									await cline.askSay.say("error", message)
									pushToolResult(formatResponse.toolError(message))
									break
								}
							}

							const result = await customTool.execute(customToolArgs, {
								mode: mode ?? defaultModeSlug,
								task: cline,
							})

							console.log(
								`${customTool.name}.execute(): ${JSON.stringify(customToolArgs)} -> ${JSON.stringify(result)}`,
							)

							pushToolResult(result)
							cline.consecutiveMistakeCount = 0
						} catch (executionError: any) {
							cline.consecutiveMistakeCount++
							// Record custom tool error with static name
							cline.recordToolError("custom_tool", executionError.message)
							// Deliberately 2-argument: the two lines above already did the mistake
							// accounting under the static `custom_tool` bucket, and passing a name
							// here would make `handleError` count the same failure a second time.
							// No example is lost either: a custom tool is called by its own
							// registered name and carries its own schema, so
							// `getToolMinimalExample` has nothing to attach for it by design.
							await handleError(`executing custom tool "${block.name}"`, executionError)
						}

						break
					}

					// Auto-materialize check before falling through to "Unknown tool".
					// If the name resolves in the deferred-tool directory, the model
					// called a deferred tool directly (instead of via `tools_load`):
					//   - guidance → push schema as result and break.
					//   - ready    → push a synthesised success-style guidance: we
					//                still cannot execute (no live handler on this
					//                turn) but the schema is now active, so the
					//                model retries next turn. Either way it's
					//                strictly better than an "Unknown tool" error.
					// Gated on the `deferredTools` experiment. See §8.3.
					if (stateExperiments?.deferredTools === true) {
						const outcome = tryAutoMaterializeDirectCall({
							task: cline,
							blockName: block.name,
							nativeArgs: block.nativeArgs,
							experiments: stateExperiments,
						})
						if (outcome) {
							const content =
								outcome.kind === "guidance"
									? outcome.payload
									: `Tool \`${block.name}\` was deferred but is now available. ` +
										`Its full schema will be in your tools list next turn — retry it then.`
							cline.pushToolResultToUserContent({
								type: "tool_result",
								tool_use_id: sanitizeToolUseId(toolCallId),
								content,
							})
							break
						}
					}

					// Not a custom tool - handle as unknown tool error
					const errorMessage = `Unknown tool "${block.name}". This tool does not exist. Please use one of the available tools.`
					cline.consecutiveMistakeCount++
					cline.recordToolError(block.name as ToolName, errorMessage)
					await cline.askSay.say("error", t("tools:unknownToolError", { toolName: block.name }))
					// Push tool_result directly WITHOUT setting didAlreadyUseTool
					// This prevents the stream from being interrupted with "Response interrupted by tool use result"
					cline.pushToolResultToUserContent({
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						// The name is passed for consistency with every other error envelope.
						// An unknown name yields no example, but a hallucinated variant of a real
						// name (`list_file`) yields nothing either, so nothing misleading is added.
						content: formatResponse.toolError(errorMessage, block.name),
						is_error: true,
					})
					break
				}
			}

			break
		}
	}

	// Seeing out of bounds is fine, it means that the next too call is being
	// built up and ready to add to assistantMessageContent to present.
	// When you see the UI inactive during this, it means that a tool is
	// breaking without presenting any UI. For example the write_to_file tool
	// was breaking when relpath was undefined, and for invalid relpath it never
	// presented UI.
	// This needs to be placed here, if not then calling
	// cline.presentAssistantMessage below would fail (sometimes) since it's
	// locked.
	cline.presentAssistantMessageLocked = false

	// NOTE: When tool is rejected, iterator stream is interrupted and it waits
	// for `userMessageContentReady` to be true. Future calls to present will
	// skip execution since `didRejectTool` and iterate until `contentIndex` is
	// set to message length and it sets userMessageContentReady to true itself
	// (instead of preemptively doing it in iterator).
	if (!block.partial || cline.didRejectTool || cline.didAlreadyUseTool) {
		// Block is finished streaming and executing.
		if (cline.currentStreamingContentIndex === cline.assistantMessageContent.length - 1) {
			// It's okay that we increment if !didCompleteReadingStream, it'll
			// just return because out of bounds and as streaming continues it
			// will call `presentAssitantMessage` if a new block is ready. If
			// streaming is finished then we set `userMessageContentReady` to
			// true when out of bounds. This gracefully allows the stream to
			// continue on and all potential content blocks be presented.
			// Last block is complete and it is finished executing
			cline.userMessageContentReady = true // Will allow `pWaitFor` to continue.
		}

		// Call next block if it exists (if not then read stream will call it
		// when it's ready).
		// Need to increment regardless, so when read stream calls this function
		// again it will be streaming the next block.
		cline.currentStreamingContentIndex++

		if (cline.currentStreamingContentIndex < cline.assistantMessageContent.length) {
			// There are already more content blocks to stream, so we'll call
			// this function ourselves.
			presentAssistantMessage(cline)
			return
		} else {
			// CRITICAL FIX: If we're out of bounds and the stream is complete, set userMessageContentReady
			// This handles the case where assistantMessageContent is empty or becomes empty after processing
			if (cline.didCompleteReadingStream) {
				cline.userMessageContentReady = true
			}
		}
	}

	// Block is partial, but the read stream may have finished.
	if (cline.presentAssistantMessageHasPendingUpdates) {
		presentAssistantMessage(cline)
	}
}

/**
 * save checkpoint and mark done in the current streaming task.
 * @param task The Task instance to checkpoint save and mark.
 * @returns
 */
async function checkpointSaveAndMark(task: Task) {
	if (task.currentStreamingDidCheckpoint) {
		return
	}
	try {
		// Prefer the checkpoint started eagerly at tool_call_start (it overlapped
		// the write tool's argument streaming); fall back to a cold save.
		await (task.pendingCheckpointSave ?? task.checkpointSave(true))
		task.currentStreamingDidCheckpoint = true
	} catch (error) {
		console.error(`[Task#presentAssistantMessage] Error saving checkpoint: ${error.message}`, error)
	} finally {
		task.pendingCheckpointSave = undefined
	}
}
