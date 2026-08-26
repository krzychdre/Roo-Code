import * as fs from "node:fs"

import { claudeSlug } from "../locate.js"
import { listClaudeSessions, readClaudeSession } from "../readers/claude-code.js"
import { listTumbleSessions, readTumbleSession } from "../readers/tumble-code.js"
import { listSessions, readSession } from "../index.js"
import { makeTempDir, writeClaudeSession, writeTumbleTask } from "./fixtures.js"

describe("claudeSlug", () => {
	// The empirical table from the real store — the mapping is lossy, and these
	// three cases are what proves which characters collapse.
	it.each([
		["/home/krzych/Projekty/QUB-IT/Roo-Code", "-home-krzych-Projekty-QUB-IT-Roo-Code"],
		["/home/krzych/Downloads/vpn_jurasz", "-home-krzych-Downloads-vpn-jurasz"],
		["/home/krzych/Projekty/ITKONTEKST/jurasz.ai", "-home-krzych-Projekty-ITKONTEKST-jurasz-ai"],
		["/home/krzych/Projekty/QUB-IT/k3s_2025_05_19/fluxcd", "-home-krzych-Projekty-QUB-IT-k3s-2025-05-19-fluxcd"],
	])("maps %s", (cwd, expected) => {
		expect(claudeSlug(cwd)).toBe(expected)
	})

	it("collapses distinct workspaces onto one name", () => {
		expect(claudeSlug("/a/k3s_2025")).toBe(claudeSlug("/a/k3s-2025"))
	})
})

