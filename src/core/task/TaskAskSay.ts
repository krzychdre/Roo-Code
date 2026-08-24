import EventEmitter from "events"

import {
	type ClineMessage,
	type ClineAsk,
	type ClineSay,
	type ClineAskResponse,
	type ToolProgressStatus,
	type ContextCondense,
	type ContextTruncation,
	type ContextPrune,
	RooCodeEventName,
	isIdleAsk,
	isInteractiveAsk,
	isResumableAsk,
} from "@roo-code/types"
import { type ToolName } from "@roo-code/types"

import { type TaskHistory } from "./TaskHistory"
import { getToolCallId, findToolAskIndexByCallId } from "./toolAskIdentity"
import { checkAutoApproval, type CheckAutoApprovalResult } from "../auto-approval"
import { findLastIndex } from "../../shared/array"
import { formatResponse } from "../prompts/responses"
import { AskIgnoredError } from "./AskIgnoredError"
import { type MessageQueueService } from "../message-queue/MessageQueueService"
import { type ClineProvider } from "../webview/ClineProvider"
import { type AutoApprovalOverride } from "./Task"
import pWaitFor from "p-wait-for"

/**
 * How long a headless subagent's interactive ask (followup question) may wait
 * for a user answer before falling back to a plain approval. Keeps unattended
 * fan-outs bounded while giving a watching user a real window to reply.
 */
export const SUBAGENT_ASK_FALLBACK_TIMEOUT_MS = 5 * 60 * 1000

export interface TaskAskSayAccess {
	taskId: string
	instanceId: string
	abort: boolean
	clineMessages: ClineMessage[]
	askResponse?: ClineAskResponse
	askResponseText?: string
	askResponseImages?: string[]
	lastMessageTs?: number
	idleAsk?: ClineMessage
	resumableAsk?: ClineMessage
	interactiveAsk?: ClineMessage
	/** Headless background task (parallel subagent / memory writer). */
	isBackground: boolean
	/** Task working directory — may differ from the provider's (worktrees). */
	cwd: string
	autoApprovalTimeoutRef?: NodeJS.Timeout
	messageQueueService: MessageQueueService
	providerRef: WeakRef<ClineProvider>
	history: TaskHistory
	emit: EventEmitter["emit"]
	checkpointSave: (isSave: boolean, isCreateCheckpoint: boolean) => Promise<void>
	/**
	 * Optional per-task auto-approval override (headless background tasks). Checked
	 * before the global auto-approval state; returns "approve"/"deny" to resolve an
	 * ask without user interaction, or undefined to defer to normal handling.
	 * May be async; receives `isProtected` so the policy can factor in protected-file
	 * status.
	 */
	autoApprovalOverride?: AutoApprovalOverride
}

export class TaskAskSay {
	constructor(private readonly access: TaskAskSayAccess) {}

	// Note that `partial` has three valid states true (partial message),
	// false (completion of partial message), undefined (individual complete
	// message).
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
		// If this Cline instance was aborted by the provider, then the only
		// thing keeping us alive is a promise still running in the background,
		// in which case we don't want to send its result to the webview as it
		// is attached to a new instance of Cline now. So we can safely ignore
		// the result of any active promises, and this class will be
		// deallocated. (Although we set Cline = undefined in provider, that
		// simply removes the reference to this instance, but the instance is
		// still alive until this promise resolves or rejects.)
		if (this.access.abort) {
			throw new Error(`[RooCode#ask] task ${this.access.taskId}.${this.access.instanceId} aborted`)
		}

		let askTs: number

		// Resolve auto-approval before adding the message so the state snapshot
		// sent to the webview already carries isAnswered:true when the ask will
		// be immediately resolved. This eliminates the race between the state
		// update (which shows approval buttons) and the former separate
		// clearApprovalButtons message (which could arrive before buttons were
		// rendered, leaving them stuck on-screen).
		const provider = this.access.providerRef.deref()
		const baseState = provider ? await provider.getState() : undefined
		// Resolve relative tool paths (plan-review write gate) against the
		// asking task's own cwd — it may differ from the provider's when the
		// task runs in a worktree.
		const state = baseState ? { ...baseState, cwd: this.access.cwd ?? baseState.cwd } : undefined
		// Per-task override first (headless background tasks): lets a task run
		// autonomously without mutating the global auto-approval settings. Only
		// short-circuits when it returns a concrete "approve"/"deny"; otherwise
		// falls through to the normal global auto-approval flow.
		const override = await this.access.autoApprovalOverride?.(type, text, isProtected)
		const approval: CheckAutoApprovalResult =
			override === "approve"
				? { decision: "approve" }
				: override === "deny"
					? { decision: "deny" }
					: await checkAutoApproval({ state, ask: type, text, isProtected })
		const isAutoAnswered = approval.decision === "approve" || approval.decision === "deny"

