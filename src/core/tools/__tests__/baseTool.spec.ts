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
		expect(callbacks.handleError).toHaveBeenCalledWith(
			"handling partial write_to_file",
			expect.any(Error),
			"write_to_file",
		)
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

	describe("runtime safety net (WS-D follow-up)", () => {
		/**
		 * A tool whose `execute` throws before (or instead of) opening its own try/catch.
		 * That is the real shape of the gap: the prefix of most tools (parameter checks,
		 * workspace lookups, the first file read) runs outside any catch, and the throw
		 * used to escape into an un-awaited promise with no tool_result for the model.
		 */
		class ThrowingTool extends BaseTool<"write_to_file"> {
			readonly name = "write_to_file" as const

			constructor(private readonly thrown: unknown) {
				super()
			}

			async execute(): Promise<void> {
				throw this.thrown
			}
		}

		function makeCompleteBlock(): ToolUse<"write_to_file"> {
			return {
				type: "tool_use",
				name: "write_to_file",
				params: { path: "test/file.txt", content: "test" },
				nativeArgs: { path: "test/file.txt", content: "test" } as any,
				partial: false,
			}
		}

		it("routes an escaping runtime error to handleError with the tool name", async () => {
			const tool = new ThrowingTool(new Error("EACCES: permission denied"))
			const callbacks = makeCallbacks()

			await expect(tool.handle(makeMockTask(), makeCompleteBlock(), callbacks)).resolves.toBeUndefined()

			expect(callbacks.handleError).toHaveBeenCalledTimes(1)

			const [action, error, toolName] = (callbacks.handleError as any).mock.calls[0]

			expect(action).toBe("executing write_to_file")
			expect((error as Error).message).toContain("EACCES")
			expect(toolName).toBe("write_to_file")
		})

		it("normalizes a non-Error throw so the envelope still carries the tool name", async () => {
			const tool = new ThrowingTool("plain string failure")
			const callbacks = makeCallbacks()

			await tool.handle(makeMockTask(), makeCompleteBlock(), callbacks)

			const [, error, toolName] = (callbacks.handleError as any).mock.calls[0]

			expect(error).toBeInstanceOf(Error)
			expect((error as Error).message).toBe("plain string failure")
			expect(toolName).toBe("write_to_file")
		})

		it("does not touch didToolFailInCurrentTurn", async () => {
			// attempt_completion refuses to run when that flag is set, so the safety net
			// must stay a reporting mechanism and not change control flow.
			const tool = new ThrowingTool(new Error("boom"))
			const task = makeMockTask()

			await tool.handle(task, makeCompleteBlock(), makeCallbacks())

			expect(task.didToolFailInCurrentTurn).toBeUndefined()
		})

		it("leaves a successful execute untouched", async () => {
			class OkTool extends BaseTool<"write_to_file"> {
				readonly name = "write_to_file" as const
				async execute(): Promise<void> {}
			}

			const callbacks = makeCallbacks()

			await new OkTool().handle(makeMockTask(), makeCompleteBlock(), callbacks)

			expect(callbacks.handleError).not.toHaveBeenCalled()
		})
	})
})
