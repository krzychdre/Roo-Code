// cd src && npx vitest run core/tools/__tests__/SearchTaskHistoryTool.spec.ts

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

import type { ApiMessage } from "../../task-persistence/apiMessages"
import { SearchTaskHistoryTool } from "../SearchTaskHistoryTool"

/**
 * The task directory is a REAL temporary directory: the artifact half of the
 * corpus is read straight off disk, so faking `fs` here would only test the
 * fake. Only the two seams that need the extension host are mocked: the
 * persisted-message reader and the task-directory resolver.
 */
const readApiMessagesMock = vi.fn()
let taskDir = ""

vi.mock("../../task-persistence/apiMessages", () => ({
	readApiMessages: (...args: unknown[]) => readApiMessagesMock(...args),
}))

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi.fn(async () => taskDir),
}))

function message(role: "user" | "assistant", text: string, ts: number): ApiMessage {
	return { role, ts, content: [{ type: "text", text }] }
}

describe("SearchTaskHistoryTool", () => {
	let tool: SearchTaskHistoryTool
	let mockTask: any
	let pushToolResult: ReturnType<typeof vi.fn>

	beforeEach(() => {
		vi.clearAllMocks()

		taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-task-history-tool-"))
		tool = new SearchTaskHistoryTool()
		pushToolResult = vi.fn()
		readApiMessagesMock.mockResolvedValue([])

		mockTask = {
			taskId: "task-123",
			consecutiveMistakeCount: 3,
			didToolFailInCurrentTurn: false,
			say: vi.fn().mockResolvedValue(undefined),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter: query"),
			recordToolError: vi.fn(),
			providerRef: {
				deref: vi.fn(() => ({ context: { globalStorageUri: { fsPath: "/mock/global/storage" } } })),
			},
		}
	})

	afterEach(() => {
		fs.rmSync(taskDir, { recursive: true, force: true })
	})

	const callbacks = () => ({
		askApproval: vi.fn(),
		handleError: vi.fn(),
		pushToolResult,
	})

	function writeArtifact(name: string, body: string): void {
		const dir = path.join(taskDir, name.startsWith("cmd-") ? "command-output" : "artifacts")
		fs.mkdirSync(dir, { recursive: true })
		fs.writeFileSync(path.join(dir, name), body, "utf8")
	}

	it("searches the persisted messages and the artifacts together", async () => {
		readApiMessagesMock.mockResolvedValue([message("user", "deploy to staging first", 1_000)])
		writeArtifact("prune-1700000000000.txt", "noise\ndeploy to production later\nnoise")

		await tool.execute({ query: "deploy to" }, mockTask as any, callbacks() as any)

		const result = pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("deploy to staging first")
		expect(result).toContain("deploy to production later")
		expect(result).toContain("artifact prune-1700000000000.txt")
	})

	it("clears the mistake counter and reports the search to the UI", async () => {
		readApiMessagesMock.mockResolvedValue([message("user", "the port is 8085", 1_000)])

		await tool.execute({ query: "port" }, mockTask as any, callbacks() as any)

		expect(mockTask.consecutiveMistakeCount).toBe(0)
		const sayPayload = JSON.parse(mockTask.say.mock.calls.find((c: any[]) => c[0] === "tool")![1])
		expect(sayPayload).toMatchObject({ tool: "searchTaskHistory", query: "port" })
	})

	it("honours max_results and reports what it left out", async () => {
		readApiMessagesMock.mockResolvedValue(
			[1, 2, 3, 4].map((n) => message("user", `checkpoint ${n} reached`, n * 1_000)),
		)

		await tool.execute({ query: "checkpoint", max_results: 1 }, mockTask as any, callbacks() as any)

		const result = pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("checkpoint 4 reached")
		expect(result).toContain("3 older match(es) are not shown")
	})

	it("clamps an absurd max_results to the hard cap instead of failing", async () => {
		readApiMessagesMock.mockResolvedValue([message("user", "one hit here", 1_000)])

		await tool.execute({ query: "hit", max_results: 10_000 }, mockTask as any, callbacks() as any)

		expect(pushToolResult.mock.calls[0][0]).toContain("one hit here")
		expect(mockTask.didToolFailInCurrentTurn).toBe(false)
	})

	it("treats an uncompilable query as literal text rather than erroring", async () => {
		readApiMessagesMock.mockResolvedValue([message("user", "call parse(input) twice", 1_000)])

		await tool.execute({ query: "parse(input" }, mockTask as any, callbacks() as any)

		const result = pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("as literal text")
		expect(result).toContain("call parse(input) twice")
	})

	it("does not find the call that is asking the question", async () => {
		// The assistant turn is persisted before the tool runs, so the history
		// the tool reads already contains this very invocation.
		readApiMessagesMock.mockResolvedValue([
			{
				role: "assistant",
				ts: 1_000,
				content: [
					{
						type: "tool_use",
						id: "call_1",
						name: "search_task_history",
						input: { query: "nowhere-token" },
					},
				],
			},
		])

		await tool.execute({ query: "nowhere-token" }, mockTask as any, callbacks() as any)

		expect(pushToolResult.mock.calls[0][0]).toContain("No match")
	})

	it("returns quickly for a pattern that would backtrack exponentially", async () => {
		readApiMessagesMock.mockResolvedValue([message("user", "a".repeat(2_000), 1_000)])

		const started = Date.now()
		await tool.execute({ query: "(a+)+b" }, mockTask as any, callbacks() as any)

		expect(Date.now() - started).toBeLessThan(1_000)
		expect(pushToolResult.mock.calls[0][0]).toContain("exponential time")
	}, 10_000)

	it("says the history is unreadable rather than suggesting another query", async () => {
		readApiMessagesMock.mockResolvedValue([])

		await tool.execute({ query: "anything" }, mockTask as any, callbacks() as any)

		expect(pushToolResult.mock.calls[0][0]).toContain("no stored history to search")
	})

	it("asks for the missing parameter when query is absent or blank", async () => {
		await tool.execute({ query: "   " } as any, mockTask as any, callbacks() as any)

		expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("search_task_history", "query")
		expect(mockTask.recordToolError).toHaveBeenCalledWith("search_task_history")
		expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		expect(pushToolResult).toHaveBeenCalledWith("Missing parameter: query")
	})

	it("returns a corrective tool error when the storage path is unavailable", async () => {
		mockTask.providerRef.deref = vi.fn(() => undefined)

		await tool.execute({ query: "anything" }, mockTask as any, callbacks() as any)

		expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		expect(String(pushToolResult.mock.calls[0][0])).toContain("cannot reach the task storage")
	})

	it("turns a history read failure into a tool error instead of ending the turn", async () => {
		readApiMessagesMock.mockRejectedValue(new Error("disk on fire"))

		await tool.execute({ query: "anything" }, mockTask as any, callbacks() as any)

		expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		expect(String(pushToolResult.mock.calls[0][0])).toContain("disk on fire")
	})
})
