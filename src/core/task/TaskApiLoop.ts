import { Anthropic } from "@anthropic-ai/sdk"
import delay from "delay"
import pWaitFor from "p-wait-for"
import { serializeError } from "serialize-error"
import {
	type ProviderSettings,
	type TokenUsage,
	type ToolName,
	type ClineApiReqCancelReason,
	type ClineApiReqInfo,
	type ClineMessage,
	RooCodeEventName,
	TelemetryEventName,
	ConsecutiveMistakeError,
	getApiProtocol,
	getModelId,
	isRetiredProvider,
	DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { type ApiHandler, type ApiHandlerCreateMessageMetadata } from "../../api"
import { type ApiStream } from "../../api/transform/stream"
import { checkContextWindowExceededError } from "../context/context-management/context-error-handling"
import { getMessagesSinceLastSummary, getEffectiveApiHistory } from "../condense"
import { processUserContentMentions } from "../mentions/processUserContentMentions"
import { mergeConsecutiveApiMessages } from "./mergeConsecutiveApiMessages"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import { formatResponse } from "../prompts/responses"
import { getEnvironmentDetails } from "../environment/getEnvironmentDetails"
import { type TaskHistory } from "./TaskHistory"
import { type TaskAskSay } from "./TaskAskSay"
import { type TaskStreamProcessor } from "./TaskStreamProcessor"
import { type UpdateApiReqMsgFn } from "./StreamProcessorTypes"
import { type TaskContextManager, MAX_CONTEXT_WINDOW_RETRIES } from "./TaskContextManager"
import { getModelMaxOutputTokens } from "../../shared/api"
import { findLastIndex } from "../../shared/array"
import { t } from "../../i18n"
import { getModeBySlug, defaultModeSlug } from "../../shared/modes"
import { type ClineProvider } from "../webview/ClineProvider"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { AutoApprovalHandler } from "../auto-approval"
import { presentAssistantMessage } from "../assistant-message"
import { type AssistantMessageContent } from "../assistant-message"
import { type ApiMessage } from "../task-persistence"
import { ApiRequestBuilder, type ApiRequestBuilderAccess } from "./ApiRequestBuilder"
import {
	RetryHandler,
	getLastGlobalApiRequestTime,
	setLastGlobalApiRequestTime,
	resetGlobalApiRequestTime,
} from "./RetryHandler"
import { type MemoryCoordinator } from "../memory/memoryTaskIntegration"

// Re-export functions for backward compatibility
export { getLastGlobalApiRequestTime, setLastGlobalApiRequestTime, resetGlobalApiRequestTime } from "./RetryHandler"

/**
 * Interface for Task access needed by TaskApiLoop.
 * This is a narrow interface to minimize coupling between modules.
 */
export interface TaskApiLoopAccess {
	// Core identifiers
	taskId: string
	instanceId: string

	// Abort state
	abort: boolean
	abandoned: boolean
	abortReason?: ClineApiReqCancelReason

	// API configuration and handler
	apiConfiguration: ProviderSettings
	api: ApiHandler

	// Conversation history
	apiConversationHistory: ApiMessage[]
	clineMessages: ClineMessage[]

	// Non-destructive microcompaction: transient set of tool_use_ids whose results
	// are cleared on the outgoing request copy (stored history stays pristine).
	microcompactedToolUseIds: Set<string>

	// Estimated tokens the previous request's send-time strip removed. Added back to
	// the provider-reported context size before the threshold check so the gate sees
	// the pristine history size. See Task#microcompactStrippedTokens.
	microcompactStrippedTokens: number

	// Mistake tracking
	consecutiveMistakeCount: number
	consecutiveMistakeLimit: number
	consecutiveNoToolUseCount: number
	consecutiveNoAssistantMessagesCount: number

	// State flags
	skipPrevResponseIdOnce: boolean
	isInitialized: boolean
	isPaused: boolean
	currentRequestAbortController?: AbortController
	didFinishAbortingStream: boolean
	isStreaming: boolean
	isWaitingForFirstChunk: boolean

	// Workspace and controllers
	cwd: string
	fileContextTracker: FileContextTracker
	rooIgnoreController?: RooIgnoreController

	// Diff and tools
	diffViewProvider: any // DiffViewProvider
	diffStrategy?: any // DiffStrategy
	toolRepetitionDetector: any // ToolRepetitionDetector
	autoApprovalHandler: AutoApprovalHandler

	// Provider reference
	providerRef: WeakRef<ClineProvider>

	// Streaming state (for presentAssistantMessage)
	assistantMessageContent: AssistantMessageContent[]
	userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam)[]
	userMessageContentReady: boolean
	didRejectTool: boolean
	didAlreadyUseTool: boolean
	cachedStreamingModel?: { id: string; info: any }

	// Delegated modules
	history: TaskHistory
	askSay: TaskAskSay
	streamProcessor: TaskStreamProcessor
	contextManager: TaskContextManager
	// Memory recall coordinator (undefined if memory is disabled / no handler).
	memoryCoordinator?: MemoryCoordinator
	// Monotonic loop iteration counter, advanced each executeApiRequestCycle
	// entry. Used by the memory recall consume-once guard.
	apiLoopIteration?: number
	// Headless background task (parallel subagent / memory writer). Background
	// tasks must not receive delegation tools (no nested fan-outs).
	isBackground: boolean
	// Headless turn cap for background tasks (undefined = no cap / foreground).
	maxAgentTurns?: number
	// Assistant-turn counter enforced against `maxAgentTurns`.
	agentTurnCount: number

	// Methods needed
	emit: (event: any, ...args: any[]) => boolean
	updateApiConfiguration(newApiConfiguration: ProviderSettings): void
	getTokenUsage(): TokenUsage
	recordToolUsage(toolName: ToolName): void
	recordToolError(toolName: ToolName, error?: string): void
	emitFinalTokenUsageUpdate(): void
	abortTask(isAbandoned?: boolean): Promise<void>
	cancelCurrentRequest(destroyClient?: boolean): void
	pushToolResultToUserContent(toolResult: Anthropic.ToolResultBlockParam): boolean
	combineMessages(messages: ClineMessage[]): ClineMessage[]

	// Deferred-tool loading state (Phase 4 of ai_plans/deferred-tool-loading.md)
	materializedDeferredTools: Set<string>
	deferredToolDirectory: Map<string, import("openai").default.Chat.ChatCompletionTool>
}

