/**
 * ApiRequestBuilder - Handles building API request components
 *
 * This module extracts the API request building logic from TaskApiLoop,
 * including system prompt construction, tools array building, and
 * conversation history preparation.
 *
 * Extracted from: TaskApiLoop.ts (Phase 2A refactoring)
 */

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import * as vscode from "vscode"
import pWaitFor from "p-wait-for"
import {
	type ProviderSettings,
	type ToolName,
	type ClineApiReqInfo,
	RooCodeEventName,
	getModelId,
	isParallelTasksEnabled,
} from "@roo-code/types"
import { type ApiHandler, type ApiHandlerCreateMessageMetadata } from "../../api"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { SYSTEM_PROMPT } from "../prompts/system"
import { getMessagesSinceLastSummary, getEffectiveApiHistory } from "../condense"
import { applyMicrocompactCleared } from "../context-management/microcompact"
import { buildNativeToolsArrayWithRestrictions } from "./build-tools"
import { mergeConsecutiveApiMessages } from "./mergeConsecutiveApiMessages"
import { type TaskContextManager, MAX_CONTEXT_WINDOW_RETRIES } from "./TaskContextManager"
import { getModelMaxOutputTokens } from "../../shared/api"
import { defaultModeSlug } from "../../shared/modes"
import { type ClineProvider } from "../webview/ClineProvider"
import { Package } from "../../shared/package"
import { type ApiMessage } from "../task-persistence"

/**
 * Interface for access needed by ApiRequestBuilder.
 * This is a narrow interface to minimize coupling.
 */
export interface ApiRequestBuilderAccess {
	// Core identifiers
	taskId: string
	instanceId: string

	// Headless background task (parallel subagent / memory writer): delegation
	// tools are stripped from its requests — subtasks are one-shot jobs and
	// must never spawn further subtasks.
	isBackground: boolean

	// API configuration and handler
	apiConfiguration: ProviderSettings
	api: ApiHandler

	// Conversation history
	apiConversationHistory: ApiMessage[]

	// Non-destructive microcompaction: transient set of tool_use_ids whose results
	// are cleared on the OUTGOING request copy (stored history stays pristine).
	// Recomputed each request by the context manager. See applyMicrocompactCleared.
	microcompactedToolUseIds: ReadonlySet<string>

	// Provider reference
	providerRef: WeakRef<ClineProvider>

	// Workspace
	cwd: string
	diffStrategy?: any

	// Context manager for context management
	contextManager: TaskContextManager

	// Token usage
	getTokenUsage(): { contextTokens?: number }

	// Methods
	emit: (event: any, ...args: any[]) => boolean

	// Deferred-tool loading state (Phase 4 of ai_plans/deferred-tool-loading.md).
	// These come straight off the Task instance; the apiRequestBuilder reads
	// `materializedDeferredTools` to re-promote loaded schemas and writes back
	// the per-request `deferredToolDirectory` so `tools_load` can resolve names.
	materializedDeferredTools: Set<string>
	deferredToolDirectory: Map<string, OpenAI.Chat.ChatCompletionTool>
}

/**
 * Result of building tools array
 */
export interface ToolsArrayResult {
	allTools: OpenAI.Chat.ChatCompletionTool[]
	allowedFunctionNames: string[] | undefined
	/** Catalog of deferred (withheld) tools. See ai_plans/deferred-tool-loading.md. */
	deferredCatalog?: import("./deferred-tools").DeferredCatalog
}

/**
 * ApiRequestBuilder handles the construction of API request components.
 * This includes system prompts, tools arrays, and conversation history.
 */
export class ApiRequestBuilder {
	constructor(private readonly access: ApiRequestBuilderAccess) {}

