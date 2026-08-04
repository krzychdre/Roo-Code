import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { listHandoffs, readHandoff } from "@roo-code/agent-interchange"

const showQuickPick = vi.fn()
const showInputBox = vi.fn()
const showInformationMessage = vi.fn()
const showWarningMessage = vi.fn()
const createTask = vi.fn(async (_text?: string) => ({ taskId: "new-task-1" }))
const getCurrentTask = vi.fn()

vi.mock("vscode", () => ({
	window: {
		showQuickPick: (...args: unknown[]) => showQuickPick(...args),
		showInputBox: (...args: unknown[]) => showInputBox(...args),
		showInformationMessage: (...args: unknown[]) => showInformationMessage(...args),
		showWarningMessage: (...args: unknown[]) => showWarningMessage(...args),
		showTextDocument: vi.fn(),
		withProgress: (_options: unknown, task: () => Promise<unknown>) => task(),
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/tmp/interchange-ws" } }],
		openTextDocument: vi.fn(),
	},
	ProgressLocation: { Notification: 15 },
	Uri: { file: (fsPath: string) => ({ fsPath }) },
}))

vi.mock("../../webview/ClineProvider", () => ({
	ClineProvider: {
		getInstance: async () => ({ createTask, getCurrentTask }),
	},
}))

vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

let storageDir: string
let handoffDir: string
let claudeDir: string

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: async () => storageDir,
}))

const WORKSPACE = "/tmp/interchange-ws"

/** A Claude Code session, laid out the way the real tool does. */
function writeClaudeSession(id: string, title: string): void {
	const dir = path.join(claudeDir, "projects", WORKSPACE.replace(/[^a-zA-Z0-9]/g, "-"))
	fs.mkdirSync(dir, { recursive: true })

	const base = { cwd: WORKSPACE, gitBranch: "main", sessionId: id, isSidechain: false }

	const records = [
		{
			...base,
			type: "user",
			uuid: "u1",
			timestamp: "2026-07-31T10:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "Make the checker strict" }] },
		},
		{
			...base,
			type: "assistant",
			uuid: "a1",
			timestamp: "2026-07-31T10:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "check.sh" } }],
			},
		},
		{ type: "ai-title", sessionId: id, aiTitle: title },
	]

	fs.writeFileSync(
		path.join(dir, `${id}.jsonl`),
		records.map((record) => JSON.stringify(record)).join("\n") + "\n",
		"utf8",
	)
}

/** A Tumble Code task directory, as the extension writes it. */
function writeTumbleTask(id: string, task: string): void {
	const dir = path.join(storageDir, "tasks", id)
	fs.mkdirSync(dir, { recursive: true })

	fs.writeFileSync(
		path.join(dir, "api_conversation_history.json"),
		JSON.stringify([
			{ role: "user", ts: 1, content: [{ type: "text", text: `<task>\n${task}\n</task>` }] },
			{
				role: "assistant",
				ts: 2,
				content: [{ type: "tool_use", id: "c1", name: "write_to_file", input: { path: "check.sh" } }],
			},
		]),
		"utf8",
	)

	fs.writeFileSync(
		path.join(dir, "history_item.json"),
		JSON.stringify({ id, number: 1, ts: 2, task, tokensIn: 1, tokensOut: 1, totalCost: 0, workspace: WORKSPACE }),
		"utf8",
	)
}