/**
 * Stack item for the recursive request loop
 */
interface StackItem {
	userContent: Anthropic.Messages.ContentBlockParam[]
	includeFileDetails: boolean
	retryAttempt?: number
	userMessageWasRemoved?: boolean
}

/**
 * Race an async iterator's next() against an AbortSignal.
 *
 * AP-5: Every call adds `{ once: true }` to addEventListener AND removes the
 * listener in a `finally` block, so the listener is gone as soon as the chunk
 * resolves. Without this, thousands of listeners accumulate on one AbortSignal
 * during long generations → MaxListenersExceededWarning + GC pressure.
 *
 * Exported for unit testing (the closure inside processStream is not
 * directly testable).
 */
export async function raceNextChunkWithAbort<T>(
	iterator: AsyncIterator<T>,
	signal: AbortSignal,
): Promise<IteratorResult<T>> {
	const nextPromise = iterator.next()

	if (signal.aborted) {
		// Already aborted — reject immediately, no listener to leak
		throw new Error("Request cancelled by user")
	}

	const onAbort = () => {
		rejectRef(new Error("Request cancelled by user"))
	}

	let rejectRef: (error: Error) => void
	const abortPromise = new Promise<never>((_, reject) => {
		rejectRef = reject
		signal.addEventListener("abort", onAbort, { once: true })
	})

	try {
		return await Promise.race([nextPromise, abortPromise])
	} finally {
		signal.removeEventListener("abort", onAbort)
	}
}

/**
 * TaskApiLoop handles the API request loop orchestration for Task.
 * This includes the main request loop, API request generation, and retry logic.
 */
export class TaskApiLoop {
	// Delegate API request building to ApiRequestBuilder
	private readonly apiRequestBuilder: ApiRequestBuilder
	// Delegate retry/backoff logic to RetryHandler
	private readonly retryHandler: RetryHandler

	constructor(private readonly access: TaskApiLoopAccess) {
		// Create the ApiRequestBuilder with a compatible access interface
		this.apiRequestBuilder = new ApiRequestBuilder({
			taskId: access.taskId,
			instanceId: access.instanceId,
			isBackground: access.isBackground,
			apiConfiguration: access.apiConfiguration,
			api: access.api,
			apiConversationHistory: access.apiConversationHistory,
			microcompactedToolUseIds: access.microcompactedToolUseIds,
			providerRef: access.providerRef,
			cwd: access.cwd,
			diffStrategy: access.diffStrategy,
			contextManager: access.contextManager,
			getTokenUsage: access.getTokenUsage,
			emit: access.emit,
			materializedDeferredTools: access.materializedDeferredTools,
			deferredToolDirectory: access.deferredToolDirectory,
		})
		// Create the RetryHandler with a compatible access interface
		this.retryHandler = new RetryHandler({
			taskId: access.taskId,
			instanceId: access.instanceId,
			abort: access.abort,
			apiConfiguration: access.apiConfiguration,
			providerRef: access.providerRef,
			askSay: access.askSay,
		})
	}

