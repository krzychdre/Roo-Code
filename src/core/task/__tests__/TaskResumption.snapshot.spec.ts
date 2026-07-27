// cd src && npx vitest run core/task/__tests__/TaskResumption.snapshot.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { ClineMessage } from "@roo-code/types"
import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiMessage } from "../../task-persistence"
import { getEffectiveApiHistory } from "../../condense"
import { TaskResumption, type TaskResumptionAccess } from "../TaskResumption"

const FILLER = "y".repeat(6_000)

const CHANGED_FILE = "src/api/providers/openrouter.ts"

/** A long interrupted task: one landed edit, one open failure, and a lot of bulk. */
function interruptedHistory(): ApiMessage[] {
	let ts = 1_000
	const messages: ApiMessage[] = []
	const push = (message: Omit<ApiMessage, "ts">) => {
		messages.push({ ...message, ts: ts++ } as ApiMessage)
	}

	push({
		role: "user",
		content: [{ type: "text", text: "<task>Add exponential backoff to the openrouter provider</task>" }],
	})
	push({
		role: "assistant",
		content: [{ type: "tool_use", id: "use-edit", name: "write_to_file", input: { path: CHANGED_FILE } }],
	})
	push({
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "use-edit", content: "The content was successfully saved." }],
	})
	push({
		role: "assistant",
		content: [{ type: "tool_use", id: "use-test", name: "execute_command", input: { command: "pnpm test" } }],
	})
	push({
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: "use-test", content: "Error: 3 assertions failed in backoff.spec.ts" },
		],
	})

	for (let i = 0; i < 12; i++) {
		push({
			role: "assistant",
			content: [{ type: "tool_use", id: `use-read-${i}`, name: "read_file", input: { path: `src/p${i}.ts` } }],
		})
		push({ role: "user", content: [{ type: "tool_result", tool_use_id: `use-read-${i}`, content: FILLER }] })
	}

	return messages
}

interface Harness {
	access: TaskResumptionAccess
	resumption: TaskResumption
	/** What was persisted as the API history by the resume. */
	persisted: () => ApiMessage[]
	/** What was sent as the first request's user content. */
	userContent: () => Anthropic.Messages.ContentBlockParam[]
}

function harness(apiHistory: ApiMessage[], cwd: string, lastActivityTs: number): Harness {
	const clineMessages: ClineMessage[] = [
		{ ts: lastActivityTs, type: "say", say: "text", text: "working" } as ClineMessage,
	]

	let persisted = apiHistory
	let userContent: Anthropic.Messages.ContentBlockParam[] = []

	const access = {
		taskId: "task-1",
		instanceId: "1",
		cwd,
		isInitialized: false,
		abort: false,
		abandoned: false,
		clineMessages,
		apiConversationHistory: apiHistory,
		providerRef: new WeakRef({}),
		history: {
			getSavedClineMessages: async () => clineMessages,
			overwriteClineMessages: async () => {},
			getSavedApiConversationHistory: async () => persisted,
			overwriteApiConversationHistory: async (messages: ApiMessage[]) => {
				persisted = messages
			},
		},
		askSay: {
			ask: async () => ({ response: "yesButtonClicked" }),
			say: async () => {},
		},
		emit: () => true,
		initiateTaskLoop: async (content: Anthropic.Messages.ContentBlockParam[]) => {
			userContent = content
		},
	} as unknown as TaskResumptionAccess

	return {
		access,
		resumption: new TaskResumption(access),
		persisted: () => persisted,
		userContent: () => userContent,
	}
}

function firstEffectiveText(messages: ApiMessage[]): string {
	const first = getEffectiveApiHistory(messages)[0]
	return typeof first.content === "string" ? first.content : JSON.stringify(first.content)
}