describe("agent interchange commands", () => {
	const context = { globalStorageUri: { fsPath: "" } } as never

	beforeEach(() => {
		storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cmd-store-"))
		handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cmd-handoff-"))
		claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cmd-claude-"))

		process.env.AGENT_INTERCHANGE_DIR = handoffDir
		process.env.CLAUDE_CONFIG_DIR = claudeDir
		process.env.AGENT_INTERCHANGE_TUMBLE_STORAGE = storageDir

		vi.clearAllMocks()
		createTask.mockResolvedValue({ taskId: "new-task-1" })
	})

	afterEach(() => {
		delete process.env.AGENT_INTERCHANGE_DIR
		delete process.env.CLAUDE_CONFIG_DIR
		delete process.env.AGENT_INTERCHANGE_TUMBLE_STORAGE

		for (const dir of [storageDir, handoffDir, claudeDir]) {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it("offers the Claude Code sessions recorded for this workspace", async () => {
		writeClaudeSession("cc-1", "Strict checker")
		const { pickUpAgentSession } = await import("../index")

		await pickUpAgentSession(context)

		const [items] = showQuickPick.mock.calls[0]!
		expect(items).toHaveLength(1)
		expect(items[0].label).toContain("Strict checker")
		expect(items[0].source).toBe("session")
	})

	it("seeds a new task with the briefing and a caution not to trust it blindly", async () => {
		writeClaudeSession("cc-1", "Strict checker")
		showQuickPick.mockImplementation(async (items: Array<{ source: string }>) => items[0])

		const { pickUpAgentSession } = await import("../index")
		await pickUpAgentSession(context)

		expect(createTask).toHaveBeenCalledTimes(1)
		const prompt = createTask.mock.calls[0]![0]!
		expect(prompt).toContain("taking over work started in Claude Code")
		expect(prompt).toContain("verify the current state of the files")
		expect(prompt).toContain("# Strict checker")
		expect(prompt).toContain("check.sh")
	})

	it("marks a picked-up handoff and records the task that continues it", async () => {
		writeTumbleTask("tc-1", "Port the checker")

		const { createHandoff, readTumbleSession } = await import("@roo-code/agent-interchange")
		const session = await readTumbleSession("tc-1", { storageRoots: [storageDir] })
		const handoff = await createHandoff({ session: session!, to: "tumble-code", nextSteps: ["Run the suite"] })

		showQuickPick.mockImplementation(async (items: Array<{ source: string }>) =>
			items.find((item) => item.source === "handoff"),
		)

		const { pickUpAgentSession } = await import("../index")
		await pickUpAgentSession(context)

		const prompt = createTask.mock.calls[0]![0]!
		expect(prompt).toContain("handed this task over to you")
		expect(prompt).toContain("- [ ] Run the suite")

		const updated = readHandoff(handoff.id)!
		expect(updated.status).toBe("picked-up")
		expect(updated.pickedUpBy).toBe("tumble-code")
		expect(updated.pickedUpSessionId).toBe("new-task-1")
	})

	it("says there is nothing to pick up rather than opening an empty list", async () => {
		const { pickUpAgentSession } = await import("../index")

		await pickUpAgentSession(context)

		expect(showQuickPick).not.toHaveBeenCalled()
		expect(createTask).not.toHaveBeenCalled()
		expect(showInformationMessage).toHaveBeenCalledWith("common:agentInterchange.nothing_to_pick_up")
	})

	it("refuses to hand off when no task is running", async () => {
		getCurrentTask.mockReturnValue(undefined)

		const { handOffCurrentTask } = await import("../index")
		await handOffCurrentTask(context)

		expect(showWarningMessage).toHaveBeenCalledWith("common:agentInterchange.no_current_task")
		expect(listHandoffs()).toEqual([])
	})

	it("writes a handoff for the running task, one next step per semicolon", async () => {
		writeTumbleTask("tc-1", "Port the checker")
		getCurrentTask.mockReturnValue({ taskId: "tc-1" })
		showInputBox.mockResolvedValue("Run the suite; Open the PR")

		const { handOffCurrentTask } = await import("../index")
		await handOffCurrentTask(context)

		const [handoff] = listHandoffs()
		expect(handoff).toMatchObject({ from: "tumble-code", to: "claude-code", sourceSessionId: "tc-1" })
		expect(handoff!.body).toContain("- [ ] Run the suite")
		expect(handoff!.body).toContain("- [ ] Open the PR")
		expect(handoff!.body).toContain("Port the checker")
	})

	it("abandons the handoff when the prompt is dismissed", async () => {
		writeTumbleTask("tc-1", "Port the checker")
		getCurrentTask.mockReturnValue({ taskId: "tc-1" })
		showInputBox.mockResolvedValue(undefined)

		const { handOffCurrentTask } = await import("../index")
		await handOffCurrentTask(context)

		expect(listHandoffs()).toEqual([])
	})
})