	/**
	 * Initiates the main task loop that drives recursive API requests.
	 * This is the entry point for task execution.
	 */
	async initiateTaskLoop(userContent: Anthropic.Messages.ContentBlockParam[]): Promise<void> {
		// Kicks off the checkpoints initialization process in the background.
		const { getCheckpointService } = await import("../checkpoints")
		getCheckpointService(this.access as any)

		let nextUserContent = userContent
		let includeFileDetails = true

		this.access.emit(RooCodeEventName.TaskStarted)

		while (!this.access.abort) {
			const didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails)
			includeFileDetails = false // We only need file details the first time.

			// The way this agentic loop works is that cline will be given a
			// task that he then calls tools to complete. Unless there's an
			// attempt_completion call, we keep responding back to him with his
			// tool's responses until he either attempt_completion or does not
			// use anymore tools. If he does not use anymore tools, we ask him
			// to consider if he's completed the task and then call
			// attempt_completion, otherwise proceed with completing the task.
			// There is a MAX_REQUESTS_PER_TASK limit to prevent infinite
			// requests, but Cline is prompted to finish the task as efficiently
			// as he can.

			if (didEndLoop) {
				// For now a task never 'completes'. This will only happen if
				// the user hits max requests and denies resetting the count.
				break
			} else {
				nextUserContent = [{ type: "text", text: formatResponse.noToolsUsed() }]
			}
		}
	}

	/**
	 * The main API request loop using stack-based iteration.
	 * This replaces recursive calls with an explicit stack for better control flow.
	 */
	async recursivelyMakeClineRequests(
		userContent: Anthropic.Messages.ContentBlockParam[],
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		const stack: StackItem[] = [{ userContent, includeFileDetails, retryAttempt: 0 }]

		// Memory recall prefetch: fire once per user turn (the prompt is
		// invariant across iterations). Non-blocking; the consume point in
		// executeApiRequestCycle polls the settled handle. The prefetch reads
		// the last non-meta user message text from clineMessages; single-word
		// prompts and the session byte cap are skipped inside the coordinator.
		if (this.access.memoryCoordinator) {
			this.access.memoryCoordinator.startPrefetch(
				this.access.clineMessages as unknown as import("../memory/prefetch").PrefetchMessage[],
				this.access.currentRequestAbortController,
			)
		}

		while (stack.length > 0) {
			const currentItem = stack.pop()!
			const currentUserContent = currentItem.userContent
			const currentIncludeFileDetails = currentItem.includeFileDetails

			if (this.access.abort) {
				throw new Error(
					`[RooCode#recursivelyMakeRooRequests] task ${this.access.taskId}.${this.access.instanceId} aborted`,
				)
			}

			// Headless turn cap: a background task (memory writer / parallel
			// subagent) aborts cleanly once it exhausts its assistant-turn budget.
			// Foreground tasks pass `maxAgentTurns === undefined` and are unaffected.
			if (this.access.maxAgentTurns !== undefined) {
				if (this.access.agentTurnCount >= this.access.maxAgentTurns) {
					console.log(
						`[Task#${this.access.taskId}.${this.access.instanceId}] maxAgentTurns (${this.access.maxAgentTurns}) reached; aborting background task`,
					)
					// Use a distinct abortReason so callers (notably the memory
					// runner's retry decision in ClineProvider.awaitTaskCompletion)
					// can distinguish "turn budget exhausted" (a weak model that
					// didn't finish — do NOT retry on expensive foreground, it'll
					// just exhaust the same budget) from "streaming_failed" (a
					// genuine provider outage — DO retry on foreground). The
					// primary guard is the isBackground check in abortTask, but a
					// distinct reason makes the intent explicit and
					// belt-and-suspenders safe against the isUserCancelled guard.
					this.access.abortReason = "max_turns_reached"
					await this.access.abortTask()
					return true
				}
				this.access.agentTurnCount += 1
			}

			// Handle consecutive mistake limit
			await this.handleConsecutiveMistakeLimit(currentUserContent)

			// Prepare and execute the API request
			const result = await this.executeApiRequestCycle(
				currentItem,
				currentUserContent,
				currentIncludeFileDetails,
				stack,
			)

			if (result === "continue") {
				continue
			}

			if (result === "return_true") {
				return true
			}

			// return_false - normal exit
			return false
		}

		// If we exit the while loop normally (stack is empty), return false
		return false
	}

	/**
	 * Handle consecutive mistake limit check and user feedback
	 */
	private async handleConsecutiveMistakeLimit(
		currentUserContent: Anthropic.Messages.ContentBlockParam[],
	): Promise<void> {
		if (
			this.access.consecutiveMistakeLimit > 0 &&
			this.access.consecutiveMistakeCount >= this.access.consecutiveMistakeLimit
		) {
			// Track consecutive mistake errors in telemetry
			TelemetryService.instance.captureConsecutiveMistakeError(this.access.taskId)
			TelemetryService.instance.captureException(
				new ConsecutiveMistakeError(
					`Task reached consecutive mistake limit (${this.access.consecutiveMistakeLimit})`,
					this.access.taskId,
					this.access.consecutiveMistakeCount,
					this.access.consecutiveMistakeLimit,
					"no_tools_used",
					this.access.apiConfiguration.apiProvider,
					getModelId(this.access.apiConfiguration),
				),
			)

			const { response, text, images } = await this.access.askSay.ask(
				"mistake_limit_reached",
				t("common:errors.mistake_limit_guidance"),
			)

			if (response === "messageResponse") {
				currentUserContent.push(
					...[
						{ type: "text" as const, text: formatResponse.tooManyMistakes(text) },
						...formatResponse.imageBlocks(images),
					],
				)

				await this.access.askSay.say("user_feedback", text, images)
			}

			this.access.consecutiveMistakeCount = 0
		}
	}

	/**
	 * Execute a single API request cycle including stream processing and error handling.
	 * Returns 'continue' to continue the loop, 'return_true' to return true, or 'return_false' to return false.
	 */
	private async executeApiRequestCycle(
		currentItem: StackItem,
		currentUserContent: Anthropic.Messages.ContentBlockParam[],
		currentIncludeFileDetails: boolean,
		stack: StackItem[],
	): Promise<"continue" | "return_true" | "return_false"> {
		// Determine API protocol
		const modelId = getModelId(this.access.apiConfiguration)
		const apiProvider = this.access.apiConfiguration.apiProvider
		const apiProtocol = getApiProtocol(
			apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
			modelId,
		)

		// Respect provider rate limiting
		await this.maybeWaitForProviderRateLimit(currentItem.retryAttempt ?? 0)
		setLastGlobalApiRequestTime(performance.now())

		await this.access.askSay.say(
			"api_req_started",
			JSON.stringify({
				apiProtocol,
			}),
		)

		const provider = this.access.providerRef.deref()
		const state = provider ? await provider.getState() : undefined

		// Process user content mentions and environment details
		const { finalUserContent, shouldAddUserMessage } = await this.prepareUserContent(
			state,
			currentUserContent,
			currentIncludeFileDetails,
			currentItem,
		)

		// Memory recall consume: if the prefetch has settled and hasn't been
		// consumed yet this turn, inject the surfaced memories as hidden
		// <system-reminder> text blocks into the user content that goes to the
		// API. Non-blocking — only `await`s an already-settled promise. The
		// consume-once guard (consumedOnIteration) prevents re-injection across
		// iterations; filterDuplicateMemoryAttachments dedups against files the
		// model already read/wrote.
		if (this.access.memoryCoordinator && shouldAddUserMessage) {
			this.access.apiLoopIteration = (this.access.apiLoopIteration ?? 0) + 1
			const memoryBlocks = await this.access.memoryCoordinator.consumePrefetch(this.access.apiLoopIteration)
			if (memoryBlocks.length > 0) {
				finalUserContent.push(...memoryBlocks)
			}
		}

		// Add user message to history if needed
		if (shouldAddUserMessage) {
			await this.access.history.addToApiConversationHistory({ role: "user", content: finalUserContent })
			TelemetryService.instance.captureConversationMessage(this.access.taskId, "user")
		}

		// Update API request message
		const lastApiReqIndex = findLastIndex(this.access.clineMessages, (m) => m.say === "api_req_started")
		this.access.clineMessages[lastApiReqIndex].text = JSON.stringify({
			apiProtocol,
		} satisfies ClineApiReqInfo)

		await this.access.history.saveClineMessages()
		await this.access.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

		try {
			// Reset streaming state
			await this.access.streamProcessor.resetStreamingState()

			const streamModelInfo = this.access.cachedStreamingModel!.info
			const updateApiReqMsg = this.access.streamProcessor.createUpdateApiReqMsgFn(
				lastApiReqIndex,
				streamModelInfo,
			)
			const abortStream = this.access.streamProcessor.createAbortStreamFn(lastApiReqIndex, updateApiReqMsg)

			// Create API stream
			const stream = this.attemptApiRequest(currentItem.retryAttempt ?? 0, { skipProviderRateLimit: true })
			this.access.isStreaming = true

			try {
				// Process the stream
				const streamResult = await this.processStream(
					stream,
					abortStream,
					updateApiReqMsg,
					lastApiReqIndex,
					streamModelInfo,
					currentItem,
					currentUserContent,
					stack,
				)

				return streamResult
			} finally {
				this.access.isStreaming = false
				this.access.currentRequestAbortController = undefined
			}
		} catch (error) {
			// This should never happen since attemptApiRequest is wrapped in try/catch
			// but we handle it to avoid unhandled promise rejection
			return "return_true"
		}
	}

	/**
	 * Prepare user content including mentions and environment details
	 */
	private async prepareUserContent(
		state: any,
		currentUserContent: Anthropic.Messages.ContentBlockParam[],
		currentIncludeFileDetails: boolean,
		currentItem: StackItem,
	): Promise<{ finalUserContent: Anthropic.Messages.ContentBlockParam[]; shouldAddUserMessage: boolean }> {
		const provider = this.access.providerRef.deref()
		const showRooIgnoredFiles = state?.showRooIgnoredFiles ?? false
		const includeDiagnosticMessages = state?.includeDiagnosticMessages ?? true
		const maxDiagnosticMessages = state?.maxDiagnosticMessages ?? 50
		const currentMode = state?.mode ?? defaultModeSlug

		const { content: parsedUserContent, mode: slashCommandMode } = await processUserContentMentions({
			userContent: currentUserContent,
			cwd: this.access.cwd,
			fileContextTracker: this.access.fileContextTracker,
			rooIgnoreController: this.access.rooIgnoreController,
			showRooIgnoredFiles,
			includeDiagnosticMessages,
			maxDiagnosticMessages,
			skillsManager: provider?.getSkillsManager(),
			currentMode,
		})

		// Switch mode if specified in a slash command's frontmatter
		if (slashCommandMode) {
			const provider = this.access.providerRef.deref()
			if (provider) {
				const state = await provider.getState()
				const targetMode = getModeBySlug(slashCommandMode, state?.customModes)
				if (targetMode) {
					await provider.handleModeSwitch(slashCommandMode)
				}
			}
		}

		const environmentDetails = await getEnvironmentDetails(this.access as any, currentIncludeFileDetails)

		// Remove any existing environment_details blocks
		const contentWithoutEnvDetails = parsedUserContent.filter((block) => {
			if (block.type === "text" && typeof block.text === "string") {
				const isEnvironmentDetailsBlock =
					block.text.trim().startsWith("<environment_details>") &&
					block.text.trim().endsWith("</environment_details>")
				return !isEnvironmentDetailsBlock
			}
			return true
		})

		const finalUserContent = [...contentWithoutEnvDetails, { type: "text" as const, text: environmentDetails }]

		const isEmptyUserContent = currentUserContent.length === 0
		const shouldAddUserMessage: boolean =
			((currentItem.retryAttempt ?? 0) === 0 && !isEmptyUserContent) ||
			(currentItem.userMessageWasRemoved ?? false)

		return { finalUserContent, shouldAddUserMessage }
	}

	/**
	 * Process the API response stream and handle chunks
	 */
	private async processStream(
		stream: ApiStream,
		abortStream: any,
		updateApiReqMsg: UpdateApiReqMsgFn,
		lastApiReqIndex: number,
		streamModelInfo: any,
		currentItem: StackItem,
		currentUserContent: Anthropic.Messages.ContentBlockParam[],
		stack: StackItem[],
	): Promise<"continue" | "return_true" | "return_false"> {
		const iterator = stream[Symbol.asyncIterator]()

		// Helper to race iterator.next() with abort signal.
		// AP-5: delegates to the exported raceNextChunkWithAbort so the listener
		// cleanup logic is unit-testable without going through the full loop.
		const nextChunkWithAbort = async () => {
			if (this.access.currentRequestAbortController) {
				return raceNextChunkWithAbort(iterator, this.access.currentRequestAbortController.signal)
			}
			return iterator.next()
		}

		try {
			let item = await nextChunkWithAbort()
			while (!item.done) {
				const chunk = item.value
				item = await nextChunkWithAbort()
				if (!chunk) {
					continue
				}

				this.access.streamProcessor.processChunk(chunk, streamModelInfo)

				if (this.access.abort) {
					console.log(`aborting stream, this.abandoned = ${this.access.abandoned}`)

					if (!this.access.abandoned) {
						await abortStream("user_cancelled")
					}
					break
				}

				if (this.access.didRejectTool) {
					this.access.streamProcessor.appendAssistantMessage("\n\n[Response interrupted by user feedback]")
					break
				}

				if (this.access.didAlreadyUseTool) {
					this.access.streamProcessor.appendAssistantMessage(
						"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]",
					)
					break
				}
			}

			// Handle background usage drain
			await this.handleBackgroundUsageDrain(lastApiReqIndex, streamModelInfo, iterator, item, updateApiReqMsg)

			// Check for abort after stream
			if (this.access.abort || this.access.abandoned) {
				throw new Error(
					`[RooCode#recursivelyMakeRooRequests] task ${this.access.taskId}.${this.access.instanceId} aborted`,
				)
			}

			// Finalize stream and process results
			return await this.finalizeStreamAndProcessResults(currentItem, currentUserContent, stack, abortStream)
		} catch (error) {
			// Handle stream errors
			return this.handleStreamError(error, abortStream, currentItem, currentUserContent, stack)
		}
	}

	/**
	 * Handle background usage drain
	 */
	private async handleBackgroundUsageDrain(
		lastApiReqIndex: number,
		streamModelInfo: any,
		iterator: AsyncGenerator<any>,
		item: IteratorResult<any>,
		// The background drain only updates the api_req message with the final
		// token/cost figures — it must be handed `updateApiReqMsg`, NOT `abortStream`.
		// Passing `abortStream` here caused `captureUsageData` to abort the stream
		// (reverting any in-progress diff edit) after every successful request,
		// which stranded freshly-written files as dirty buffers. See
		// ai_plans/2026-06-04_fix-diff-view-already-open-dirty-save.md.
		updateApiReqMsg: UpdateApiReqMsgFn,
	): Promise<void> {
		// Create a copy of current token values to avoid race conditions
		const currentTokens = {
			input: this.access.streamProcessor.inputTokens,
			output: this.access.streamProcessor.outputTokens,
			cacheWrite: this.access.streamProcessor.cacheWriteTokens,
			cacheRead: this.access.streamProcessor.cacheReadTokens,
			total: this.access.streamProcessor.totalCost,
		}

		const drainStreamInBackgroundToFindAllUsage = this.access.streamProcessor.createBackgroundUsageDrain(
			lastApiReqIndex,
			currentTokens,
			streamModelInfo,
			iterator,
			item,
			updateApiReqMsg,
		)

		drainStreamInBackgroundToFindAllUsage(lastApiReqIndex).catch((error) => {
			console.error("Background usage collection failed:", error)
		})
	}

	/**
	 * Finalize stream and process results
	 */
	private async finalizeStreamAndProcessResults(
		currentItem: StackItem,
		currentUserContent: Anthropic.Messages.ContentBlockParam[],
		stack: StackItem[],
		abortStream: any,
	): Promise<"continue" | "return_true" | "return_false"> {
		// Finalize the stream
		await this.access.streamProcessor.finalizeStream()

		// Save assistant message to API history BEFORE executing tools
		await this.access.streamProcessor.assembleAndSaveAssistantMessage()

		// Present any partial blocks
		if (this.access.streamProcessor.partialBlocks.length > 0) {
			presentAssistantMessage(this.access as any)
		}

		const hasTextContent = this.access.streamProcessor.assistantMessage.length > 0
		const hasToolUses = this.access.assistantMessageContent.some(
			(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
		)

		if (hasTextContent || hasToolUses) {
			await pWaitFor(() => this.access.userMessageContentReady)

			const didToolUse = this.access.assistantMessageContent.some(
				(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
			)

			if (!didToolUse) {
				// A text-only response is treated as the completion result when
				// the task has no incomplete todos: it runs through the real
				// attempt_completion tool (so delegation gates and the
				// completion ask flow behave identically) instead of paying a
				// full extra turn on a noToolsUsed retry. With incomplete todos
				// the retry stays — a weak model narrating mid-task must not
				// complete the task by accident. See
				// ai_plans/2026-07-12_glm-agent-loop-efficiency-implementation.md (WS-5).
				const fallback = await this.tryTextCompletionFallback()

				if (fallback === "completed") {
					// Same downstream flow as an accepted attempt_completion:
					// nothing to send back, the loop drains naturally.
					return "continue"
				}

				if (fallback === "skipped") {
					// Increment consecutive no-tool-use counter
					this.access.consecutiveNoToolUseCount++

					if (this.access.consecutiveNoToolUseCount >= 2) {
						await this.access.askSay.say("error", "MODEL_NO_TOOLS_USED")
						this.access.consecutiveMistakeCount++
					}

					this.access.userMessageContent.push({
						type: "text",
						text: formatResponse.noToolsUsed(),
					})
				}
				// "feedback": the user's completion feedback is already in
				// userMessageContent and continues the conversation below.
			} else {
				this.access.consecutiveNoToolUseCount = 0
			}

			// Push to stack if there's content or paused
			if (this.access.userMessageContent.length > 0 || this.access.isPaused) {
				stack.push({
					userContent: [...this.access.userMessageContent],
					includeFileDetails: false,
				})

				await new Promise((resolve) => setImmediate(resolve))
			}

			return "continue"
		} else {
			// No assistant response - handle error
			return this.handleEmptyAssistantResponse(currentItem, currentUserContent, stack)
		}
	}

	/**
	 * Treat a text-only assistant response as the completion result.
	 *
	 * Runs the REAL AttemptCompletionTool so the delegation gates (subtask →
	 * parent return, cancel races, re-attach evidence) and the completion ask
	 * flow behave exactly as if the model had called attempt_completion with
	 * this text. Returns:
	 * - "completed": completion flow ran; nothing to send back to the model
	 * - "feedback": user answered the completion ask with feedback (already
	 *   pushed to userMessageContent as plain text — there is no tool_use id
	 *   to attach a tool_result to)
	 * - "skipped": guards failed; caller falls back to the noToolsUsed retry
	 */
	private async tryTextCompletionFallback(): Promise<"completed" | "feedback" | "skipped"> {
		const task = this.access as unknown as import("./Task").Task

		const text = this.access.streamProcessor.assistantMessage.trim()
		if (!text || this.access.isPaused || this.access.abort) {
			return "skipped"
		}

		// A narrating model mid-task must not complete by accident: with
		// incomplete todos the noToolsUsed retry remains the right answer.
		const todoList = (task as any).todoList
		if (Array.isArray(todoList) && todoList.some((todo: any) => todo?.status !== "completed")) {
			return "skipped"
		}

		// There is no tool_use block in this turn, so anything the tool would
		// report back (user feedback, tool errors) goes in as plain text.
		const pushToolResult = (content: string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>) => {
			if (typeof content === "string") {
				if (content) {
					this.access.userMessageContent.push({ type: "text", text: content })
				}
			} else if (Array.isArray(content)) {
				this.access.userMessageContent.push(...content)
			}
		}

		try {
			const { attemptCompletionTool } = await import("../tools/AttemptCompletionTool")

			await attemptCompletionTool.execute({ result: text }, task, {
				askApproval: async () => true,
				handleError: async (action: string, error: Error) => {
					await this.access.askSay.say("error", `Error ${action}: ${error.message}`)
				},
				pushToolResult,
				askFinishSubTaskApproval: async () => {
					const { response } = await this.access.askSay.ask(
						"tool",
						JSON.stringify({ tool: "finishTask" }),
						false,
					)
					return response === "yesButtonClicked"
				},
				toolDescription: () => "attempt_completion (text-only completion fallback)",
			})
		} catch (error) {
			console.error(
				`[Task#${this.access.taskId}.${this.access.instanceId}] text-completion fallback failed: ${error?.message ?? error}`,
			)
			return "skipped"
		}

		return this.access.userMessageContent.length > 0 ? "feedback" : "completed"
	}

	/**
	 * Handle empty assistant response
	 */
	private async handleEmptyAssistantResponse(
		currentItem: StackItem,
		currentUserContent: Anthropic.Messages.ContentBlockParam[],
		stack: StackItem[],
	): Promise<"continue" | "return_true" | "return_false"> {
		this.access.consecutiveNoAssistantMessagesCount++

		if (this.access.consecutiveNoAssistantMessagesCount >= 2) {
			await this.access.askSay.say("error", "MODEL_NO_ASSISTANT_MESSAGES")
		}

		// Remove the last user message to avoid consecutive user messages
		if (this.access.apiConversationHistory.length > 0) {
			const lastMessage = this.access.apiConversationHistory[this.access.apiConversationHistory.length - 1]
			if (lastMessage.role === "user") {
				this.access.apiConversationHistory.pop()
			}
		}

		const state = await this.access.providerRef.deref()?.getState()

		if (state?.autoApprovalEnabled) {
			await this.backoffAndAnnounce(
				currentItem.retryAttempt ?? 0,
				new Error(
					"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
				),
			)

			if (this.access.abort) {
				console.log(
					`[Task#${this.access.taskId}.${this.access.instanceId}] Task aborted during empty-assistant retry backoff`,
				)
				return "return_true"
			}

			stack.push({
				userContent: currentUserContent,
				includeFileDetails: false,
				retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
				userMessageWasRemoved: true,
			})

			return "continue"
		} else {
			const { response } = await this.access.askSay.ask(
				"api_req_failed",
				"The model returned no assistant messages. This may indicate an issue with the API or the model's output.",
			)

			if (response === "yesButtonClicked") {
				await this.access.askSay.say("api_req_retried")

				stack.push({
					userContent: currentUserContent,
					includeFileDetails: false,
					retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
				})

				return "continue"
			} else {
				await this.access.history.addToApiConversationHistory({
					role: "user",
					content: currentUserContent,
				})

				await this.access.askSay.say(
					"error",
					"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
				)

				await this.access.history.addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: "Failure: I did not provide a response." }],
				})
			}
		}

		return "return_false"
	}

	/**
	 * Handle stream errors
	 */
	private async handleStreamError(
		error: any,
		abortStream: any,
		currentItem: StackItem,
		currentUserContent: Anthropic.Messages.ContentBlockParam[],
		stack: StackItem[],
	): Promise<"continue" | "return_true" | "return_false"> {
		if (!this.access.abandoned) {
			const cancelReason: ClineApiReqCancelReason = this.access.abort ? "user_cancelled" : "streaming_failed"
			const rawErrorMessage = error.message ?? JSON.stringify(serializeError(error), null, 2)
			const streamingFailedMessage = this.access.abort
				? undefined
				: `${t("common:interruption.streamTerminatedByProvider")}: ${rawErrorMessage}`

			await abortStream(cancelReason, streamingFailedMessage)

			if (this.access.abort) {
				this.access.abortReason = cancelReason
				await this.access.abortTask()
			} else {
				console.error(
					`[Task#${this.access.taskId}.${this.access.instanceId}] Stream failed, will retry: ${streamingFailedMessage}`,
				)

				const stateForBackoff = await this.access.providerRef.deref()?.getState()
				if (stateForBackoff?.autoApprovalEnabled) {
					await this.backoffAndAnnounce(currentItem.retryAttempt ?? 0, error)

					if (this.access.abort) {
						console.log(
							`[Task#${this.access.taskId}.${this.access.instanceId}] Task aborted during mid-stream retry backoff`,
						)
						this.access.abortReason = "user_cancelled"
						await this.access.abortTask()
						return "return_true"
					}
				}

				stack.push({
					userContent: currentUserContent,
					includeFileDetails: false,
					retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
				})

				return "continue"
			}
		}

		return "return_true"
	}

	/**
	 * Build the system prompt with MCP, mode, and custom instructions.
	 * Delegates to ApiRequestBuilder.
	 */
	async getSystemPrompt(): Promise<string> {
		return this.apiRequestBuilder.buildSystemPrompt()
	}

	/**
	 * Get the current profile ID from state.
	 * Delegates to ApiRequestBuilder.
	 */
	getCurrentProfileId(state: any): string {
		return this.apiRequestBuilder.getCurrentProfileId(state)
	}

	/**
	 * Handle context window exceeded error by delegating to context manager
	 */
	async handleContextWindowExceededError(): Promise<void> {
		return this.access.contextManager.handleContextWindowExceededError()
	}

	/**
	 * Enforce user-configured provider rate limit.
	 * Shows countdown UX on first attempt, skips on retries.
	 * Delegates to RetryHandler.
	 */
	async maybeWaitForProviderRateLimit(retryAttempt: number): Promise<void> {
		return this.retryHandler.maybeWaitForProviderRateLimit(retryAttempt)
	}

	/**
	 * Attempt an API request with retry logic.
	 * This is an async generator that yields chunks from the API stream.
	 */
	async *attemptApiRequest(retryAttempt: number = 0, options: { skipProviderRateLimit?: boolean } = {}): ApiStream {
		const state = await this.access.providerRef.deref()?.getState()

		const {
			apiConfiguration,
			autoApprovalEnabled,
			requestDelaySeconds,
			mode,
			autoCondenseContext = true,
			autoCondenseContextPercent = 100,
			profileThresholds = {},
		} = state ?? {}

		const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE

		if (!options.skipProviderRateLimit) {
			await this.maybeWaitForProviderRateLimit(retryAttempt)
		}

		setLastGlobalApiRequestTime(performance.now())

		const systemPrompt = await this.getSystemPrompt()
		const { contextTokens: trackedContextTokens } = this.access.getTokenUsage()

		// AP-7: when tracked contextTokens is 0/falsy (e.g. server omitted usage →
		// zeros recorded → context tracking sees 0 forever), fall back to a local
		// estimate via countTokens over the conversation history so context
		// management (auto-condense) still runs. Keep the fast path (non-zero
		// tracked tokens) unchanged — the fallback only runs in the zero case.
		let contextTokens = trackedContextTokens
		if (!contextTokens) {
			const effectiveHistory = getEffectiveApiHistory(this.access.apiConversationHistory)
			if (effectiveHistory.length > 0) {
				try {
					const fallbackContent: Anthropic.Messages.ContentBlockParam[] = []
					for (const msg of effectiveHistory) {
						if (typeof msg.content === "string") {
							fallbackContent.push({ type: "text", text: msg.content })
						} else if (Array.isArray(msg.content)) {
							for (const block of msg.content) {
								if (block.type === "text") {
									fallbackContent.push({ type: "text", text: block.text })
								}
							}
						}
					}
					if (fallbackContent.length > 0) {
						contextTokens = await this.access.api.countTokens(fallbackContent)
					}
				} catch (err) {
					console.error(`[Task#${this.access.taskId}] Failed to compute fallback contextTokens:`, err)
					// Leave contextTokens as 0 → context management skipped (same as today)
				}
			}
		}

		// Un-deflate the reported size. When the previous request was microcompacted,
		// the provider reported the STRIPPED payload size — but `apiConversationHistory`
		// still holds the pristine content that was stripped. Comparing the pristine
		// history against the stripped measurement is what makes the threshold check
		// oscillate: compact → reported size drops under the threshold → next turn
		// skips the strip → full history goes out → over threshold → compact again.
		// Adding back what we stripped makes the gate see the true pristine size, so
		// once a task is over the threshold it stays compacted and the sent prefix
		// stops changing every turn (a precondition for any prompt-cache hit).
		if (contextTokens && this.access.microcompactStrippedTokens > 0) {
			contextTokens += this.access.microcompactStrippedTokens
		}

		if (contextTokens) {
			await this.handleContextManagement({
				state,
				systemPrompt,
				autoCondenseContext,
				autoCondenseContextPercent,
				profileThresholds,
				contextTokens,
				customCondensingPrompt,
			})
		}

		// Build clean conversation history
		const effectiveHistory = getEffectiveApiHistory(this.access.apiConversationHistory)
		const messagesSinceLastSummary = getMessagesSinceLastSummary(effectiveHistory)
		const mergedForApi = mergeConsecutiveApiMessages(messagesSinceLastSummary, { roles: ["user"] })
		const messagesWithoutImages = maybeRemoveImageBlocks(mergedForApi, this.access.api)
		const cleanConversationHistory = this.buildCleanConversationHistory(
			messagesWithoutImages as ApiMessage[],
			this.access.api.getModel().info.preserveReasoning === true,
		)

		// Check auto-approval limits
		const approvalResult = await this.access.autoApprovalHandler.checkAutoApprovalLimits(
			state,
			this.access.combineMessages(this.access.clineMessages.slice(1)),
			async (type, data) => this.access.askSay.ask(type, data),
		)

		if (!approvalResult.shouldProceed) {
			throw new Error("Auto-approval limit reached and user did not approve continuation")
		}

		// Build tools array
		const modelInfo = this.access.api.getModel().info
		const { allTools, allowedFunctionNames } = await this.buildToolsArray(state, apiConfiguration, mode, modelInfo)

		const metadata: ApiHandlerCreateMessageMetadata = {
			mode: mode,
			taskId: this.access.taskId,
			suppressPreviousResponseId: this.access.skipPrevResponseIdOnce,
			...(allTools.length > 0
				? {
						tools: allTools,
						tool_choice: "auto",
						parallelToolCalls: true,
						...(allowedFunctionNames ? { allowedFunctionNames } : {}),
					}
				: {}),
		}

		// Create abort controller
		this.access.currentRequestAbortController = new AbortController()
		const abortSignal = this.access.currentRequestAbortController.signal
		this.access.skipPrevResponseIdOnce = false

		// Create API stream
		const stream = this.access.api.createMessage(
			systemPrompt,
			cleanConversationHistory as unknown as Anthropic.Messages.MessageParam[],
			metadata,
		)
		const iterator = stream[Symbol.asyncIterator]()

		// Set up abort handling
		abortSignal.addEventListener("abort", () => {
			console.log(
				`[Task#${this.access.taskId}.${this.access.instanceId}] AbortSignal triggered for current request`,
			)
			this.access.currentRequestAbortController = undefined
		})

		try {
			// Await first chunk
			this.access.isWaitingForFirstChunk = true

			const firstChunkPromise = iterator.next()
			const abortPromise = new Promise<never>((_, reject) => {
				if (abortSignal.aborted) {
					reject(new Error("Request cancelled by user"))
				} else {
					abortSignal.addEventListener("abort", () => {
						reject(new Error("Request cancelled by user"))
					})
				}
			})

			const firstChunk = await Promise.race([firstChunkPromise, abortPromise])
			yield firstChunk.value
			this.access.isWaitingForFirstChunk = false
		} catch (error) {
			this.access.isWaitingForFirstChunk = false
			this.access.currentRequestAbortController = undefined

			// Handle errors with retry logic
			yield* this.handleApiRequestError(error, retryAttempt, autoApprovalEnabled, iterator)
			return
		}

		// No error - yield remaining chunks
		yield* iterator
	}

	/**
	 * Handle context management before API request
	 */
	private async handleContextManagement(params: {
		state: any
		systemPrompt: string
		autoCondenseContext: boolean
		autoCondenseContextPercent: number
		profileThresholds: Record<string, any>
		contextTokens: number
		customCondensingPrompt?: string
	}): Promise<void> {
		const {
			state,
			systemPrompt,
			autoCondenseContext,
			autoCondenseContextPercent,
			profileThresholds,
			contextTokens,
			customCondensingPrompt,
		} = params

		const modelInfo = this.access.api.getModel().info
		const maxTokens = getModelMaxOutputTokens({
			modelId: this.access.api.getModel().id,
			model: modelInfo,
			settings: this.access.apiConfiguration,
		})
		const contextWindow = modelInfo.contextWindow
		const currentProfileId = this.getCurrentProfileId(state)

		// Compute lastMessageTokens
		const lastMessage = this.access.apiConversationHistory[this.access.apiConversationHistory.length - 1]
		const lastMessageContent = lastMessage?.content
		let lastMessageTokens = 0
		if (lastMessageContent) {
			lastMessageTokens = Array.isArray(lastMessageContent)
				? await this.access.api.countTokens(lastMessageContent)
				: await this.access.api.countTokens([{ type: "text", text: lastMessageContent as string }])
		}

		await this.access.contextManager.manageContextIfNeeded({
			state,
			systemPrompt,
			autoCondenseContext,
			autoCondenseContextPercent,
			profileThresholds,
			currentProfileId,
			contextTokens,
			maxTokens,
			contextWindow,
			lastMessageTokens,
			customCondensingPrompt,
		})
	}

	/**
	 * Build tools array for API request.
	 * Delegates to ApiRequestBuilder.
	 */
	private async buildToolsArray(
		state: any,
		apiConfiguration: ProviderSettings | undefined,
		mode: string | undefined,
		modelInfo: any,
	): Promise<{ allTools: any[]; allowedFunctionNames: string[] | undefined }> {
		return this.apiRequestBuilder.buildToolsArray(state, apiConfiguration, mode, modelInfo)
	}

	/**
	 * Handle API request errors with retry logic
	 */
	private async *handleApiRequestError(
		error: any,
		retryAttempt: number,
		autoApprovalEnabled: boolean | undefined,
		iterator: AsyncIterator<any>,
	): ApiStream {
		const isContextWindowExceededError = checkContextWindowExceededError(error)

		if (isContextWindowExceededError && retryAttempt < MAX_CONTEXT_WINDOW_RETRIES) {
			console.warn(
				`[Task#${this.access.taskId}] Context window exceeded for model ${this.access.api.getModel().id}. ` +
					`Retry attempt ${retryAttempt + 1}/${MAX_CONTEXT_WINDOW_RETRIES}. ` +
					`Attempting automatic truncation...`,
			)
			await this.handleContextWindowExceededError()
			yield* this.attemptApiRequest(retryAttempt + 1)
			return
		}

		if (autoApprovalEnabled) {
			await this.backoffAndAnnounce(retryAttempt, error)

			if (this.access.abort) {
				throw new Error(
					`[Task#attemptApiRequest] task ${this.access.taskId}.${this.access.instanceId} aborted during retry`,
				)
			}

			yield* this.attemptApiRequest(retryAttempt + 1)
			return
		} else {
			const { response } = await this.access.askSay.ask(
				"api_req_failed",
				error.message ?? JSON.stringify(serializeError(error), null, 2),
			)

			if (response !== "yesButtonClicked") {
				throw new Error("API request failed")
			}

			await this.access.askSay.say("api_req_retried")
			yield* this.attemptApiRequest()
			return
		}
	}

	/**
	 * Shared exponential backoff for retries with countdown UX.
	 * Delegates to RetryHandler.
	 */
	async backoffAndAnnounce(retryAttempt: number, error: any): Promise<void> {
		return this.retryHandler.backoffAndAnnounce(retryAttempt, error)
	}

	/**
	 * Build clean conversation history by stripping reasoning blocks.
	 * Delegates to ApiRequestBuilder.
	 */
	buildCleanConversationHistory(
		messages: ApiMessage[],
		preserveReasoning: boolean = false,
	): Array<
		Anthropic.Messages.MessageParam | { type: "reasoning"; encrypted_content: string; id?: string; summary?: any[] }
	> {
		return this.apiRequestBuilder.buildCleanConversationHistory(messages, preserveReasoning)
	}
}
