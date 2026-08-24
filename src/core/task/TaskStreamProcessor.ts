import { Anthropic } from "@anthropic-ai/sdk"
import EventEmitter from "events"

import {
	type ClineApiReqCancelReason,
	type ClineApiReqInfo,
	type ClineMessage,
	type ModelInfo,
	type ProviderSettings,
	type ToolName,
	getModelId,
	getApiProtocol,
	isRetiredProvider,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { type ApiHandler } from "../../api"
import { type ApiStream, type GroundingSource } from "../../api/transform/stream"

import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "../../shared/cost"
import { findLastIndex } from "../../shared/array"
import { t } from "../../i18n"
import { sanitizeToolUseId } from "../../utils/tool-id"

import { type AssistantMessageContent, presentAssistantMessage } from "../assistant-message"
import { NativeToolCallParser, type ToolCallStreamEvent } from "../assistant-message/NativeToolCallParser"
import { type ClineProvider } from "../webview/ClineProvider"

import { type TaskAskSay } from "./TaskAskSay"
import { type TaskHistory } from "./TaskHistory"
import { type DiffViewProvider } from "../../integrations/editor/DiffViewProvider"

import { type UpdateApiReqMsgFn, type AbortStreamFn, type TokenSnapshot } from "./StreamProcessorTypes"

const DEFAULT_USAGE_COLLECTION_TIMEOUT_MS = 5000 // 5 seconds

// Tools that trigger a pre-edit checkpoint in presentAssistantMessage. Kept in
// sync with the checkpointSaveAndMark call sites there.
const CHECKPOINTED_WRITE_TOOLS = new Set([
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
])

// Tools that cannot mutate the workspace. An eager pre-edit checkpoint is only
// safe while every earlier tool block in the turn is in this set — anything
// else (execute_command, MCP tools, other writes) may still be mutating files
// when the write tool's arguments start streaming.
const WORKSPACE_READ_ONLY_TOOLS = new Set([
	"read_file",
	"list_files",
	"search_files",
	"codebase_search",
	"list_code_definition_names",
	"read_artifact",
	"read_command_output",
	"web_search",
	"web_fetch",
])

export interface TaskStreamProcessorAccess {
	taskId: string
	instanceId: string
	abort: boolean
	abandoned: boolean
	apiConfiguration: ProviderSettings

	// Streaming state (mutable - the processor reads and writes these)
	currentStreamingContentIndex: number
	currentStreamingDidCheckpoint: boolean
	assistantMessageContent: AssistantMessageContent[]
	didCompleteReadingStream: boolean
	userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam)[]
	userMessageContentReady: boolean
	didRejectTool: boolean
	didAlreadyUseTool: boolean
	didToolFailInCurrentTurn: boolean
	assistantMessageSavedToHistory: boolean
	presentAssistantMessageLocked: boolean
	presentAssistantMessageHasPendingUpdates: boolean
	streamingToolCallIndices: Map<string, number>
	isStreaming: boolean
	isWaitingForFirstChunk: boolean
	cachedStreamingModel?: { id: string; info: ModelInfo }

	// Cline messages (for updating api_req_started)
	clineMessages: ClineMessage[]

	// Abort stream flag
	didFinishAbortingStream: boolean

	// Counter for no-assistant-messages detection
	consecutiveNoAssistantMessagesCount: number

	// API handler (for caching streaming model)
	api: ApiHandler

	// Delegated modules
	askSay: TaskAskSay
	history: TaskHistory

	// Provider reference (for postStateToWebviewWithoutTaskHistory)
	providerRef: WeakRef<ClineProvider>

	// Methods
	emit: EventEmitter["emit"]
	pushToolResultToUserContent: (toolResult: Anthropic.ToolResultBlockParam) => boolean
	diffViewProvider: DiffViewProvider
}

export class TaskStreamProcessor {
	constructor(
		private readonly access: TaskStreamProcessorAccess,
		private readonly _task: any,
	) {}

	// Per-task parser instance — avoids cross-task state interference in parallel tasks
	private readonly toolCallParser = new NativeToolCallParser()

	// Accumulation state for the current streaming session
	private _reasoningMessage: string = ""
	private _requestStartTs: number = 0
	private _firstChunkTs: number | undefined
	private _assistantMessage: string = ""
	private _inputTokens: number = 0
	private _outputTokens: number = 0
	private _cacheWriteTokens: number = 0
	private _cacheReadTokens: number = 0
	private _totalCost: number | undefined = undefined
	private _pendingGroundingSources: GroundingSource[] = []

	get reasoningMessage(): string {
		return this._reasoningMessage
	}
	get assistantMessage(): string {
		return this._assistantMessage
	}

