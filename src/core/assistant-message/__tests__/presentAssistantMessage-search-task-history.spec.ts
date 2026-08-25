// cd src && npx vitest run core/assistant-message/__tests__/presentAssistantMessage-search-task-history.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"

import { presentAssistantMessage } from "../presentAssistantMessage"
import { searchTaskHistoryTool } from "../../tools/SearchTaskHistoryTool"

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => true),
}))
vi.mock("../../tools/SearchTaskHistoryTool", () => ({
	searchTaskHistoryTool: { handle: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
		},
	},
}))

/**
 * Dispatch-level guarantee: a `search_task_history` block reaches the tool with
 * its typed arguments intact. Without the switch case the block would fall
 * through to the unknown-tool path and the model would be told the tool does
 * not exist, while the prompt advertises it.
 */
describe("presentAssistantMessage - search_task_history dispatch", () => {
	let mockTask: any

	beforeEach(() => {
		vi.mocked(searchTaskHistoryTool.handle).mockClear()

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
			clineMessages: [],
			api: { getModel: () => ({ id: "test-model", info: {} }) },
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }),
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
			askSay: {
				ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
				say: vi.fn().mockResolvedValue(undefined),
			},
			pushToolResultToUserContent: vi.fn().mockReturnValue(true),
		}
	})

	const dispatch = async (nativeArgs: Record<string, unknown>) => {
		mockTask.currentStreamingContentIndex = 0
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_search_task_history",
				name: "search_task_history",
				params: { query: String(nativeArgs.query ?? "") },
				nativeArgs,
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask)
	}

	it("routes search_task_history to the SearchTaskHistoryTool", async () => {
		await dispatch({ query: "retry wrapper" })

		expect(searchTaskHistoryTool.handle).toHaveBeenCalledTimes(1)
		expect(vi.mocked(searchTaskHistoryTool.handle).mock.calls[0][1]).toMatchObject({
			name: "search_task_history",
			nativeArgs: { query: "retry wrapper" },
		})
	})

	it("passes max_results through untouched", async () => {
		await dispatch({ query: "retry wrapper", max_results: 25 })

		expect(vi.mocked(searchTaskHistoryTool.handle).mock.calls[0][1]).toMatchObject({
			nativeArgs: { query: "retry wrapper", max_results: 25 },
		})
	})
})
