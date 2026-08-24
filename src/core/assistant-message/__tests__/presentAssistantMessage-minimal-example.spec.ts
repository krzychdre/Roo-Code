// npx vitest run src/core/assistant-message/__tests__/presentAssistantMessage-minimal-example.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"

import { TOOL_MINIMAL_EXAMPLES } from "../../prompts/tools/native-tools/examples"
import { presentAssistantMessage } from "../presentAssistantMessage"

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => true),
}))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
			captureException: vi.fn(),
			captureEvent: vi.fn(),
		},
	},
}))

describe("presentAssistantMessage attaches minimal valid examples", () => {
	let mockTask: any

	beforeEach(() => {
		mockTask = {
			taskId: "test-task-id",
			instanceId: "test-instance",
			abort: false,
			presentAssistantMessageLocked: false,
			presentAssistantMessageHasPendingUpdates: false,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [],
			userMessageContent: [],
			didCompleteReadingStream: false,
			didRejectTool: false,
			didAlreadyUseTool: false,
			consecutiveMistakeCount: 0,
			consecutiveMistakeLimit: 3,
			clineMessages: [],
			apiConfiguration: { apiProvider: "openai" },
			api: { getModel: () => ({ id: "test-model", info: {} }) },
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: {
				check: vi.fn().mockReturnValue({ allowExecution: true }),
			},
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }),
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			askSay: {
				ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
				say: vi.fn().mockResolvedValue(undefined),
			},
		}

		mockTask.pushToolResultToUserContent = vi.fn().mockImplementation((toolResult: any) => {
			const existing = mockTask.userMessageContent.find(
				(block: any) => block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
			)
			if (existing) {
				return false
			}
			mockTask.userMessageContent.push(toolResult)
			return true
		})
	})

	function resultFor(toolCallId: string) {
		const toolResult = mockTask.userMessageContent.find(
			(item: any) => item.type === "tool_result" && item.tool_use_id === toolCallId,
		)
		expect(toolResult).toBeDefined()
		return JSON.parse(String(toolResult.content))
	}

	it("teaches the schema on the hot path: a known tool with no finalized nativeArgs", async () => {
		const toolCallId = "tool_call_no_native_args"
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId,
				name: "apply_diff",
				params: { path: "src/app.ts" },
				// nativeArgs never finalized: the model streamed invalid arguments.
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask)

		const parsed = resultFor(toolCallId)

		expect(parsed.error).toContain("Invalid tool call for 'apply_diff': missing nativeArgs")
		expect(parsed.failed_tool).toBe("apply_diff")
		expect(parsed.minimal_valid_example).toEqual(TOOL_MINIMAL_EXAMPLES.apply_diff)
		expect(mockTask.consecutiveMistakeCount).toBe(1)
	})

	it("teaches the schema when the repetition limit fires", async () => {
		mockTask.toolRepetitionDetector.check = vi.fn().mockReturnValue({
			allowExecution: false,
			askUser: { messageKey: "mistake_limit_reached", messageDetail: "stuck on {toolName}" },
		})

		const toolCallId = "tool_call_repeat"
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId,
				name: "search_files",
				params: { path: "src", regex: "foo" },
				nativeArgs: { path: "src", regex: "foo" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask)

		const parsed = resultFor(toolCallId)

		expect(parsed.error).toContain("Tool call repetition limit reached for search_files")
		expect(parsed.failed_tool).toBe("search_files")
		expect(parsed.minimal_valid_example).toEqual(TOOL_MINIMAL_EXAMPLES.search_files)
	})

	it("omits the example for a tool that is never advertised under that name", async () => {
		const toolCallId = "tool_call_mcp"
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId,
				name: "use_mcp_tool",
				params: { server_name: "s" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask)

		const parsed = resultFor(toolCallId)

		expect(parsed.error).toContain("missing nativeArgs")
		expect(parsed).not.toHaveProperty("minimal_valid_example")
	})
})
