// cd src && npx vitest run core/assistant-message/__tests__/presentAssistantMessage-read-artifact.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"

import { presentAssistantMessage } from "../presentAssistantMessage"
import { readArtifactTool } from "../../tools/ReadArtifactTool"

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => true),
}))
vi.mock("../../tools/ReadArtifactTool", () => ({
	readArtifactTool: { handle: vi.fn().mockResolvedValue(undefined) },
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
 * Dispatch-level guarantee: both the canonical `read_artifact` name and the
 * legacy `read_command_output` name reach the same implementation, so a history
 * written before the rename (or a small model repeating the old habit) keeps
 * working.
 */
describe("presentAssistantMessage - read_artifact dispatch", () => {
	let mockTask: any

	beforeEach(() => {
		vi.mocked(readArtifactTool.handle).mockClear()

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

	const dispatch = async (name: string) => {
		mockTask.currentStreamingContentIndex = 0
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: `call_${name}`,
				name,
				params: { artifact_id: "tool-1706119234567.txt" },
				nativeArgs: { artifact_id: "tool-1706119234567.txt" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask)
	}

	it("routes read_artifact to the ReadArtifactTool", async () => {
		await dispatch("read_artifact")

		expect(readArtifactTool.handle).toHaveBeenCalledTimes(1)
		expect(vi.mocked(readArtifactTool.handle).mock.calls[0][1]).toMatchObject({ name: "read_artifact" })
	})

	it("routes the legacy read_command_output name to the same implementation", async () => {
		await dispatch("read_command_output")

		expect(readArtifactTool.handle).toHaveBeenCalledTimes(1)
		expect(vi.mocked(readArtifactTool.handle).mock.calls[0][1]).toMatchObject({ name: "read_command_output" })
	})
})