describe("TaskResumption execution snapshot", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "resume-snapshot-"))
	})

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
	})

	it("resumes from a snapshot instead of replaying the whole conversation", async () => {
		const messages = interruptedHistory()
		// The file we changed is still exactly as the task left it.
		await fs.mkdir(path.join(workspace, path.dirname(CHANGED_FILE)), { recursive: true })
		await fs.writeFile(path.join(workspace, CHANGED_FILE), "export const x = 1\n")
		const lastActivity = Date.now() + 60_000

		const h = harness(messages, workspace, lastActivity)
		await h.resumption.resumeTaskFromHistory()

		const effective = getEffectiveApiHistory(h.persisted())
		expect(effective.length).toBeLessThan(messages.length)

		const snapshot = firstEffectiveText(h.persisted())
		expect(snapshot).toContain("Execution Snapshot")
		expect(snapshot).toContain("Add exponential backoff to the openrouter provider")
		expect(snapshot).toContain(CHANGED_FILE)
		expect(snapshot).toContain("pnpm test")
		// Untouched on disk, so no warning to spend tokens on.
		expect(snapshot).not.toContain("Changed outside this task")

		// Nothing was deleted: the raw turns are still persisted for rewind and the transcript.
		expect(h.persisted().length).toBeGreaterThanOrEqual(messages.length)
		// The resume still starts a request.
		expect(h.userContent().length).toBeGreaterThan(0)
	})

	it("warns about a file that was edited while the task was paused", async () => {
		const messages = interruptedHistory()
		await fs.mkdir(path.join(workspace, path.dirname(CHANGED_FILE)), { recursive: true })
		await fs.writeFile(path.join(workspace, CHANGED_FILE), "edited by hand\n")
		// The task last acted well before that write.
		const lastActivity = Date.now() - 600_000

		const h = harness(messages, workspace, lastActivity)
		await h.resumption.resumeTaskFromHistory()

		const snapshot = firstEffectiveText(h.persisted())
		expect(snapshot).toContain("Changed outside this task while it was paused")
		expect(snapshot).toContain(`- ${CHANGED_FILE} (modified)`)
	})

	it("leaves a short task's history exactly as it was", async () => {
		const messages: ApiMessage[] = [
			{ role: "user", ts: 1, content: [{ type: "text", text: "<task>rename a variable</task>" }] },
			{ role: "assistant", ts: 2, content: [{ type: "text", text: "Renamed it." }] },
		]

		const h = harness(messages, workspace, Date.now())
		await h.resumption.resumeTaskFromHistory()

		expect(h.persisted().some((message) => message.isSummary)).toBe(false)
		expect(h.persisted()).toHaveLength(messages.length)
	})

	it("still resumes when the staleness check itself fails", async () => {
		const messages = interruptedHistory()
		// A missing cwd makes path resolution throw inside the staleness check. That must cost the
		// warning section, not the resume.
		const h = harness(messages, undefined as unknown as string, Date.now())

		await expect(h.resumption.resumeTaskFromHistory()).resolves.toBeUndefined()

		const snapshot = firstEffectiveText(h.persisted())
		expect(snapshot).toContain("Execution Snapshot")
		expect(snapshot).not.toContain("Changed outside this task")
		expect(h.userContent().length).toBeGreaterThan(0)
	})

	it("falls back to the full replay when the snapshot throws", async () => {
		// The safety property this whole feature rests on: a resume must never fail because the
		// snapshot did. The worst outcome allowed is today's behaviour.
		vi.resetModules()
		vi.doMock("../../context-management/executionSnapshot", async (importOriginal) => ({
			...(await importOriginal<typeof import("../../context-management/executionSnapshot")>()),
			applyExecutionSnapshot: () => {
				throw new Error("snapshot exploded")
			},
		}))

		try {
			const { TaskResumption: FreshTaskResumption } = await import("../TaskResumption")
			const messages = interruptedHistory()
			const h = harness(messages, workspace, Date.now())

			await new FreshTaskResumption(h.access).resumeTaskFromHistory()

			// Not rewritten at all: no snapshot inserted, no message hidden behind one. (The count
			// is not compared to the input because the replay path legitimately drops the trailing
			// turn of an interrupted history before the snapshot is ever considered.)
			expect(h.persisted().some((message) => message.isSummary || message.condenseParent)).toBe(false)
			expect(h.userContent().length).toBeGreaterThan(0)
		} finally {
			vi.doUnmock("../../context-management/executionSnapshot")
			vi.resetModules()
		}
	})
})
