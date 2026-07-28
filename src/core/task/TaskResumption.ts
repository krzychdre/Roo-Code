/**
 * TaskResumption - Handles task resumption from history
 *
 * This module extracts the task resumption logic from TaskLifecycle,
 * including stale message removal, interrupted tool call handling,
 * summary message preservation, and user content building for resumption.
 *
 * Extracted from: TaskLifecycle.ts (Phase 2A refactoring)
 */

import Anthropic from "@anthropic-ai/sdk"
import { type ClineMessage, type ClineApiReqInfo, type ClineAskResponse, RooCodeEventName } from "@roo-code/types"
import { findLastIndex } from "../../shared/array"
import { getLatestTodo } from "../../shared/todo"
import { formatResponse } from "../prompts/responses"
import { type ApiMessage } from "../task-persistence"
import { buildContextLedger } from "../context-management/ledger/buildLedger"
import { applyExecutionSnapshot, detectStaleFileChanges, type StaleFile } from "../context-management/executionSnapshot"
import { type TaskHistory } from "./TaskHistory"
import { type TaskAskSay } from "./TaskAskSay"

/**
 * Interface for Task access needed by TaskResumption.
 * This is a narrow interface to minimize coupling.
 */
export interface TaskResumptionAccess {
	// Core identifiers
	taskId: string
	instanceId: string

	/** Workspace root, used to resolve the ledger's file paths for the staleness check. */
	cwd: string

	// State flags
	isInitialized: boolean
	abort: boolean
	abandoned: boolean
	abortReason?: string

	// Conversation history
	clineMessages: ClineMessage[]
	apiConversationHistory: ApiMessage[]

	// Provider reference
	providerRef: WeakRef<any> // ClineProvider

	// Delegated modules
	history: TaskHistory
	askSay: TaskAskSay

	// Methods
	emit: (event: RooCodeEventName, ...args: any[]) => boolean
	initiateTaskLoop: (userContent: Anthropic.Messages.ContentBlockParam[]) => Promise<void>
}

/**
 * Result of preparing resumption content
 */
interface ResumptionContent {
	modifiedApiConversationHistory: ApiMessage[]
	newUserContent: Anthropic.Messages.ContentBlockParam[]
}

/**
 * TaskResumption handles the complex logic of resuming a task from history.
 */
export class TaskResumption {
	constructor(private readonly access: TaskResumptionAccess) {}

	/**
	 * Resume a task from history, reconstructing conversation state.
	 * This handles the complex logic of:
	 * - Removing stale resume messages
	 * - Handling interrupted tool calls
	 * - Preserving summary messages
	 * - Building proper user content for resumption
	 * - Replacing the conversation replay with an execution snapshot when the history is large
	 */
	async resumeTaskFromHistory(): Promise<void> {
		try {
			// Step 1: Clean up stale messages
			const modifiedClineMessages = await this.cleanupStaleMessages()

			// Step 2: Save and load updated messages
			await this.access.history.overwriteClineMessages(modifiedClineMessages)
			this.access.clineMessages = await this.access.history.getSavedClineMessages()

			// Step 3: Load API conversation history
			this.access.apiConversationHistory = await this.access.history.getSavedApiConversationHistory()

			// Step 4: Determine resume type and ask user
			const lastClineMessage = this.findLastRelevantMessage()
			const askType = this.determineAskType(lastClineMessage)

			this.access.isInitialized = true

			const { response, text, images } = await this.access.askSay.ask(askType)

			// Step 5: Process user response
			let responseText: string | undefined
			let responseImages: string[] | undefined

			if (response === "messageResponse") {
				await this.access.askSay.say("user_feedback", text, images)
				responseText = text
				responseImages = images
			}

			// Step 6: Prepare resumption content
			const existingApiConversationHistory = await this.access.history.getSavedApiConversationHistory()
			const { modifiedApiConversationHistory, newUserContent } = this.prepareResumptionContent(
				existingApiConversationHistory,
				lastClineMessage,
				responseText,
				responseImages,
			)

			// Step 7: Replace the replay with an execution snapshot when it is worth it
			const resumeHistory = await this.applyExecutionSnapshot(
				modifiedApiConversationHistory,
				lastClineMessage?.ts,
			)

			// Step 8: Save and resume
			await this.access.history.overwriteApiConversationHistory(resumeHistory)

			await this.access.initiateTaskLoop(newUserContent)
		} catch (error) {
			// Resume and cancellation can race when users issue repeated cancels.
			// Treat intentional abort/abandon flows as expected and avoid process-level crashes.
			if (
				this.access.abandoned === true ||
				this.access.abort === true ||
				this.access.abortReason === "user_cancelled"
			) {
				return
			}
			throw error
		}
	}

