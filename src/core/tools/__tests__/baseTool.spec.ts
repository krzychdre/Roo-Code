import { Task } from "../../task/Task"
import type { ToolUse } from "../../../shared/tools"
import { BaseTool, ToolCallbacks } from "../BaseTool"

vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn().mockResolvedValue(undefined),
	},
	env: {
		openExternal: vi.fn(),
	},
	Uri: {
		parse: vi.fn(),
	},
}))

describe("BaseTool partial error handling (TL-4)", () => {
	class TestTool extends BaseTool<"write_to_file"> {
		readonly name = "write_to_file" as const

		private shouldThrow: boolean

		constructor(shouldThrow: boolean) {
			super()
			this.shouldThrow = shouldThrow
		}

		async execute(): Promise<void> {
			// Not used in these tests
		}

		override async handlePartial(task: Task): Promise<void> {
			// Simulate opening the diff editor then optionally throwing during update
			if (!this.shouldThrow) {
				await task.diffViewProvider.open("test/file.txt")
				return
			}

			await task.diffViewProvider.open("test/file.txt")
			throw new Error("update failed during partial")
		}
	}

	function makeMockTask(): any {
		return {
			diffViewProvider: {
				open: vi.fn().mockResolvedValue(undefined),
				reset: vi.fn().mockResolvedValue(undefined),
				isEditing: false,
				editType: undefined,
			},
		}
	}

	function makeCallbacks(): ToolCallbacks {
		return {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn().mockResolvedValue(undefined),
			pushToolResult: vi.fn(),
		}
	}

	function makePartialBlock(): ToolUse<"write_to_file"> {
		return {
			type: "tool_use",
			name: "write_to_file",
			params: { path: "test/file.txt", content: "test" },
			nativeArgs: { path: "test/file.txt", content: "test" } as any,
			partial: true,
		}
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("resets diffViewProvider when handlePartial throws", async () => {
		const tool = new TestTool(true)
		const task = makeMockTask()
		const callbacks = makeCallbacks()

		await tool.handle(task, makePartialBlock(), callbacks)

		expect(task.diffViewProvider.open).toHaveBeenCalledWith("test/file.txt")
		expect(callbacks.handleError).toHaveBeenCalledWith("handling partial write_to_file", expect.any(Error))
		expect(task.diffViewProvider.reset).toHaveBeenCalled()
	})

	it("does not reset diffViewProvider when handlePartial succeeds", async () => {
		const tool = new TestTool(false)
		const task = makeMockTask()
		const callbacks = makeCallbacks()

		await tool.handle(task, makePartialBlock(), callbacks)

		expect(task.diffViewProvider.open).toHaveBeenCalledWith("test/file.txt")
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(task.diffViewProvider.reset).not.toHaveBeenCalled()
	})

	describe("malformed native arguments (WS-D)", () => {
		function makeInvalidBlock(params: Record<string, string>): ToolUse<"write_to_file"> {
			return {
				type: "tool_use",
				name: "write_to_file",
				params: params as any,
				// nativeArgs deliberately absent: this is the malformed-call path.
				partial: false,
			}
		}

		it("forwards the tool name to handleError instead of embedding an example in the message", async () => {
			const tool = new TestTool(false)
			const task = makeMockTask()
			const callbacks = makeCallbacks()

			await tool.handle(task, makeInvalidBlock({ path: "test/file.txt" }), callbacks)

			expect(callbacks.handleError).toHaveBeenCalledWith(
				"parsing write_to_file args",
				expect.any(Error),
				"write_to_file",
			)

			const error = (callbacks.handleError as any).mock.calls[0][1] as Error

			expect(error.message).toContain("Failed to parse write_to_file parameters")
			// The example must never live in Error.message: handleError serializes the Error
			// into a string field, which would escape the example twice and repeat it in the
			// stack property.
			expect(error.message).not.toContain("minimal_valid_example")
			expect(error.message).not.toContain("src/app.ts")
		})

		it("forwards the tool name on the legacy XML rejection too", async () => {
			const tool = new TestTool(false)
			const task = makeMockTask()
			const callbacks = makeCallbacks()

			await tool.handle(task, makeInvalidBlock({ path: "<path>a.txt</path>" }), callbacks)

			const [, error, toolName] = (callbacks.handleError as any).mock.calls[0]

			expect((error as Error).message).toContain("XML tool calls are no longer supported")
			expect(toolName).toBe("write_to_file")
		})
	})
})