describe("Claude Code reader", () => {
	let configDir: string

	beforeEach(() => {
		configDir = makeTempDir("cc")
		process.env.CLAUDE_CONFIG_DIR = configDir
	})

	afterEach(() => {
		delete process.env.CLAUDE_CONFIG_DIR
		// On Windows, external scanners (antivirus, indexer) may briefly hold
		// handles on freshly written files; maxRetries lets rmSync retry
		// through ENOTEMPTY / EBUSY / EPERM instead of failing the hook.
		fs.rmSync(configDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
	})

	it("summarizes a session without reading it whole", () => {
		writeClaudeSession(configDir, { id: "s1", cwd: "/tmp/proj", aiTitle: "Flaky test hunt" })

		const [summary] = listClaudeSessions({ cwd: "/tmp/proj" })

		expect(summary).toMatchObject({
			agent: "claude-code",
			id: "s1",
			title: "Flaky test hunt",
			cwd: "/tmp/proj",
			gitBranch: "main",
		})
		expect(summary!.updatedAt).toBeGreaterThan(0)
		// A listing must not have paid to count messages.
		expect(summary!.messageCount).toBeUndefined()
	})

	it("falls back to the opening prompt when no title was generated", () => {
		writeClaudeSession(configDir, { id: "s2", cwd: "/tmp/proj" })

		expect(listClaudeSessions({ cwd: "/tmp/proj" })[0]!.title).toBe("Fix the flaky test")
	})

	it("keeps subagent turns out of the main thread", async () => {
		writeClaudeSession(configDir, { id: "s3", cwd: "/tmp/proj" })

		const session = await readClaudeSession("s3")

		expect(session!.messages).toHaveLength(3)
		expect(session!.sidechainMessages).toHaveLength(1)
		expect(session!.messages.some((message) => message.isSidechain)).toBe(false)
	})

	it("includes subagent turns on request", async () => {
		writeClaudeSession(configDir, { id: "s4", cwd: "/tmp/proj" })

		const session = await readClaudeSession("s4", { includeSidechains: true })

		expect(session!.messages).toHaveLength(4)
	})

	it("survives the partial line of a session being written right now", async () => {
		writeClaudeSession(configDir, { id: "s5", cwd: "/tmp/proj", truncatedTail: true })

		const session = await readClaudeSession("s5")

		expect(session!.messages).toHaveLength(3)
		expect(listClaudeSessions({ cwd: "/tmp/proj" })).toHaveLength(1)
	})

	it("normalizes blocks into the canonical shape", async () => {
		writeClaudeSession(configDir, { id: "s6", cwd: "/tmp/proj" })

		const session = await readClaudeSession("s6")
		const assistant = session!.messages[1]!

		expect(assistant.blocks).toEqual([
			{ type: "thinking", text: "considering the retry" },
			{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/app.ts" } },
		])
		expect(session!.messages[2]!.blocks[0]).toEqual({
			type: "tool_result",
			toolUseId: "t1",
			text: "done",
			isError: false,
		})
	})

	it("ignores a workspace it has no sessions for", () => {
		writeClaudeSession(configDir, { id: "s7", cwd: "/tmp/proj" })

		expect(listClaudeSessions({ cwd: "/tmp/other" })).toEqual([])
	})

	it("rejects an id that is not a plain file name", async () => {
		writeClaudeSession(configDir, { id: "s8", cwd: "/tmp/proj" })

		await expect(readClaudeSession("../../etc/passwd")).resolves.toBeUndefined()
	})
})

describe("Tumble Code reader", () => {
	let storageDir: string

	beforeEach(() => {
		storageDir = makeTempDir("tc")
		process.env.AGENT_INTERCHANGE_TUMBLE_STORAGE = storageDir
	})

	afterEach(() => {
		delete process.env.AGENT_INTERCHANGE_TUMBLE_STORAGE
		// Retries for the same Windows handle races as in the Claude block above.
		fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
	})

	it("summarizes from history_item.json", () => {
		writeTumbleTask(storageDir, { id: "t1", workspace: "/tmp/proj", task: "Add a feature", mode: "code" })

		expect(listTumbleSessions({ cwd: "/tmp/proj" })[0]).toMatchObject({
			agent: "tumble-code",
			id: "t1",
			title: "Add a feature",
			mode: "code",
			apiConfigName: "GLM-5.2",
			status: "completed",
			tokensIn: 100,
		})
	})

	it("summarizes a task that predates history_item.json", () => {
		writeTumbleTask(storageDir, { id: "t2", withoutHistoryItem: true, task: "Old task" })

		const summary = listTumbleSessions().find((entry) => entry.id === "t2")

		expect(summary).toMatchObject({ id: "t2", title: "Old task" })
		// No workspace was recorded back then, so it cannot be filtered by cwd.
		expect(summary!.cwd).toBeUndefined()
	})

	it("reads the conversation, including string content", async () => {
		writeTumbleTask(storageDir, {
			id: "t3",
			apiMessages: [
				{ role: "user", ts: 1, content: "plain string content" },
				{ role: "assistant", ts: 2, content: [{ type: "text", text: "reply" }] },
			],
		})

		const session = await readTumbleSession("t3")

		expect(session!.messages[0]!.blocks).toEqual([{ type: "text", text: "plain string content" }])
		expect(session!.messageCount).toBe(2)
	})

	it("maps reasoning blocks onto thinking", async () => {
		writeTumbleTask(storageDir, { id: "t4" })

		const session = await readTumbleSession("t4")

		expect(session!.messages[1]!.blocks[0]).toEqual({ type: "thinking", text: "planning" })
	})
})

describe("unified facade", () => {
	let configDir: string
	let storageDir: string

	beforeEach(() => {
		configDir = makeTempDir("cc")
		storageDir = makeTempDir("tc")
		process.env.CLAUDE_CONFIG_DIR = configDir
		process.env.AGENT_INTERCHANGE_TUMBLE_STORAGE = storageDir
	})

	afterEach(() => {
		delete process.env.CLAUDE_CONFIG_DIR
		delete process.env.AGENT_INTERCHANGE_TUMBLE_STORAGE
		// Retries for the same Windows handle races as in the Claude block above.
		fs.rmSync(configDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
		fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
	})

	it("lists both stores newest first", () => {
		writeClaudeSession(configDir, { id: "s1", cwd: "/tmp/proj", aiTitle: "From Claude" })
		writeTumbleTask(storageDir, {
			id: "t1",
			workspace: "/tmp/proj",
			task: "From Tumble",
			ts: Date.parse("2026-07-31T23:00:00.000Z"),
		})

		const summaries = listSessions({ cwd: "/tmp/proj" })

		expect(summaries.map((summary) => summary.agent)).toEqual(["tumble-code", "claude-code"])
	})

	it("finds a session in whichever store holds it", async () => {
		writeClaudeSession(configDir, { id: "s1", cwd: "/tmp/proj" })
		writeTumbleTask(storageDir, { id: "t1", workspace: "/tmp/proj" })

		expect((await readSession("s1"))!.agent).toBe("claude-code")
		expect((await readSession("t1"))!.agent).toBe("tumble-code")
		expect(await readSession("nope")).toBeUndefined()
	})
})