	/**
	 * Clean up stale messages from cline messages history.
	 * Removes resume messages, trailing reasoning messages, and incomplete API requests.
	 */
	private async cleanupStaleMessages(): Promise<ClineMessage[]> {
		const modifiedClineMessages = await this.access.history.getSavedClineMessages()

		// Remove any resume messages that may have been added before
		const lastRelevantMessageIndex = findLastIndex(
			modifiedClineMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
		)

		if (lastRelevantMessageIndex !== -1) {
			modifiedClineMessages.splice(lastRelevantMessageIndex + 1)
		}

		// Remove any trailing reasoning-only UI messages that were not part of the persisted API conversation
		while (modifiedClineMessages.length > 0) {
			const last = modifiedClineMessages[modifiedClineMessages.length - 1]
			if (last.type === "say" && last.say === "reasoning") {
				modifiedClineMessages.pop()
			} else {
				break
			}
		}

		// Since we don't use `api_req_finished` anymore, we need to check if the
		// last `api_req_started` has a cost value, if it doesn't and no
		// cancellation reason to present, then we remove it since it indicates
		// an api request without any partial content streamed.
		const lastApiReqStartedIndex = findLastIndex(
			modifiedClineMessages,
			(m) => m.type === "say" && m.say === "api_req_started",
		)

		if (lastApiReqStartedIndex !== -1) {
			const lastApiReqStarted = modifiedClineMessages[lastApiReqStartedIndex]
			const { cost, cancelReason }: ClineApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")

			if (cost === undefined && cancelReason === undefined) {
				modifiedClineMessages.splice(lastApiReqStartedIndex, 1)
			}
		}

		return modifiedClineMessages
	}