	/**
	 * Append text to the assistant message.
	 * Used when the stream is interrupted (e.g., by user feedback or tool use result).
	 */
	appendAssistantMessage(text: string): void {
		this._assistantMessage += text
	}
	get inputTokens(): number {
		return this._inputTokens
	}
	get outputTokens(): number {
		return this._outputTokens
	}
	get cacheWriteTokens(): number {
		return this._cacheWriteTokens
	}
	get cacheReadTokens(): number {
		return this._cacheReadTokens
	}
	get totalCost(): number | undefined {
		return this._totalCost
	}
	get pendingGroundingSources(): GroundingSource[] {
		return this._pendingGroundingSources
	}

	/**
	 * Reset all streaming state at the start of each API request.
	 * This resets mutable streaming properties on the access interface,
	 * clears tool call parser state, and resets the diff view.
	 */
	async resetStreamingState(): Promise<void> {
		this.access.currentStreamingContentIndex = 0
		this.access.currentStreamingDidCheckpoint = false
		// Drop any checkpoint from a previous (possibly aborted) turn — it
		// captured state before that turn's writes, so it must not satisfy this
		// turn's pre-edit checkpoint.
		this._task.pendingCheckpointSave = undefined
		this.access.assistantMessageContent = []
		this.access.didCompleteReadingStream = false
		this.access.userMessageContent = []
		this.access.userMessageContentReady = false
		this.access.didRejectTool = false
		this.access.didAlreadyUseTool = false
		this.access.assistantMessageSavedToHistory = false
		// Reset tool failure flag for each new assistant turn - this ensures that tool failures
		// only prevent attempt_completion within the same assistant message, not across turns
		this.access.didToolFailInCurrentTurn = false
		this.access.presentAssistantMessageLocked = false
		this.access.presentAssistantMessageHasPendingUpdates = false
		// No legacy text-stream tool parser.
		this.access.streamingToolCallIndices.clear()
		// Clear any leftover streaming tool call state from previous interrupted streams
		this.toolCallParser.clearAllStreamingToolCalls()
		this.toolCallParser.clearRawChunkState()

		await this.access.diffViewProvider.reset()

		// Cache model info once per API request to avoid repeated calls during streaming
		this.access.cachedStreamingModel = this.access.api.getModel()

		// Reset accumulation state
		this._requestStartTs = performance.now()
		this._firstChunkTs = undefined
		this._reasoningMessage = ""
		this._assistantMessage = ""
		this._inputTokens = 0
		this._outputTokens = 0
		this._cacheWriteTokens = 0
		this._cacheReadTokens = 0
		this._totalCost = undefined
		this._pendingGroundingSources = []
		this._partialBlocks = []
	}

	/**
	 * Process a single chunk from the API stream.
	 * Handles reasoning, usage, grounding, tool_call_partial, tool_call, and text chunks.
	 */
	processChunk(chunk: any, streamModelInfo: ModelInfo): void {
		if (this._firstChunkTs === undefined) {
			this._firstChunkTs = performance.now()
		}
		switch (chunk.type) {
			case "reasoning": {
				this._reasoningMessage += chunk.text
				// Only apply formatting if the message contains sentence-ending punctuation followed by **
				let formattedReasoning = this._reasoningMessage
				if (this._reasoningMessage.includes("**")) {
					// Add line breaks before **Title** patterns that appear after sentence endings
					// This targets section headers like "...end of sentence.**Title Here**"
					// Handles periods, exclamation marks, and question marks
					formattedReasoning = this._reasoningMessage.replace(/([.!?])\*\*([^*\n]+)\*\*/g, "$1\n\n**$2**")
				}
				this.access.askSay.say("reasoning", formattedReasoning, undefined, true)
				break
			}
			case "usage":
				this._inputTokens += chunk.inputTokens
				this._outputTokens += chunk.outputTokens
				this._cacheWriteTokens += chunk.cacheWriteTokens ?? 0
				this._cacheReadTokens += chunk.cacheReadTokens ?? 0
				this._totalCost = chunk.totalCost
				break
			case "grounding":
				// Handle grounding sources separately from regular content
				// to prevent state persistence issues - store them separately
				if (chunk.sources && chunk.sources.length > 0) {
					this._pendingGroundingSources.push(...chunk.sources)
				}
				break
			case "tool_call_partial": {
				// Process raw tool call chunk through the per-task parser instance
				// which handles tracking, buffering, and emits events
				const events = this.toolCallParser.processRawChunk({
					index: chunk.index,
					id: chunk.id,
					name: chunk.name,
					arguments: chunk.arguments,
				})

				this.handleToolCallEvents(events, streamModelInfo)
				break
			}

			case "finish_reason": {
				// Process finish reason through the per-task parser instance
				// This replaces direct provider calls to NativeToolCallParser.processFinishReason
				const events = this.toolCallParser.processFinishReason(chunk.finishReason)
				this.handleToolCallEvents(events, streamModelInfo)
				break
			}

			case "tool_call": {
				// Legacy: Handle complete tool calls (for backward compatibility)
				// Convert native tool call to ToolUse format
				const toolUse = NativeToolCallParser.parseToolCall({
					id: chunk.id,
					name: chunk.name as ToolName,
					arguments: chunk.arguments,
				})

				if (!toolUse) {
					console.error(`Failed to parse tool call for task ${this.access.taskId}:`, chunk)
					break
				}

				// Store the tool call ID on the ToolUse object for later reference
				// This is needed to create tool_result blocks that reference the correct tool_use_id
				toolUse.id = chunk.id

				// Add the tool use to assistant message content
				this.access.assistantMessageContent.push(toolUse)

				// Mark that we have new content to process
				this.access.userMessageContentReady = false

				// Present the tool call to user - presentAssistantMessage will execute
				// tools sequentially and accumulate all results in userMessageContent
				presentAssistantMessage(this._task)
				break
			}
			case "text": {
				this._assistantMessage += chunk.text

				// Native tool calling: text chunks are plain text.
				// Create or update a text content block directly
				const lastBlock = this.access.assistantMessageContent[this.access.assistantMessageContent.length - 1]
				if (lastBlock?.type === "text" && lastBlock.partial) {
					lastBlock.content = this._assistantMessage
				} else {
					this.access.assistantMessageContent.push({
						type: "text",
						content: this._assistantMessage,
						partial: true,
					})
					this.access.userMessageContentReady = false
				}
				presentAssistantMessage(this._task)
				break
			}
		}
	}