		if (partial !== undefined) {
			const lastMessage = this.access.clineMessages.at(-1)

			// Race elimination for ask:"tool": a tool's streaming placeholder and
			// its complete card share a native tool-call id. Locate the existing
			// message by that id ANYWHERE in recent history and transition it in
			// place. This makes the placeholder -> complete handoff identity-driven
			// rather than tail-adjacency-driven, so an intervening say (checkpoint,
			// text, reasoning) emitted between handlePartial and execute() can no
			// longer orphan the placeholder. Tail-based logic below remains the
			// fallback for asks without an id.
			const trackedToolAskIndex =
				type === "tool" ? findToolAskIndexByCallId(this.access.clineMessages, getToolCallId(text)) : -1
			const trackedToolAsk =
				trackedToolAskIndex !== -1 ? this.access.clineMessages[trackedToolAskIndex] : undefined

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type

			if (partial) {
				if (trackedToolAsk) {
					// Streaming update for an already-tracked invocation - update in
					// place by identity, even if the placeholder is no longer the tail.
					trackedToolAsk.text = text
					trackedToolAsk.partial = true
					trackedToolAsk.progressStatus = progressStatus
					trackedToolAsk.isProtected = isProtected
					this.access.history.updateClineMessage(trackedToolAsk)
					throw new AskIgnoredError("updating existing partial (by tool-call id)")
				}
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					// TODO: Be more efficient about saving and posting only new
					// data or one whole message at a time so ignore partial for
					// saves, and only post parts of partial message instead of
					// whole array in new listener.
					this.access.history.updateClineMessage(lastMessage)
					// console.log("Task#ask: current ask promise was ignored (#1)")
					throw new AskIgnoredError("updating existing partial")
				} else {
					// This is a new partial message, so add it with partial
					// state.
					askTs = Date.now()
					this.access.lastMessageTs = askTs
					await this.access.history.addToClineMessages({
						ts: askTs,
						type: "ask",
						ask: type,
						text,
						partial,
						isProtected,
					})
					// console.log("Task#ask: current ask promise was ignored (#2)")
					throw new AskIgnoredError("new partial")
				}
			} else {
				// Dedup: if the tail is already a finalized ask of the same type, treat this
				// call as a re-ask on the existing message instead of appending. This catches
				// a race where some upstream path finalizes the partial (partial=true →
				// partial=false) before the second ask(text, false) reaches this code.
				// Without dedup, the second call falls through to the "new and complete
				// message" branch and creates a duplicate UI card whose ts diverges from
				// task.lastMessageTs — breaking executionId-based status routing for tools
				// like execute_command (see ai_plans/2026-05-15_21-16).
				//
				// For ask:"tool" the placeholder emitted by a tool's handlePartial and the
				// complete payload emitted by its requestApproval differ in text (read_file
				// adds reason/content/startLine; search_files swaps content:"" for results),
				// so a raw text comparison misses the duplicate. The discriminator must stay
				// invocation-precise: reuse a leftover streaming placeholder, but NEVER merge
				// into a different invocation — otherwise a second legitimate read of the
				// same file (e.g. a different line range) would be hidden.
				//
				// When a tool stamps the native tool-call id onto both its placeholder and
				// its complete ask:"tool" payload, the two cards of one invocation share
				// that id and two invocations never do — so id equality is the precise
				// signal. When ids are absent (tools that have not adopted stamping), fall
				// back to exact-text, preserving the prior behavior for them.
				const tailIsFinalizedSameTypeAsk =
					!!lastMessage &&
					lastMessage.partial !== true &&
					lastMessage.type === "ask" &&
					lastMessage.ask === type

				let isAlreadyFinalizedDuplicate = false
				if (tailIsFinalizedSameTypeAsk) {
					const tailToolCallId = type === "tool" ? getToolCallId(lastMessage!.text) : undefined
					const newToolCallId = type === "tool" ? getToolCallId(text) : undefined

					if (tailToolCallId !== undefined || newToolCallId !== undefined) {
						// At least one side carries an id: this is an id-aware tool.
						// Merge only when both ids are present and equal.
						isAlreadyFinalizedDuplicate = tailToolCallId !== undefined && tailToolCallId === newToolCallId
					} else {
						// No ids: fall back to exact-text comparison.
						isAlreadyFinalizedDuplicate = (lastMessage!.text ?? "") === (text ?? "")
					}
				}

				// Prefer the identity-matched message (found by tool-call id
				// anywhere in history) over the tail. This is the primary race
				// cure; the tail-based isAlreadyFinalizedDuplicate is the fallback
				// for asks that carry no id.
				const transitionTarget = trackedToolAsk ?? lastMessage

				// transitionTarget is defined whenever we take the reuse path:
				// trackedToolAsk is defined by construction, and the tail branches
				// (isUpdatingPreviousPartial / isAlreadyFinalizedDuplicate) each
				// require a defined tail.
				if (transitionTarget && (trackedToolAsk || isUpdatingPreviousPartial || isAlreadyFinalizedDuplicate)) {
					// This is the complete version of a previously partial
					// message, so replace the partial with the complete version.
					this.access.askResponse = undefined
					this.access.askResponseText = undefined
					this.access.askResponseImages = undefined

					// Bug for the history books:
					// In the webview we use the ts as the chatrow key for the
					// virtuoso list. Since we would update this ts right at the
					// end of streaming, it would cause the view to flicker. The
					// key prop has to be stable otherwise react has trouble
					// reconciling items between renders, causing unmounting and
					// remounting of components (flickering).
					// The lesson here is if you see flickering when rendering
					// lists, it's likely because the key prop is not stable.
					// So in this case we must make sure that the message ts is
					// never altered after first setting it.
					askTs = transitionTarget.ts
					this.access.lastMessageTs = askTs
					transitionTarget.text = text
					transitionTarget.partial = false
					transitionTarget.progressStatus = progressStatus
					transitionTarget.isProtected = isProtected
					if (isAutoAnswered) {
						transitionTarget.isAnswered = true
					}
					await this.access.history.saveClineMessages()
					this.access.history.updateClineMessage(transitionTarget)
				} else {
					// This is a new and complete message, so add it like normal.
					this.access.askResponse = undefined
					this.access.askResponseText = undefined
					this.access.askResponseImages = undefined
					askTs = Date.now()
					this.access.lastMessageTs = askTs
					await this.access.history.addToClineMessages({
						ts: askTs,
						type: "ask",
						ask: type,
						text,
						isProtected,
						isAnswered: isAutoAnswered || undefined,
					})
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			this.access.askResponse = undefined
			this.access.askResponseText = undefined
			this.access.askResponseImages = undefined
			askTs = Date.now()
			this.access.lastMessageTs = askTs
			await this.access.history.addToClineMessages({
				ts: askTs,
				type: "ask",
				ask: type,
				text,
				isProtected,
				isAnswered: isAutoAnswered || undefined,
			})
		}

		let timeouts: NodeJS.Timeout[] = []

		if (approval.decision === "approve") {
			this.approveAsk()
		} else if (approval.decision === "deny") {
			this.denyAsk()
		} else if (approval.decision === "timeout") {
			// Store the auto-approval timeout so it can be cancelled if user interacts
			this.access.autoApprovalTimeoutRef = setTimeout(() => {
				const { askResponse, text, images } = approval.fn()
				this.handleWebviewAskResponse(askResponse, text, images)
				this.access.autoApprovalTimeoutRef = undefined
			}, approval.timeout)
			timeouts.push(this.access.autoApprovalTimeoutRef)
		}

		// The state is mutable if the message is complete and the task will
		// block (via the `pWaitFor`).
		const isBlocking = !(this.access.askResponse !== undefined || this.access.lastMessageTs !== askTs)
		const isMessageQueued = !this.access.messageQueueService.isEmpty()
		// Keep queued user messages intact during command_output asks. Those asks
		// are terminal flow-control, not conversational turns.
		const shouldDrainQueuedMessageForAsk = type !== "command_output"
		const isStatusMutable = !partial && isBlocking && !isMessageQueued && approval.decision === "ask"

		if (isStatusMutable) {
			const statusMutationTimeout = 2_000

			if (isInteractiveAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.access.history.findMessageByTimestamp(askTs)

						if (message) {
							this.access.interactiveAsk = message
							this.access.emit(RooCodeEventName.TaskInteractive, this.access.taskId)
							provider?.postMessageToWebview({ type: "interactionRequired" })
						}
					}, statusMutationTimeout),
				)
			} else if (isResumableAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.access.history.findMessageByTimestamp(askTs)

						if (message) {
							this.access.resumableAsk = message
							this.access.emit(RooCodeEventName.TaskResumable, this.access.taskId)
						}
					}, statusMutationTimeout),
				)
			} else if (isIdleAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.access.history.findMessageByTimestamp(askTs)

						if (message) {
							this.access.idleAsk = message
							this.access.emit(RooCodeEventName.TaskIdle, this.access.taskId)
						}
					}, statusMutationTimeout),
				)
			}
		} else if (isMessageQueued && shouldDrainQueuedMessageForAsk) {
			const message = this.access.messageQueueService.dequeueMessage()

			if (message) {
				// Check if this is a tool approval ask that needs to be handled.
				if (type === "tool" || type === "command" || type === "use_mcp_server") {
					// For tool approvals, we need to approve first, then send
					// the message if there's text/images.
					this.handleWebviewAskResponse("yesButtonClicked", message.text, message.images)
				} else {
					// For other ask types (like followup or command_output), fulfill the ask
					// directly.
					this.handleWebviewAskResponse("messageResponse", message.text, message.images)
				}
			}
		}

		// A headless subagent may block on an ask the user never notices (its
		// panel row shows "awaiting input", but nobody is watching). Bound the
		// wait (`subagentFollowupTimeoutSec`, 0 = answer immediately) so
		// unattended fan-outs always make progress. The fallback answer
		// depends on what is being asked: a followup question is approved
		// (empty answer — the child proceeds on its best judgment), but a
		// PERMISSION ask (tool/command/MCP) is DENIED — an unattended subagent
		// must never write or execute without the user's permission. A real
		// user answer any time earlier wins.
		if (this.access.isBackground && approval.decision === "ask") {
			const fallbackMs = Math.max(
				0,
				(state?.subagentFollowupTimeoutSec ?? SUBAGENT_ASK_FALLBACK_TIMEOUT_MS / 1000) * 1000,
			)
			const isPermissionAsk = type === "tool" || type === "command" || type === "use_mcp_server"
			timeouts.push(
				setTimeout(() => {
					if (this.access.askResponse === undefined && this.access.lastMessageTs === askTs) {
						this.handleWebviewAskResponse(isPermissionAsk ? "noButtonClicked" : "yesButtonClicked")
					}
				}, fallbackMs),
			)
		}

		// Wait for askResponse to be set
		await pWaitFor(
			() => {
				if (this.access.askResponse !== undefined || this.access.lastMessageTs !== askTs) {
					return true
				}

				// If a queued message arrives while we're blocked on an ask (e.g. a follow-up
				// suggestion click that was incorrectly queued due to UI state), consume it
				// immediately so the task doesn't hang.
				if (shouldDrainQueuedMessageForAsk && !this.access.messageQueueService.isEmpty()) {
					const message = this.access.messageQueueService.dequeueMessage()
					if (message) {
						// If this is a tool approval ask, we need to approve first (yesButtonClicked)
						// and include any queued text/images.
						if (type === "tool" || type === "command" || type === "use_mcp_server") {
							this.handleWebviewAskResponse("yesButtonClicked", message.text, message.images)
						} else {
							this.handleWebviewAskResponse("messageResponse", message.text, message.images)
						}
					}
				}

				return false
			},
			{ interval: 100 },
		)

		if (this.access.lastMessageTs !== askTs) {
			// Could happen if we send multiple asks in a row i.e. with
			// command_output. It's important that when we know an ask could
			// fail, it is handled gracefully.
			throw new AskIgnoredError("superseded")
		}

		const result = {
			response: this.access.askResponse!,
			text: this.access.askResponseText,
			images: this.access.askResponseImages,
		}
		this.access.askResponse = undefined
		this.access.askResponseText = undefined
		this.access.askResponseImages = undefined

		// Cancel the timeouts if they are still running.
		timeouts.forEach((timeout) => clearTimeout(timeout))

		// Switch back to an active state.
		if (this.access.idleAsk || this.access.resumableAsk || this.access.interactiveAsk) {
			this.access.idleAsk = undefined
			this.access.resumableAsk = undefined
			this.access.interactiveAsk = undefined
			this.access.emit(RooCodeEventName.TaskActive, this.access.taskId)
		}

		this.access.emit(RooCodeEventName.TaskAskResponded)
		return result
	}

	handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]) {
		// Clear any pending auto-approval timeout when user responds
		this.cancelAutoApprovalTimeout()

		this.access.askResponse = askResponse
		this.access.askResponseText = text
		this.access.askResponseImages = images

		// Create a checkpoint whenever the user sends a message.
		// Use allowEmpty=true to ensure a checkpoint is recorded even if there are no file changes.
		// Suppress the checkpoint_saved chat row for this particular checkpoint to keep the timeline clean.
		if (askResponse === "messageResponse") {
			void this.access.checkpointSave(false, true)
		}

		// Mark the last follow-up question as answered
		if (askResponse === "messageResponse" || askResponse === "yesButtonClicked") {
			// Find the last unanswered follow-up message using findLastIndex
			const lastFollowUpIndex = findLastIndex(
				this.access.clineMessages,
				(msg) => msg.type === "ask" && msg.ask === "followup" && !msg.isAnswered,
			)

			if (lastFollowUpIndex !== -1) {
				// Mark this follow-up as answered
				this.access.clineMessages[lastFollowUpIndex].isAnswered = true
				// Save the updated messages
				this.access.history.saveClineMessages().catch((error) => {
					console.error("Failed to save answered follow-up state:", error)
				})
			}
		}

		// Mark the last tool-approval ask as answered when user approves (or auto-approval)
		if (askResponse === "yesButtonClicked") {
			const lastToolAskIndex = findLastIndex(
				this.access.clineMessages,
				(msg) => msg.type === "ask" && msg.ask === "tool" && !msg.isAnswered,
			)
			if (lastToolAskIndex !== -1) {
				this.access.clineMessages[lastToolAskIndex].isAnswered = true
				void this.access.history.updateClineMessage(this.access.clineMessages[lastToolAskIndex])
				this.access.history.saveClineMessages().catch((error) => {
					console.error("Failed to save answered tool-ask state:", error)
				})
			}
		}
	}

	/**
	 * Cancel any pending auto-approval timeout.
	 * Called when user interacts (types, clicks buttons, etc.) to prevent the timeout from firing.
	 */
	cancelAutoApprovalTimeout(): void {
		if (this.access.autoApprovalTimeoutRef) {
			clearTimeout(this.access.autoApprovalTimeoutRef)
			this.access.autoApprovalTimeoutRef = undefined
		}
	}

	approveAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("yesButtonClicked", text, images)
	}

	denyAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("noButtonClicked", text, images)
	}

	supersedePendingAsk(): void {
		this.access.lastMessageTs = Date.now()
	}

	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
		options: {
			isNonInteractive?: boolean
		} = {},
		contextCondense?: ContextCondense,
		contextTruncation?: ContextTruncation,
		contextPrune?: ContextPrune,
	): Promise<undefined> {
		if (this.access.abort) {
			throw new Error(`[RooCode#say] task ${this.access.taskId}.${this.access.instanceId} aborted`)
		}

		if (partial !== undefined) {
			const lastMessage = this.access.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					this.access.history.updateClineMessage(lastMessage)
				} else {
					// This is a new partial message, so add it with partial state.
					const sayTs = Date.now()

					if (!options.isNonInteractive) {
						this.access.lastMessageTs = sayTs
					}

					await this.access.history.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						partial,
						contextCondense,
						contextTruncation,
						contextPrune,
					})
				}
			} else {
				// New now have a complete version of a previously partial message.
				// This is the complete version of a previously partial
				// message, so replace the partial with the complete version.
				if (isUpdatingPreviousPartial) {
					if (!options.isNonInteractive) {
						this.access.lastMessageTs = lastMessage.ts
					}

					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus

					// Instead of streaming partialMessage events, we do a save
					// and post like normal to persist to disk.
					await this.access.history.saveClineMessages()

					// More performant than an entire `postStateToWebview`.
					this.access.history.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					const sayTs = Date.now()

					if (!options.isNonInteractive) {
						this.access.lastMessageTs = sayTs
					}

					await this.access.history.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						contextCondense,
						contextTruncation,
						contextPrune,
					})
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			const sayTs = Date.now()

			// A "non-interactive" message is a message is one that the user
			// does not need to respond to. We don't want these message types
			// to trigger an update to `lastMessageTs` since they can be created
			// asynchronously and could interrupt a pending ask.
			if (!options.isNonInteractive) {
				this.access.lastMessageTs = sayTs
			}

			await this.access.history.addToClineMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
				checkpoint,
				contextCondense,
				contextTruncation,
				contextPrune,
			})
		}
	}

	async sayAndCreateMissingParamError(toolName: ToolName, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Roo tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}
}