	/**
	 * Find the last relevant (non-resume) message in cline messages.
	 */
	private findLastRelevantMessage(): ClineMessage | undefined {
		return this.access.clineMessages
			.slice()
			.reverse()
			.find((m: ClineMessage) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"))
	}

	/**
	 * Determine the ask type based on the last message.
	 */
	private determineAskType(lastClineMessage: ClineMessage | undefined): "resume_task" | "resume_completed_task" {
		if (lastClineMessage?.ask === "completion_result") {
			return "resume_completed_task"
		}
		return "resume_task"
	}

	/**
	 * Prepare resumption content by handling interrupted tool calls and building user content.
	 */
	private prepareResumptionContent(
		existingApiConversationHistory: ApiMessage[],
		lastClineMessage: ClineMessage | undefined,
		responseText?: string,
		responseImages?: string[],
	): ResumptionContent {
		let modifiedOldUserContent: Anthropic.Messages.ContentBlockParam[] = []
		let modifiedApiConversationHistory: ApiMessage[]

		if (existingApiConversationHistory.length > 0) {
			const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

			if (lastMessage.isSummary) {
				// IMPORTANT: If the last message is a condensation summary, we must preserve it
				// intact. The summary message carries critical metadata (isSummary, condenseId)
				// that getEffectiveApiHistory() uses to filter out condensed messages.
				// Removing or merging it would destroy this metadata, causing all condensed
				// messages to become "orphaned" and restored to active status — effectively
				// undoing the condensation and sending the full history to the API.
				// See: https://github.com/RooCodeInc/Roo-Code/issues/11487
				modifiedApiConversationHistory = [...existingApiConversationHistory]
				modifiedOldUserContent = []
			} else if (lastMessage.role === "assistant") {
				const result = this.handleAssistantLastMessage(existingApiConversationHistory)
				modifiedApiConversationHistory = result.modifiedApiConversationHistory
				modifiedOldUserContent = result.modifiedOldUserContent
			} else if (lastMessage.role === "user") {
				const result = this.handleUserLastMessage(existingApiConversationHistory)
				modifiedApiConversationHistory = result.modifiedApiConversationHistory
				modifiedOldUserContent = result.modifiedOldUserContent
			} else {
				throw new Error("Unexpected: Last message is not a user or assistant message")
			}
		} else {
			throw new Error("Unexpected: No existing API conversation history")
		}

		// Build new user content
		const newUserContent: Anthropic.Messages.ContentBlockParam[] = [...modifiedOldUserContent]

		// Add "ago" text for context
		const agoText = this.buildAgoText(lastClineMessage)

		if (responseText) {
			newUserContent.push({
				type: "text",
				text: `<user_message>\n${responseText}\n</user_message>`,
			})
		}

		if (responseImages && responseImages.length > 0) {
			newUserContent.push(...formatResponse.imageBlocks(responseImages))
		}

		// Ensure we have at least some content to send to the API.
		// If newUserContent is empty, add a minimal resumption message.
		if (newUserContent.length === 0) {
			newUserContent.push({
				type: "text",
				text: "[TASK RESUMPTION] Resuming task...",
			})
		}

		return { modifiedApiConversationHistory, newUserContent }
	}

	/**
	 * Starts the resumed task from a semantic execution snapshot instead of a full replay of the
	 * conversation.
	 *
	 * The snapshot is derived from the typed ledger, so building it costs no model call and cannot
	 * invent a fact. Older messages are hidden with the same `condenseParent` tagging condense
	 * uses — they stay on disk, so rewind and the UI transcript are untouched.
	 *
	 * Anything unexpected here returns the history unchanged, which is exactly today's behaviour:
	 * a resume must never fail because an optimisation did.
	 */
	private async applyExecutionSnapshot(history: ApiMessage[], lastActivityTs?: number): Promise<ApiMessage[]> {
		try {
			// The todo list must come from the UI messages, not from `Task.todoList`: nothing
			// rehydrates that field on resume (only `UpdateTodoListTool` and `initialTodos` ever
			// write it), so the reminder section is empty until the tool runs again. Without this
			// the plan would survive a resume only via the replayed `update_todo_list` calls —
			// which are exactly what the snapshot hides.
			const todos = getLatestTodo(this.access.clineMessages)
			const ledger = buildContextLedger(history, { todos })

			// Files the ledger says we changed may have been edited by hand during the pause. That
			// is the one thing a recomputed snapshot cannot know from the conversation alone, so it
			// is measured against the disk and rendered as an explicit warning.
			let stale: StaleFile[] = []
			try {
				stale = await detectStaleFileChanges(ledger, this.access.cwd, lastActivityTs ?? Date.now())
			} catch (error) {
				// A snapshot without the warning is still better than a full replay; only the
				// staleness annotation is lost.
				console.warn(`[TaskResumption#${this.access.taskId}] staleness check failed:`, error)
			}

			const result = applyExecutionSnapshot({ messages: history, ledger, stale })

			if (result.applied) {
				console.log(
					`[TaskResumption#${this.access.taskId}] execution snapshot applied: ` +
						`${result.hiddenMessages} messages hidden, ${result.charsBefore} -> ${result.charsAfter} chars` +
						(stale.length > 0 ? `, ${stale.length} file(s) changed while paused` : ""),
				)
			}

			return result.messages
		} catch (error) {
			console.warn(`[TaskResumption#${this.access.taskId}] execution snapshot skipped:`, error)
			return history
		}
	}

	/**
	 * Handle the case where the last message is an assistant message.
	 */
	private handleAssistantLastMessage(existingApiConversationHistory: ApiMessage[]): {
		modifiedApiConversationHistory: ApiMessage[]
		modifiedOldUserContent: Anthropic.Messages.ContentBlockParam[]
	} {
		const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]
		const content = Array.isArray(lastMessage.content)
			? lastMessage.content
			: [{ type: "text", text: lastMessage.content }]
		const hasToolUse = content.some((block) => block.type === "tool_use")

		if (hasToolUse) {
			const toolUseBlocks = content.filter(
				(block) => block.type === "tool_use",
			) as Anthropic.Messages.ToolUseBlock[]
			const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
				type: "tool_result",
				tool_use_id: block.id,
				content: "Task was interrupted before this tool call could be completed.",
			}))
			return {
				modifiedApiConversationHistory: [...existingApiConversationHistory],
				modifiedOldUserContent: [...toolResponses],
			}
		}

		return {
			modifiedApiConversationHistory: [...existingApiConversationHistory],
			modifiedOldUserContent: [],
		}
	}

	/**
	 * Handle the case where the last message is a user message.
	 */
	private handleUserLastMessage(existingApiConversationHistory: ApiMessage[]): {
		modifiedApiConversationHistory: ApiMessage[]
		modifiedOldUserContent: Anthropic.Messages.ContentBlockParam[]
	} {
		const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]
		const previousAssistantMessage: ApiMessage | undefined =
			existingApiConversationHistory[existingApiConversationHistory.length - 2]

		const existingUserContent: Anthropic.Messages.ContentBlockParam[] = Array.isArray(lastMessage.content)
			? lastMessage.content
			: [{ type: "text", text: lastMessage.content }]

		if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
			const assistantContent = Array.isArray(previousAssistantMessage.content)
				? previousAssistantMessage.content
				: [{ type: "text", text: previousAssistantMessage.content }]

			const toolUseBlocks = assistantContent.filter(
				(block) => block.type === "tool_use",
			) as Anthropic.Messages.ToolUseBlock[]

			if (toolUseBlocks.length > 0) {
				const existingToolResults = existingUserContent.filter(
					(block) => block.type === "tool_result",
				) as Anthropic.ToolResultBlockParam[]

				const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
					.filter((toolUse) => !existingToolResults.some((result) => result.tool_use_id === toolUse.id))
					.map((toolUse) => ({
						type: "tool_result",
						tool_use_id: toolUse.id,
						content: "Task was interrupted before this tool call could be completed.",
					}))

				return {
					modifiedApiConversationHistory: existingApiConversationHistory.slice(0, -1),
					modifiedOldUserContent: [...existingUserContent, ...missingToolResponses],
				}
			}

			return {
				modifiedApiConversationHistory: existingApiConversationHistory.slice(0, -1),
				modifiedOldUserContent: [...existingUserContent],
			}
		}

		return {
			modifiedApiConversationHistory: existingApiConversationHistory.slice(0, -1),
			modifiedOldUserContent: [...existingUserContent],
		}
	}

	/**
	 * Build "ago" text for resumption context.
	 */
	private buildAgoText(lastClineMessage: ClineMessage | undefined): string {
		const timestamp = lastClineMessage?.ts ?? Date.now()
		const now = Date.now()
		const diff = now - timestamp
		const minutes = Math.floor(diff / 60000)
		const hours = Math.floor(minutes / 60)
		const days = Math.floor(hours / 24)

		if (days > 0) {
			return `${days} day${days > 1 ? "s" : ""} ago`
		}
		if (hours > 0) {
			return `${hours} hour${hours > 1 ? "s" : ""} ago`
		}
		if (minutes > 0) {
			return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
		}
		return "just now"
	}
}