	/**
	 * Process tool call events (start/delta/end) emitted by the parser.
	 * Shared between tool_call_partial and finish_reason chunk handling
	 * to avoid duplicating the ~100-line event loop.
	 */
	private handleToolCallEvents(events: ToolCallStreamEvent[], _streamModelInfo: ModelInfo): void {
		for (const event of events) {
			if (event.type === "tool_call_start") {
				// Guard against duplicate tool_call_start events for the same tool ID.
				// This can occur due to stream retry, reconnection, or API quirks.
				// Without this check, duplicate tool_use blocks with the same ID would
				// be added to assistantMessageContent, causing API 400 errors:
				// "tool_use ids must be unique"
				if (this.access.streamingToolCallIndices.has(event.id)) {
					console.warn(
						`[Task#${this.access.taskId}] Ignoring duplicate tool_call_start for ID: ${event.id} (tool: ${event.name})`,
					)
					continue
				}

				// Initialize streaming in the per-task parser
				this.toolCallParser.startStreamingToolCall(event.id, event.name as ToolName)

				// Eager pre-edit checkpoint: a write tool's arguments (whole file
				// contents / diffs) can stream for seconds. Start the checkpoint
				// now so it overlaps argument streaming instead of blocking the
				// tool execution in checkpointSaveAndMark. Only safe while every
				// earlier tool block this turn is workspace-read-only; otherwise
				// checkpointSaveAndMark falls back to the cold save after the
				// mutating tool finished. The stored promise is awaited there;
				// errors surface at the await site (the extra catch below only
				// suppresses an unhandled rejection when no write tool ends up
				// executing this turn).
				if (
					CHECKPOINTED_WRITE_TOOLS.has(event.name) &&
					!this.access.currentStreamingDidCheckpoint &&
					typeof this._task?.checkpointSave === "function" &&
					this._task.pendingCheckpointSave === undefined &&
					this.access.assistantMessageContent.every(
						(b) =>
							b.type === "text" ||
							(b.type === "tool_use" && WORKSPACE_READ_ONLY_TOOLS.has(b.name as string)),
					)
				) {
					const pending: Promise<void> = this._task.checkpointSave(true)
					pending.catch(() => {})
					this._task.pendingCheckpointSave = pending
				}

				// Before adding a new tool, finalize any preceding text block
				// This prevents the text block from blocking tool presentation
				const lastBlock = this.access.assistantMessageContent[this.access.assistantMessageContent.length - 1]
				if (lastBlock?.type === "text" && lastBlock.partial) {
					lastBlock.partial = false
				}

				// Track the index where this tool will be stored
				const toolUseIndex = this.access.assistantMessageContent.length
				this.access.streamingToolCallIndices.set(event.id, toolUseIndex)

				// Create initial partial tool use
				const partialToolUse = {
					type: "tool_use" as const,
					name: event.name as ToolName,
					params: {},
					partial: true,
				}

				// Store the ID for native protocol
				;(partialToolUse as any).id = event.id

				// Add to content and present
				this.access.assistantMessageContent.push(partialToolUse)
				this.access.userMessageContentReady = false
				presentAssistantMessage(this._task)
			} else if (event.type === "tool_call_delta") {
				// Process chunk using streaming JSON parser
				const partialToolUse = this.toolCallParser.processStreamingChunk(event.id, event.delta)

				if (partialToolUse) {
					// Get the index for this tool call
					const toolUseIndex = this.access.streamingToolCallIndices.get(event.id)
					if (toolUseIndex !== undefined) {
						// Store the ID for native protocol
						;(partialToolUse as any).id = event.id

						// Update the existing tool use with new partial data
						this.access.assistantMessageContent[toolUseIndex] = partialToolUse

						// Present updated tool use
						presentAssistantMessage(this._task)
					}
				}
			} else if (event.type === "tool_call_end") {
				// Finalize the streaming tool call
				const finalToolUse = this.toolCallParser.finalizeStreamingToolCall(event.id)

				// Get the index for this tool call
				const toolUseIndex = this.access.streamingToolCallIndices.get(event.id)

				if (finalToolUse) {
					// Store the tool call ID
					;(finalToolUse as any).id = event.id

					// Get the index and replace partial with final
					if (toolUseIndex !== undefined) {
						this.access.assistantMessageContent[toolUseIndex] = finalToolUse
					}

					// Clean up tracking
					this.access.streamingToolCallIndices.delete(event.id)

					// Mark that we have new content to process
					this.access.userMessageContentReady = false

					// Present the finalized tool call
					presentAssistantMessage(this._task)
				} else if (toolUseIndex !== undefined) {
					// finalizeStreamingToolCall returned null (malformed JSON or missing args)
					// Mark the tool as non-partial so it's presented as complete, but execution
					// will be short-circuited in presentAssistantMessage with a structured tool_result.
					this.markToolUseNonPartial(event.id, toolUseIndex)

					// Clean up tracking
					this.access.streamingToolCallIndices.delete(event.id)

					// Mark that we have new content to process
					this.access.userMessageContentReady = false

					// Present the tool call - validation will handle missing params
					presentAssistantMessage(this._task)
				} else {
					// TE-8: finalToolUse is null AND toolUseIndex is undefined.
					// This happens when a duplicate tool_call_start was deduped (so
					// streamingToolCallIndices never tracked this id under the
					// duplicate's index), but the parser's rawChunkTracker still has
					// an entry that emits a tool_call_end on finish_reason/finalize.
					// The first end already handled the content block; this second
					// end must not be silently swallowed.
					this.handleOrphanedToolCallEnd(event.id)
				}
			}
		}
	}

