// cd src && npx vitest run core/task/__tests__/TaskContextManager.prune-row.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"

import type { ApiMessage } from "../../task-persistence/apiMessages"
import { TaskContextManager, type TaskContextManagerAccess } from "../TaskContextManager"

/**
 * A prune-only round rewrites the STORED history: old tool output the transcript
 * used to hold in full now lives in a task artifact. That is the one context
 * pass whose effect the user can see by scrolling back, so unlike the free
 * microcompaction pre-pass it must announce itself, and the announcement must
 * carry the numbers `manageContext` reported.
 *
 * These tests drive `manageContextIfNeeded` against a stubbed `manageContext`,
 * which is the only way to pin the row without standing up a whole Task.
 */

const manageContextMock = vi.hoisted(() => vi.fn())
const willManageContextMock = vi.hoisted(() => vi.fn().mockReturnValue(true))

vi.mock("../../context-management", () => ({
	manageContext: manageContextMock,
	willManageContext: willManageContextMock,
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

const prunedHistory: ApiMessage[] = [{ role: "user", content: "pruned history", ts: 1 }]

function buildAccess() {
	const say = vi.fn().mockResolvedValue(undefined)
	const overwriteApiConversationHistory = vi.fn().mockResolvedValue(undefined)
	const apiHandler = { getModel: () => ({ id: "m", info: {} }), countTokens: async () => 0 }

	const access = {
		taskId: "prune-row-task",
		apiConfiguration: {},
		api: apiHandler,
		getCondenseApiHandler: vi.fn().mockResolvedValue(apiHandler),
		apiConversationHistory: [{ role: "user", content: "original history", ts: 1 }],
		consecutiveAutoCompactFailures: 0,
		microcompactedToolUseIds: new Set<string>(),
		microcompactStrippedTokens: 0,
		cwd: "/workspace",
		fileContextTracker: { getFilesReadByRoo: vi.fn().mockResolvedValue([]) },
		// No provider: the condense spinner and the tool metadata build are both
		// optional-chained on it, which keeps this test to the row under test.
		providerRef: { deref: () => undefined },
		history: { overwriteApiConversationHistory },
		askSay: { say },
		getArtifactStore: vi.fn().mockResolvedValue(undefined),
		getTokenUsage: vi.fn().mockReturnValue({ contextTokens: 0 }),
		getSystemPrompt: vi.fn().mockResolvedValue("system"),
		emit: vi.fn(),
		processQueuedMessages: vi.fn(),
	} as unknown as TaskContextManagerAccess

	return { access, say, overwriteApiConversationHistory }
}

const params = {
	state: { mode: "code" },
	systemPrompt: "system",
	autoCondenseContext: true,
	autoCondenseContextPercent: 70,
	profileThresholds: {},
	currentProfileId: "default",
	contextTokens: 71_000,
	maxTokens: 8_000,
	contextWindow: 100_000,
	lastMessageTokens: 10,
}

describe("prune-only round announces itself", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		willManageContextMock.mockReturnValue(true)
	})

	it("emits a context_pruned row carrying the counts manageContext reported", async () => {
		manageContextMock.mockResolvedValue({
			messages: prunedHistory,
			summary: "",
			cost: 0,
			prevContextTokens: 71_010,
			newContextTokens: 66_000,
			prunedCount: 3,
			prunedBytesSaved: 250_000,
			summarySkipped: true,
		})

		const { access, say, overwriteApiConversationHistory } = buildAccess()
		const result = await new TaskContextManager(access).manageContextIfNeeded(params)

		// The destructive rewrite is persisted...
		expect(overwriteApiConversationHistory).toHaveBeenCalledWith(prunedHistory)

		// ...and it is not silent.
		const pruneRow = say.mock.calls.find((call) => call[0] === "context_pruned")
		expect(pruneRow).toBeDefined()
		expect(pruneRow![9]).toEqual({
			prunedCount: 3,
			bytesSaved: 250_000,
			prevContextTokens: 71_010,
			newContextTokens: 66_000,
		})
		// Non-interactive: it must never consume a pending ask.
		expect(pruneRow![6]).toEqual({ isNonInteractive: true })

		// The same numbers are handed back to the caller.
		expect(result?.prunedCount).toBe(3)
		expect(result?.prunedBytesSaved).toBe(250_000)
		expect(result?.summarySkipped).toBe(true)
	})

	it("says nothing when the round condensed: the condense row already covers it", async () => {
		manageContextMock.mockResolvedValue({
			messages: prunedHistory,
			summary: "a summary",
			cost: 0.01,
			prevContextTokens: 71_010,
			newContextTokens: 20_000,
			prunedCount: 2,
			prunedBytesSaved: 100_000,
			summarySkipped: false,
		})

		const { access, say } = buildAccess()
		await new TaskContextManager(access).manageContextIfNeeded(params)

		expect(say.mock.calls.some((call) => call[0] === "condense_context")).toBe(true)
		expect(say.mock.calls.some((call) => call[0] === "context_pruned")).toBe(false)
	})

	it("says nothing when nothing was pruned", async () => {
		manageContextMock.mockResolvedValue({
			messages: prunedHistory,
			summary: "",
			cost: 0,
			prevContextTokens: 71_010,
			newContextTokens: 71_010,
		})

		const { access, say } = buildAccess()
		await new TaskContextManager(access).manageContextIfNeeded(params)

		expect(say.mock.calls.some((call) => call[0] === "context_pruned")).toBe(false)
	})
})