	/**
	 * Build the system prompt with MCP, mode, and custom instructions.
	 */
	async buildSystemPrompt(): Promise<string> {
		const { mcpEnabled } = (await this.access.providerRef.deref()?.getState()) ?? {}
		let mcpHub: McpHub | undefined
		if (mcpEnabled ?? true) {
			const provider = this.access.providerRef.deref()

			if (!provider) {
				throw new Error("Provider reference lost during view transition")
			}

			mcpHub = await McpServerManager.getInstance(provider.context, provider)

			if (!mcpHub) {
				throw new Error("Failed to get MCP hub from server manager")
			}

			await pWaitFor(() => !mcpHub!.isConnecting, { timeout: 10_000 }).catch(() => {
				console.error("MCP servers failed to connect in time")
			})
		}

		const state = await this.access.providerRef.deref()?.getState()

		const {
			mode,
			customModes,
			customModePrompts,
			customInstructions,
			experiments,
			language,
			apiConfiguration,
			enableSubfolderRules,
		} = state ?? {}

		const provider = this.access.providerRef.deref()

		if (!provider) {
			throw new Error("Provider not available")
		}

		const modelInfo = this.access.api.getModel().info

		// Note: rooIgnoreInstructions is not available in this interface yet
		// TODO: Add to interface if needed
		const rooIgnoreInstructions = undefined

		return await SYSTEM_PROMPT(
			provider.context,
			this.access.cwd,
			false,
			mcpHub,
			this.access.diffStrategy,
			mode ?? defaultModeSlug,
			customModePrompts,
			customModes,
			customInstructions,
			experiments,
			language,
			rooIgnoreInstructions,
			{
				todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
				useAgentRules: vscode.workspace.getConfiguration(Package.name).get<boolean>("useAgentRules") ?? true,
				enableSubfolderRules: enableSubfolderRules ?? false,
				newTaskRequireTodos: vscode.workspace
					.getConfiguration(Package.name)
					.get<boolean>("newTaskRequireTodos", false),
				isStealthModel: modelInfo?.isStealthModel,
				// Slim toolset comes off the ACTIVE profile so it follows every
				// mode switch through modeApiConfigs (nothing is cached on the task).
				slimToolset: apiConfiguration?.slimToolset,
				slimHidesMcp: apiConfiguration?.slimHidesMcp,
			},
			undefined, // todoList
			this.access.api.getModel().id,
			provider.getSkillsManager(),
			this.access.materializedDeferredTools,
		)
	}

