// npx vitest run src/core/assistant-message/__tests__/presentAssistantMessage-runtime-errors.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"

import { TOOL_MINIMAL_EXAMPLES } from "../../prompts/tools/native-tools/examples"
import { AskIgnoredError } from "../../task/AskIgnoredError"
import { isValidToolName, validateToolUse } from "../../tools/validateToolUse"
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

/**
 * `list_files` stands in for every tool here: what is under test is the `handleError`
 * closure the dispatcher hands to the tool, not the tool itself. The mock lets each test
 * decide what the tool does with that callback (fail with a name, fail with an internal
 * control-flow signal, fail after the user cancelled).
 */
const listFilesHandle = vi.fn()

vi.mock("../../tools/ListFilesTool", () => ({
	listFilesTool: {
		handle: (...args: unknown[]) => listFilesHandle(...args),
	},
}))

describe("runtime tool failures are counted and taught", () => {
	let mockTask: any

	beforeEach(() => {
		listFilesHandle.mockReset()
		// The validation gate is shared state across the tests in this file: put it back to
		// "known tool, validation passes" so every test starts from the normal path.
		vi.mocked(isValidToolName).mockReturnValue(true)
		vi.mocked(validateToolUse).mockImplementation(() => {})

		mockTask = {
			taskId: "test-task-id",
			instanceId: "test-instance",
			abort: false,
			abandoned: false,
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

		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "tool_call_list_files",
				name: "list_files",
				params: { path: "src" },
				nativeArgs: { path: "src", recursive: false },
				partial: false,
			},
		]
	})

	function resultFor(toolCallId: string) {
		return mockTask.userMessageContent.find(
			(item: any) => item.type === "tool_result" && item.tool_use_id === toolCallId,
		)
	}

	it("counts the failure, records the tool and teaches the minimal call", async () => {
		listFilesHandle.mockImplementation(async (_task: any, _block: any, callbacks: any) => {
			await callbacks.handleError("listing files", new Error("EACCES: permission denied"), "list_files")
		})

		await presentAssistantMessage(mockTask)

		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.recordToolError).toHaveBeenCalledWith("list_files", "EACCES: permission denied")

		const parsed = JSON.parse(String(resultFor("tool_call_list_files").content))

		expect(parsed.status).toBe("error")
		expect(parsed.error).toContain("Error listing files")
		expect(parsed.failed_tool).toBe("list_files")
		expect(parsed.minimal_valid_example).toEqual(TOOL_MINIMAL_EXAMPLES.list_files)
	})

	it("does not count a failure reported without a tool name", async () => {
		// The custom-tool catch keeps the 2-argument form on purpose: it already did its
		// own accounting under the `custom_tool` bucket.
		listFilesHandle.mockImplementation(async (_task: any, _block: any, callbacks: any) => {
			await callbacks.handleError("listing files", new Error("boom"))
		})

		await presentAssistantMessage(mockTask)

		expect(mockTask.consecutiveMistakeCount).toBe(0)
		expect(mockTask.recordToolError).not.toHaveBeenCalled()

		const parsed = JSON.parse(String(resultFor("tool_call_list_files").content))

		expect(parsed).not.toHaveProperty("failed_tool")
		expect(parsed).not.toHaveProperty("minimal_valid_example")
	})

	it("treats AskIgnoredError as control flow, not as a mistake", async () => {
		listFilesHandle.mockImplementation(async (_task: any, _block: any, callbacks: any) => {
			await callbacks.handleError("listing files", new AskIgnoredError("superseded"), "list_files")
		})

		await presentAssistantMessage(mockTask)

		expect(mockTask.consecutiveMistakeCount).toBe(0)
		expect(mockTask.recordToolError).not.toHaveBeenCalled()
		// No error say and no error envelope either: the closure returns before both.
		expect(mockTask.askSay.say).not.toHaveBeenCalledWith("error", expect.anything())
		expect(resultFor("tool_call_list_files")).toBeUndefined()
	})

	it("does not charge the model for a failure caused by a user cancel", async () => {
		listFilesHandle.mockImplementation(async (task: any, _block: any, callbacks: any) => {
			// The cancel lands while the tool is mid-flight, which is how it happens in
			// practice: the teardown makes the in-flight operation blow up.
			task.abort = true
			await callbacks.handleError("listing files", new Error("aborted"), "list_files")
		})

		await presentAssistantMessage(mockTask)

		expect(mockTask.consecutiveMistakeCount).toBe(0)
		expect(mockTask.recordToolError).not.toHaveBeenCalled()
	})

	it("does not charge the model on an abandoned task either", async () => {
		listFilesHandle.mockImplementation(async (task: any, _block: any, callbacks: any) => {
			task.abandoned = true
			await callbacks.handleError("listing files", new Error("aborted"), "list_files")
		})

		await presentAssistantMessage(mockTask)

		expect(mockTask.consecutiveMistakeCount).toBe(0)
		expect(mockTask.recordToolError).not.toHaveBeenCalled()
	})

	it("does not charge a tool that already delivered its result", async () => {
		// The shape of the bug this guards: `write_to_file`, `apply_diff` and `edit_file` push
		// the SUCCESS result and only then run their trailing cleanup (diff view reset, queued
		// messages) inside the same `try`. A throw in that cleanup used to be charged to a tool
		// that had just worked, and the error envelope was dropped as a duplicate, so the model
		// was never told why.
		listFilesHandle.mockImplementation(async (_task: any, _block: any, callbacks: any) => {
			callbacks.pushToolResult("Files listed successfully")
			await callbacks.handleError("listing files", new Error("cleanup blew up"), "list_files")
		})

		await presentAssistantMessage(mockTask)

		expect(mockTask.consecutiveMistakeCount).toBe(0)
		expect(mockTask.recordToolError).not.toHaveBeenCalled()
		// The success result is what the model receives; the late error is dropped as a duplicate.
		expect(String(resultFor("tool_call_list_files").content)).toBe("Files listed successfully")
	})

	it("counts each failing turn once, so the circuit breaker can trip", async () => {
		listFilesHandle.mockImplementation(async (_task: any, _block: any, callbacks: any) => {
			await callbacks.handleError("listing files", new Error("EACCES"), "list_files")
		})

		for (let turn = 0; turn < 3; turn++) {
			mockTask.userMessageContent = []
			mockTask.currentStreamingContentIndex = 0
			mockTask.didAlreadyUseTool = false
			await presentAssistantMessage(mockTask)
		}

		expect(mockTask.consecutiveMistakeCount).toBe(3)
		expect(mockTask.recordToolError).toHaveBeenCalledTimes(3)
	})

	describe("the validation rejection only records real tool names", () => {
		it("records the name when the tool exists but is rejected for the mode", async () => {
			vi.mocked(validateToolUse).mockImplementation(() => {
				throw new Error('Tool "list_files" is not allowed in architect mode.')
			})

			await presentAssistantMessage(mockTask)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("list_files", expect.stringContaining("not allowed"))
			expect(listFilesHandle).not.toHaveBeenCalled()
		})

		it("skips recording a hallucinated tool name so telemetry stays typed", async () => {
			// `validateToolUse` throws for an unknown name too, and the name is an arbitrary
			// model-supplied string at that point. Recording it would put it into
			// `Task.toolUsage` and into the `TaskToolFailed` event, where every consumer
			// expects a real `ToolName`.
			mockTask.assistantMessageContent[0].name = "list_file"
			vi.mocked(isValidToolName).mockReturnValue(false)
			vi.mocked(validateToolUse).mockImplementation(() => {
				throw new Error('Unknown tool "list_file". This tool does not exist.')
			})

			await presentAssistantMessage(mockTask)

			// Still a mistake, still reported to the model: only the typed record is skipped.
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
			expect(String(resultFor("tool_call_list_files").content)).toContain("Unknown tool")
		})
	})
})