	/**
	 * Mark a tool_use block at the given index as non-partial (complete).
	 * Used when finalizeStreamingToolCall returns null (malformed JSON) but
	 * the tool call was tracked — the block must be presented so that
	 * presentAssistantMessage short-circuits with a structured error tool_result.
	 */
	private markToolUseNonPartial(toolCallId: string, toolUseIndex: number): void {
		const existingToolUse = this.access.assistantMessageContent[toolUseIndex]
		if (existingToolUse && existingToolUse.type === "tool_use") {
			existingToolUse.partial = false
			// Ensure it has the ID for native protocol
			;(existingToolUse as any).id = toolCallId
		}
	}

	/**
	 * Handle a tool_call_end event for an id that has no tracking index
	 * (streamingToolCallIndices has no entry). This is reachable when:
	 *   - A duplicate tool_call_start was deduped by the guard, so the id
	 *     was tracked under the first start's index, and the first
	 *     tool_call_end already cleaned up tracking.
	 *   - Or a state inconsistency caused the tracking to be lost.
	 *
	 * We scan assistantMessageContent for a block with the matching id.
	 * If found and still partial, we mark it non-partial (reusing the same
	 * logic as the null-finalize-with-index branch). If not found at all,
	 * there is nothing to repair in content — we log a loud error so the
	 * orphaned end is never silently swallowed.
	 */
	private handleOrphanedToolCallEnd(toolCallId: string): void {
		// Scan for a content block with this id.
		const contentIndex = this.access.assistantMessageContent.findIndex((block) => (block as any).id === toolCallId)

		if (contentIndex !== -1) {
			const block = this.access.assistantMessageContent[contentIndex]
			if (block && block.type === "tool_use" && block.partial) {
				// Repair: mark the block non-partial so presentAssistantMessage
				// can process it (will short-circuit with a structured error
				// tool_result if params are invalid).
				block.partial = false
				this.access.userMessageContentReady = false
				presentAssistantMessage(this._task)
			}
			// If already non-partial, the first end already handled it — nothing to do.
		} else {
			// No content block exists for this id. This is not expected through
			// normal parser event flow (the parser only emits tool_call_end for
			// started tool calls, and a start always creates a content block).
			// Log a loud error so the orphaned end is never silently swallowed.
			console.error(
				`[Task#${this.access.taskId}] Orphaned tool_call_end: no content block found for tool call ID: ${toolCallId}`,
			)
		}

		// Defensive: ensure tracking is clean even if an entry somehow exists.
		this.access.streamingToolCallIndices.delete(toolCallId)
	}