	/**
	 * Build tools array for API request.
	 */
	async buildToolsArray(
		state: any,
		apiConfiguration: ProviderSettings | undefined,
		mode: string | undefined,
		modelInfo: any,
	): Promise<ToolsArrayResult> {
		const provider = this.access.providerRef.deref()
		if (!provider) {
			throw new Error("Provider reference lost during tool building")
		}

		const supportsAllowedFunctionNames = apiConfiguration?.apiProvider === "gemini"

		// Background tasks (parallel subagents, memory writers) never get
		// delegation tools: a subtask is a small one-shot job that must return
		// to its parent, not fan out further. Foreground tasks lose
		// run_parallel_tasks when the user's concurrency cap turns the feature
		// Off (< 2). Routed through disabledTools so the existing
		// alias-resolving filter removes them.
		let disabledTools = state?.disabledTools
		if (this.access.isBackground) {
			disabledTools = [...(disabledTools ?? []), "new_task", "run_parallel_tasks"]
		} else if (!isParallelTasksEnabled(state?.parallelTasksMaxConcurrency)) {
			disabledTools = [...(disabledTools ?? []), "run_parallel_tasks"]
		}

		const toolsResult = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: this.access.cwd,
			mode,
			customModes: state?.customModes,
			customModePrompts: state?.customModePrompts,
			experiments: state?.experiments,
			apiConfiguration,
			disabledTools,
			modelInfo,
			webToolsEnabled: state?.webToolsEnabled,
			includeAllToolsWithRestrictions: supportsAllowedFunctionNames,
			materializedDeferredTools: this.access.materializedDeferredTools,
		})

		// Persist the deferred-tools directory onto the Task so `tools_load`
		// can resolve names without re-querying the MCP hub. We snapshot the
		// catalog at request time because it can change between turns (a new
		// MCP server might connect, custom tool files might change on disk).
		const directory = this.access.deferredToolDirectory
		directory.clear()
		if (toolsResult.deferredCatalog) {
			const provider2 = this.access.providerRef.deref()
			const mcpTools = provider2?.getMcpHub()
				? (await import("../prompts/tools/native-tools")).getMcpServerTools(provider2.getMcpHub())
				: []
			const candidates = new Map<string, OpenAI.Chat.ChatCompletionTool>()
			for (const tool of mcpTools) {
				candidates.set((tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name, tool)
			}
			// Also include filesystem-discovered custom tools when the experiment is on.
			if (state?.experiments?.customTools) {
				const { customToolRegistry, formatNative } = await import("@roo-code/core")
				const customSerialized = customToolRegistry.getAllSerialized()
				for (const tool of customSerialized) {
					const formatted = formatNative(tool)
					candidates.set(formatted.function.name, formatted)
				}
			}
			for (const entry of toolsResult.deferredCatalog.entries) {
				const tool = candidates.get(entry.name)
				if (tool) {
					directory.set(entry.name, tool)
				}
			}
		}

		return {
			allTools: toolsResult.tools,
			allowedFunctionNames: toolsResult.allowedFunctionNames,
			deferredCatalog: toolsResult.deferredCatalog,
		}
	}

	/**
	 * Build clean conversation history by stripping reasoning blocks.
	 */
	buildCleanConversationHistory(
		messages: ApiMessage[],
		preserveReasoning: boolean = false,
	): Array<
		Anthropic.Messages.MessageParam | { type: "reasoning"; encrypted_content: string; id?: string; summary?: any[] }
	> {
		type ReasoningItemForRequest = {
			type: "reasoning"
			encrypted_content: string
			id?: string
			summary?: any[]
		}

		const cleanConversationHistory: (Anthropic.Messages.MessageParam | ReasoningItemForRequest)[] = []

		// Non-destructive microcompaction (send-time): clear the content of old
		// tool results selected by the context manager for THIS request's model.
		// Operates on a copy — stored history stays pristine — so it is cache-stable
		// and correct across mid-task mode switches (a wider-window mode passes an
		// empty set and gets full fidelity back). No-op (same ref) when the set is
		// empty, which is the common case.
		const microcompactedToolUseIds = this.access.microcompactedToolUseIds
		const sourceMessages =
			microcompactedToolUseIds && microcompactedToolUseIds.size > 0
				? applyMicrocompactCleared(messages, microcompactedToolUseIds)
				: messages

		for (const msg of sourceMessages) {
			// Standalone reasoning: send encrypted, skip plain text
			if (msg.type === "reasoning") {
				if (msg.encrypted_content) {
					cleanConversationHistory.push({
						type: "reasoning",
						summary: msg.summary,
						encrypted_content: msg.encrypted_content!,
						...(msg.id ? { id: msg.id } : {}),
					})
				}
				continue
			}

			// Preferred path: assistant message with embedded reasoning
			if (msg.role === "assistant") {
				const rawContent = msg.content

				const contentArray: Anthropic.Messages.ContentBlockParam[] = Array.isArray(rawContent)
					? (rawContent as Anthropic.Messages.ContentBlockParam[])
					: rawContent !== undefined
						? ([
								{ type: "text", text: rawContent } satisfies Anthropic.Messages.TextBlockParam,
							] as Anthropic.Messages.ContentBlockParam[])
						: []

				const [first, ...rest] = contentArray

				// Check for reasoning_details (OpenRouter format)
				const msgWithDetails = msg as any
				if (msgWithDetails.reasoning_details && Array.isArray(msgWithDetails.reasoning_details)) {
					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (contentArray.length === 0) {
						assistantContent = ""
					} else if (contentArray.length === 1 && contentArray[0].type === "text") {
						assistantContent = (contentArray[0] as Anthropic.Messages.TextBlockParam).text
					} else {
						assistantContent = contentArray
					}

					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
						reasoning_details: msgWithDetails.reasoning_details,
					} as any)

					continue
				}

				// Embedded reasoning: encrypted or plain text
				const hasEncryptedReasoning =
					first && (first as any).type === "reasoning" && typeof (first as any).encrypted_content === "string"
				const hasPlainTextReasoning =
					first && (first as any).type === "reasoning" && typeof (first as any).text === "string"

				if (hasEncryptedReasoning) {
					const reasoningBlock = first as any

					cleanConversationHistory.push({
						type: "reasoning",
						summary: reasoningBlock.summary ?? [],
						encrypted_content: reasoningBlock.encrypted_content,
						...(reasoningBlock.id ? { id: reasoningBlock.id } : {}),
					})

					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (rest.length === 0) {
						assistantContent = ""
					} else if (rest.length === 1 && rest[0].type === "text") {
						assistantContent = (rest[0] as Anthropic.Messages.TextBlockParam).text
					} else {
						assistantContent = rest
					}

					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
					} satisfies Anthropic.Messages.MessageParam)

					continue
				} else if (hasPlainTextReasoning) {
					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (preserveReasoning) {
						assistantContent = contentArray
					} else {
						if (rest.length === 0) {
							assistantContent = ""
						} else if (rest.length === 1 && rest[0].type === "text") {
							assistantContent = (rest[0] as Anthropic.Messages.TextBlockParam).text
						} else {
							assistantContent = rest
						}
					}

					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
					} satisfies Anthropic.Messages.MessageParam)

					continue
				}
			}

			// Default path for regular messages
			if (msg.role) {
				cleanConversationHistory.push({
					role: msg.role,
					content: msg.content as Anthropic.Messages.ContentBlockParam[] | string,
				})
			}
		}

		return cleanConversationHistory
	}

	/**
	 * Prepare the conversation history for API request.
	 * This includes getting effective history, merging consecutive messages,
	 * and removing images if needed.
	 */
	prepareConversationHistory(
		preserveReasoning: boolean = false,
	): Array<
		Anthropic.Messages.MessageParam | { type: "reasoning"; encrypted_content: string; id?: string; summary?: any[] }
	> {
		// Build clean conversation history
		const effectiveHistory = getEffectiveApiHistory(this.access.apiConversationHistory)
		const messagesSinceLastSummary = getMessagesSinceLastSummary(effectiveHistory)
		const mergedForApi = mergeConsecutiveApiMessages(messagesSinceLastSummary, { roles: ["user"] })
		const messagesWithoutImages = maybeRemoveImageBlocks(mergedForApi, this.access.api)
		const cleanConversationHistory = this.buildCleanConversationHistory(
			messagesWithoutImages as ApiMessage[],
			preserveReasoning,
		)

		return cleanConversationHistory
	}

	/**
	 * Build the complete API request metadata including tools.
	 */
	async buildRequestMetadata(
		state: any,
		mode: string | undefined,
		skipPrevResponseIdOnce: boolean,
	): Promise<ApiHandlerCreateMessageMetadata> {
		const apiConfiguration = state?.apiConfiguration ?? this.access.apiConfiguration
		const modelInfo = this.access.api.getModel().info
		const { allTools, allowedFunctionNames } = await this.buildToolsArray(state, apiConfiguration, mode, modelInfo)

		const metadata: ApiHandlerCreateMessageMetadata = {
			mode: mode,
			taskId: this.access.taskId,
			suppressPreviousResponseId: skipPrevResponseIdOnce,
			...(allTools.length > 0
				? {
						tools: allTools,
						tool_choice: "auto",
						parallelToolCalls: true,
						...(allowedFunctionNames ? { allowedFunctionNames } : {}),
					}
				: {}),
		}

		return metadata
	}

	/**
	 * Get the current profile ID from state.
	 */
	getCurrentProfileId(state: any): string {
		return (
			state?.listApiConfigMeta?.find((profile: any) => profile.name === state?.currentApiConfigName)?.id ??
			"default"
		)
	}
}
