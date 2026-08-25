// npx vitest run src/core/task/__tests__/TaskApiLoop.mistake-limit-example.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

import { TOOL_MINIMAL_EXAMPLES } from "../../prompts/tools/native-tools/examples"
import { TaskApiLoop } from "../TaskApiLoop"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureConsecutiveMistakeError: vi.fn(),
			captureException: vi.fn(),
			captureEvent: vi.fn(),
		},
	},
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

describe("TaskApiLoop consecutive-mistake guidance", () => {
	let access: any

	beforeEach(() => {
		access = {
			taskId: "task-1",
			consecutiveMistakeCount: 3,
			consecutiveMistakeLimit: 3,
			apiConfiguration: { apiProvider: "openai" },
			lastToolErrorName: undefined,
			askSay: {
				ask: vi.fn().mockResolvedValue({ response: "messageResponse", text: "do it properly", images: [] }),
				say: vi.fn().mockResolvedValue(undefined),
			},
		}
	})

	async function runGuidance(): Promise<any> {
		const loop = new TaskApiLoop(access as any)
		const content: any[] = []

		// handleConsecutiveMistakeLimit is private; the guidance payload it produces is the
		// unit under test, so reach it directly rather than driving a whole API turn.
		await (loop as any).handleConsecutiveMistakeLimit(content)

		const textBlock = content.find((block) => block.type === "text")
		expect(textBlock).toBeDefined()
		return JSON.parse(textBlock.text)
	}

	it("attaches the failing tool's minimal example when the mistakes were tool-call failures", async () => {
		access.lastToolErrorName = "apply_diff"

		const parsed = await runGuidance()

		expect(parsed.status).toBe("guidance")
		expect(parsed.failed_tool).toBe("apply_diff")
		expect(parsed.minimal_valid_example).toEqual(TOOL_MINIMAL_EXAMPLES.apply_diff)
	})

	it("attaches no example when the mistakes came from turns that used no tool", async () => {
		// The no-tool-used path clears lastToolErrorName precisely so a tool that had
		// succeeded is not offered back to the model as something to retry.
		access.lastToolErrorName = undefined

		const parsed = await runGuidance()

		expect(parsed.status).toBe("guidance")
		expect(parsed).not.toHaveProperty("failed_tool")
		expect(parsed).not.toHaveProperty("minimal_valid_example")
	})

	it("clears the remembered tool after emitting the guidance", async () => {
		access.lastToolErrorName = "apply_diff"

		await runGuidance()

		expect(access.lastToolErrorName).toBeUndefined()
		expect(access.consecutiveMistakeCount).toBe(0)
	})
})