	/**
	 * Finalize the stream after all chunks have been read.
	 * Completes remaining tool calls, marks partial blocks as complete,
	 * and saves the reasoning message.
	 */
	async finalizeStream(): Promise<void> {
		this.access.didCompleteReadingStream = true

		// Set any blocks to be complete to allow `presentAssistantMessage`
		// to finish and set `userMessageContentReady` to true.
		// (Could be a text block that had no subsequent tool uses, or a
		// text block at the very end, or an invalid tool use, etc. Whatever
		// the case, `presentAssistantMessage` relies on these blocks either
		// to be completed or the user to reject a block in order to proceed
		// and eventually set userMessageContentReady to true.)

		// Finalize any remaining streaming tool calls that weren't explicitly ended
		// This is critical for MCP tools which need tool_call_end events to be properly
		// converted from ToolUse to McpToolUse via finalizeStreamingToolCall()
		const finalizeEvents = this.toolCallParser.finalizeRawChunks()
		this.handleToolCallEvents(finalizeEvents, this.access.cachedStreamingModel?.info ?? ({} as ModelInfo))

		// IMPORTANT: Capture partialBlocks AFTER finalizeRawChunks() to avoid double-presentation.
		// Tools finalized above are already presented, so we only want blocks still partial after finalization.
		const partialBlocks = this.access.assistantMessageContent.filter((block) => block.partial)
		partialBlocks.forEach((block) => (block.partial = false))

		// Can't just do this b/c a tool could be in the middle of executing.
		// this.assistantMessageContent.forEach((e) => (e.partial = false))

		// No legacy streaming parser to finalize.

		// Note: updateApiReqMsg() is now called from within drainStreamInBackgroundToFindAllUsage
		// to ensure usage data is captured even when the stream is interrupted. The background task
		// uses local variables to accumulate usage data before atomically updating the shared state.

		// Complete the reasoning message if it exists
		// We can't use say() here because the reasoning message may not be the last message
		// (other messages like text blocks or tool uses may have been added after it during streaming)
		if (this._reasoningMessage) {
			const lastReasoningIndex = findLastIndex(
				this.access.clineMessages,
				(m) => m.type === "say" && m.say === "reasoning",
			)

			if (lastReasoningIndex !== -1 && this.access.clineMessages[lastReasoningIndex].partial) {
				this.access.clineMessages[lastReasoningIndex].partial = false
				await this.access.history.updateClineMessage(this.access.clineMessages[lastReasoningIndex])
			}
		}

		await this.access.history.saveClineMessages()
		await this.access.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

		// Return partialBlocks for later presentation
		// The caller needs to present them AFTER saving the assistant message to API history
		this._partialBlocks = partialBlocks
	}

	// Store partial blocks from finalizeStream for later use
	private _partialBlocks: AssistantMessageContent[] = []

	get partialBlocks(): AssistantMessageContent[] {
		return this._partialBlocks
	}

	/**
	 * Assemble and save the assistant message to API conversation history.
	 * Builds the assistant content array for API history, handles tool_use deduplication,
	 * and new_task isolation.
	 */
	async assembleAndSaveAssistantMessage(): Promise<void> {
		// Check if we have any content to process (text or tool uses)
		const hasTextContent = this._assistantMessage.length > 0

		const hasToolUses = this.access.assistantMessageContent.some(
			(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
		)

		if (hasTextContent || hasToolUses) {
			// Reset counter when we get a successful response with content
			this.access.consecutiveNoAssistantMessagesCount = 0
			// Display grounding sources to the user if they exist
			if (this._pendingGroundingSources.length > 0) {
				const citationLinks = this._pendingGroundingSources.map((source, i) => `[${i + 1}](${source.url})`)
				const sourcesText = `${t("common:gemini.sources")} ${citationLinks.join(", ")}`

				await this.access.askSay.say("text", sourcesText, undefined, false, undefined, undefined, {
					isNonInteractive: true,
				})
			}

			// Build the assistant message content array
			const assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = []

			// Add text content if present
			if (this._assistantMessage) {
				assistantContent.push({
					type: "text" as const,
					text: this._assistantMessage,
				})
			}

			// Add tool_use blocks with their IDs for native protocol
			// This handles both regular ToolUse and McpToolUse types
			// IMPORTANT: Track seen IDs to prevent duplicates in the API request.
			// Duplicate tool_use IDs cause Anthropic API 400 errors:
			// "tool_use ids must be unique"
			const seenToolUseIds = new Set<string>()
			const toolUseBlocks = this.access.assistantMessageContent.filter(
				(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
			)
			for (const block of toolUseBlocks) {
				if (block.type === "mcp_tool_use") {
					// McpToolUse already has the original tool name (e.g., "mcp_serverName_toolName")
					// The arguments are the raw tool arguments (matching the simplified schema)
					const mcpBlock = block as import("../../shared/tools").McpToolUse
					if (mcpBlock.id) {
						const sanitizedId = sanitizeToolUseId(mcpBlock.id)
						// Pre-flight deduplication: Skip if we've already added this ID
						if (seenToolUseIds.has(sanitizedId)) {
							console.warn(
								`[Task#${this.access.taskId}] Pre-flight deduplication: Skipping duplicate MCP tool_use ID: ${sanitizedId} (tool: ${mcpBlock.name})`,
							)
							continue
						}
						seenToolUseIds.add(sanitizedId)
						assistantContent.push({
							type: "tool_use" as const,
							id: sanitizedId,
							name: mcpBlock.name, // Original dynamic name
							input: mcpBlock.arguments, // Direct tool arguments
						})
					}
				} else {
					// Regular ToolUse
					const toolUse = block as import("../../shared/tools").ToolUse
					const toolCallId = toolUse.id
					if (toolCallId) {
						const sanitizedId = sanitizeToolUseId(toolCallId)
						// Pre-flight deduplication: Skip if we've already added this ID
						if (seenToolUseIds.has(sanitizedId)) {
							console.warn(
								`[Task#${this.access.taskId}] Pre-flight deduplication: Skipping duplicate tool_use ID: ${sanitizedId} (tool: ${toolUse.name})`,
							)
							continue
						}
						seenToolUseIds.add(sanitizedId)
						// nativeArgs is already in the correct API format for all tools
						const input = toolUse.nativeArgs || toolUse.params

						// Use originalName (alias) if present for API history consistency.
						// When tool aliases are used (e.g., "edit_file" -> "search_and_replace" -> "edit" (current canonical name)),
						// we want the alias name in the conversation history to match what the model
						// was told the tool was named, preventing confusion in multi-turn conversations.
						const toolNameForHistory = toolUse.originalName ?? toolUse.name

						assistantContent.push({
							type: "tool_use" as const,
							id: sanitizedId,
							name: toolNameForHistory,
							input,
						})
					}
				}
			}

			// Enforce new_task isolation: if new_task is called alongside other tools,
			// truncate any tools that come after it and inject error tool_results.
			// This prevents orphaned tools when delegation disposes the parent task.
			const newTaskIndex = assistantContent.findIndex(
				(block) => block.type === "tool_use" && block.name === "new_task",
			)

			if (newTaskIndex !== -1 && newTaskIndex < assistantContent.length - 1) {
				// new_task found but not last - truncate subsequent tools
				const truncatedTools = assistantContent.slice(newTaskIndex + 1)
				assistantContent.length = newTaskIndex + 1 // Truncate API history array

				// ALSO truncate the execution array (assistantMessageContent) to prevent
				// tools after new_task from being executed by presentAssistantMessage().
				// Find new_task index in assistantMessageContent (may differ from assistantContent
				// due to text blocks being structured differently).
				const executionNewTaskIndex = this.access.assistantMessageContent.findIndex(
					(block) => block.type === "tool_use" && block.name === "new_task",
				)
				if (executionNewTaskIndex !== -1) {
					this.access.assistantMessageContent.length = executionNewTaskIndex + 1
				}

				// Pre-inject error tool_results for truncated tools
				for (const tool of truncatedTools) {
					if (tool.type === "tool_use" && (tool as Anthropic.ToolUseBlockParam).id) {
						this.access.pushToolResultToUserContent({
							type: "tool_result",
							tool_use_id: (tool as Anthropic.ToolUseBlockParam).id,
							content:
								"This tool was not executed because new_task was called in the same message turn. The new_task tool must be the last tool in a message.",
							is_error: true,
						})
					}
				}
			}

			// Save assistant message BEFORE executing tools
			// This is critical for new_task: when it triggers delegation, flushPendingToolResultsToHistory()
			// will save the user message with tool_results. The assistant message must already be in history
			// so that tool_result blocks appear AFTER their corresponding tool_use blocks.
			await this.access.history.addToApiConversationHistory(
				{ role: "assistant", content: assistantContent },
				this._reasoningMessage || undefined,
			)
			this.access.assistantMessageSavedToHistory = true

			TelemetryService.instance.captureConversationMessage(this.access.taskId, "assistant")
		}
	}

	/**
	 * Create the updateApiReqMsg closure.
	 * Returns a function that updates the API request message with token/cost data.
	 */
	createUpdateApiReqMsgFn(lastApiReqIndex: number, streamModelInfo: ModelInfo): UpdateApiReqMsgFn {
		return (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
			if (lastApiReqIndex < 0 || !this.access.clineMessages[lastApiReqIndex]) {
				return
			}

			const existingData = JSON.parse(this.access.clineMessages[lastApiReqIndex].text || "{}")

			// Calculate total tokens and cost using provider-aware function
			const modelId = getModelId(this.access.apiConfiguration)
			const apiProvider = this.access.apiConfiguration.apiProvider
			const apiProtocol = getApiProtocol(
				apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
				modelId,
			)

			const costResult =
				apiProtocol === "anthropic"
					? calculateApiCostAnthropic(
							streamModelInfo,
							this._inputTokens,
							this._outputTokens,
							this._cacheWriteTokens,
							this._cacheReadTokens,
						)
					: calculateApiCostOpenAI(
							streamModelInfo,
							this._inputTokens,
							this._outputTokens,
							this._cacheWriteTokens,
							this._cacheReadTokens,
						)

			this.access.clineMessages[lastApiReqIndex].text = JSON.stringify({
				...existingData,
				tokensIn: costResult.totalInputTokens,
				tokensOut: costResult.totalOutputTokens,
				cacheWrites: this._cacheWriteTokens,
				cacheReads: this._cacheReadTokens,
				cost: this._totalCost ?? costResult.totalCost,
				cancelReason,
				streamingFailedMessage,
			} satisfies ClineApiReqInfo)
		}
	}

	/**
	 * Create the abortStream closure.
	 * Returns a function that gracefully aborts the stream.
	 */
	createAbortStreamFn(lastApiReqIndex: number, updateApiReqMsg: UpdateApiReqMsgFn): AbortStreamFn {
		return async (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
			if (this.access.diffViewProvider.isEditing) {
				await this.access.diffViewProvider.revertChanges() // closes diff view
			}

			// if last message is a partial we need to update and save it
			const lastMessage = this.access.clineMessages.at(-1)

			if (lastMessage && lastMessage.partial) {
				// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list
				lastMessage.partial = false
				// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
			}

			// Update `api_req_started` to have cancelled and cost, so that
			// we can display the cost of the partial stream and the cancellation reason
			updateApiReqMsg(cancelReason, streamingFailedMessage)
			await this.access.history.saveClineMessages()

			// Signals to provider that it can retrieve the saved messages
			// from disk, as abortTask can not be awaited on in nature.
			this.access.didFinishAbortingStream = true
		}
	}

	/**
	 * Create the background usage drain function.
	 * This drains the remaining stream in the background to find all usage data.
	 *
	 * @param lastApiReqIndex - The index of the last API request message
	 * @param currentTokens - Snapshot of current token counts
	 * @param streamModelInfo - Model info for cost calculation
	 * @param iterator - The async iterator for the stream
	 * @param currentItem - The current iterator result (captured from the main loop)
	 * @param updateApiReqMsg - The function to update API request messages
	 * @returns A function that drains remaining usage data from the stream
	 */
	createBackgroundUsageDrain(
		lastApiReqIndex: number,
		currentTokens: TokenSnapshot,
		streamModelInfo: ModelInfo,
		iterator: AsyncGenerator<any>,
		currentItem: IteratorResult<any> | undefined,
		updateApiReqMsg: UpdateApiReqMsgFn,
	): (apiReqIndex: number) => Promise<void> {
		const access = this.access

		// Snapshot per-request metrics now: this drain is fire-and-forget and can
		// outlive resetStreamingState() for the next request, which clears them.
		const ttftMs =
			this._firstChunkTs !== undefined ? Math.round(this._firstChunkTs - this._requestStartTs) : undefined
		const reasoningChars = this._reasoningMessage.length
		const toolCount = (access.assistantMessageContent ?? []).filter(
			(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
		).length

		return async (apiReqIndex: number) => {
			const timeoutMs = DEFAULT_USAGE_COLLECTION_TIMEOUT_MS
			const startTime = performance.now()
			const modelId = getModelId(access.apiConfiguration)

			// Local variables to accumulate usage data without affecting the main flow
			let bgInputTokens = currentTokens.input
			let bgOutputTokens = currentTokens.output
			let bgCacheWriteTokens = currentTokens.cacheWrite
			let bgCacheReadTokens = currentTokens.cacheRead
			let bgTotalCost = currentTokens.total

			// Helper function to capture telemetry and update messages
			const captureUsageData = async (
				tokens: {
					input: number
					output: number
					cacheWrite: number
					cacheRead: number
					total?: number
				},
				messageIndex: number = apiReqIndex,
			) => {
				if (tokens.input > 0 || tokens.output > 0 || tokens.cacheWrite > 0 || tokens.cacheRead > 0) {
					// Update the shared variables atomically
					this._inputTokens = tokens.input
					this._outputTokens = tokens.output
					this._cacheWriteTokens = tokens.cacheWrite
					this._cacheReadTokens = tokens.cacheRead
					this._totalCost = tokens.total

					// Update the API request message with the latest usage data
					updateApiReqMsg()
					// Do not persist task history once the owning task has been aborted/abandoned.
					// This drain is fire-and-forget (launched, not awaited, in TaskApiLoop) and can
					// outlive the task by up to DEFAULT_USAGE_COLLECTION_TIMEOUT_MS. For a parent
					// disposed by delegation, a late save here re-stamps the task's status from its
					// initialStatus ("active") via taskMetadata, clobbering the "delegated" metadata
					// delegateParentAndOpenChild just wrote — which makes the child's attempt_completion
					// finalize the whole task instead of returning to the parent. The guard lives here
					// (not in saveClineMessages) because abortTask deliberately persists final state.
					// See ai_plans/2026-06-08_delegated-subtask-no-return.md.
					if (!access.abort && !access.abandoned) {
						await access.history.saveClineMessages()
					}

					// Update the specific message in the webview
					const apiReqMessage = access.clineMessages[messageIndex]
					if (apiReqMessage) {
						await access.history.updateClineMessage(apiReqMessage)
					}

					// Capture telemetry with provider-aware cost calculation
					const modelId = getModelId(access.apiConfiguration)
					const apiProvider = access.apiConfiguration.apiProvider
					const apiProtocol = getApiProtocol(
						apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
						modelId,
					)

					// Use the appropriate cost function based on the API protocol
					const costResult =
						apiProtocol === "anthropic"
							? calculateApiCostAnthropic(
									streamModelInfo,
									tokens.input,
									tokens.output,
									tokens.cacheWrite,
									tokens.cacheRead,
								)
							: calculateApiCostOpenAI(
									streamModelInfo,
									tokens.input,
									tokens.output,
									tokens.cacheWrite,
									tokens.cacheRead,
								)

					TelemetryService.instance.captureLlmCompletion(access.taskId, {
						inputTokens: costResult.totalInputTokens,
						outputTokens: costResult.totalOutputTokens,
						cacheWriteTokens: tokens.cacheWrite,
						cacheReadTokens: tokens.cacheRead,
						cost: tokens.total ?? costResult.totalCost,
						ttftMs,
						reasoningChars,
						toolCount,
						// Stated rather than left to default, so a reader never has
						// to tell "a turn of the conversation" from "written before
						// the kind existed" — both are task turns, but only this one
						// is a claim.
						completionKind: "task",
						usageReported: true,
					})
				}
			}

			try {
				// Continue processing the original stream from where the main loop left off
				let usageFound = false
				let chunkCount = 0

				// Use the same iterator that the main loop was using
				// Start from the current item state captured when the main loop ended
				let item = currentItem
				while (item && !item.done) {
					// Check for timeout
					if (performance.now() - startTime > timeoutMs) {
						console.warn(
							`[Background Usage Collection] Timed out after ${timeoutMs}ms for model: ${modelId}, processed ${chunkCount} chunks`,
						)
						// Clean up the iterator before breaking
						if (iterator.return) {
							await iterator.return(undefined)
						}
						break
					}

					const chunk = item.value
					item = await iterator.next()
					chunkCount++

					if (chunk && chunk.type === "usage") {
						usageFound = true
						bgInputTokens += chunk.inputTokens
						bgOutputTokens += chunk.outputTokens
						bgCacheWriteTokens += chunk.cacheWriteTokens ?? 0
						bgCacheReadTokens += chunk.cacheReadTokens ?? 0
						bgTotalCost = chunk.totalCost
					}
				}

				if (
					usageFound ||
					bgInputTokens > 0 ||
					bgOutputTokens > 0 ||
					bgCacheWriteTokens > 0 ||
					bgCacheReadTokens > 0
				) {
					// We have usage data either from a usage chunk or accumulated tokens
					await captureUsageData(
						{
							input: bgInputTokens,
							output: bgOutputTokens,
							cacheWrite: bgCacheWriteTokens,
							cacheRead: bgCacheReadTokens,
							total: bgTotalCost,
						},
						lastApiReqIndex,
					)
				} else {
					console.warn(
						`[Background Usage Collection] Suspicious: request ${apiReqIndex} is complete, but no usage info was found. Model: ${modelId}`,
					)
				}
			} catch (error) {
				console.error("Error draining stream for usage data:", error)
				// Still try to capture whatever usage data we have collected so far
				if (bgInputTokens > 0 || bgOutputTokens > 0 || bgCacheWriteTokens > 0 || bgCacheReadTokens > 0) {
					await captureUsageData(
						{
							input: bgInputTokens,
							output: bgOutputTokens,
							cacheWrite: bgCacheWriteTokens,
							cacheRead: bgCacheReadTokens,
							total: bgTotalCost,
						},
						lastApiReqIndex,
					)
				}
			}
		}
	}
}
