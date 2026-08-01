import * as fs from "node:fs"
import * as path from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { createInterchangeServer } from "../mcp/server.js"
import { makeTempDir, writeClaudeSession, writeTumbleTask } from "./fixtures.js"

/**
 * The server is exercised through a real MCP client over an in-memory
 * transport, so the schemas, the tool names and the shape of every response are
 * checked the way a client will actually see them.
 */

let workspaceDir: string

async function connect(defaultCwd = workspaceDir, allowCrossWorkspace = false) {
	const server = createInterchangeServer(defaultCwd, { allowCrossWorkspace })
	const client = new Client({ name: "test", version: "0.0.0" })
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

	return { client, close: async () => Promise.all([client.close(), server.close()]) }
}

function textOf(result: unknown): string {
	const content = (result as { content: Array<{ type: string; text?: string }> }).content
	return content.map((entry) => entry.text ?? "").join("\n")
}

describe("agent-interchange MCP server", () => {
	let claudeDir: string
	let tumbleDir: string
	let handoffRoot: string

	beforeEach(() => {
		claudeDir = makeTempDir("mcp-cc")
		tumbleDir = makeTempDir("mcp-tc")
		handoffRoot = makeTempDir("mcp-handoff")
		workspaceDir = makeTempDir("mcp-workspace")

		process.env.CLAUDE_CONFIG_DIR = claudeDir
		process.env.AGENT_INTERCHANGE_TUMBLE_STORAGE = tumbleDir
		process.env.AGENT_INTERCHANGE_DIR = handoffRoot

		writeClaudeSession(claudeDir, { id: "cc-1", cwd: workspaceDir, aiTitle: "Retry determinism" })
		writeTumbleTask(tumbleDir, { id: "tc-1", workspace: workspaceDir, task: "Port the checker", mode: "code" })
		fs.mkdirSync(path.join(claudeDir, "plans"), { recursive: true })
		fs.writeFileSync(path.join(claudeDir, "plans", "private-global.md"), "# Private global plan\nsecret\n")
		fs.mkdirSync(path.join(workspaceDir, "ai_plans"), { recursive: true })
		fs.writeFileSync(path.join(workspaceDir, "ai_plans", "workspace.md"), "# Workspace plan\nvisible\n")
	})

	afterEach(() => {
		delete process.env.CLAUDE_CONFIG_DIR
		delete process.env.AGENT_INTERCHANGE_TUMBLE_STORAGE
		delete process.env.AGENT_INTERCHANGE_DIR

		for (const dir of [claudeDir, tumbleDir, handoffRoot, workspaceDir]) {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it("advertises the interchange tools", async () => {
		const { client, close } = await connect()

		const { tools } = await client.listTools()

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"create_handoff",
			"list_agent_plans",
			"list_agent_sessions",
			"list_handoffs",
			"read_agent_plan",
			"read_agent_session",
			"read_handoff",
			"search_agent_sessions",
			"update_handoff",
		])

		await close()
	})

	it("lists both agents' sessions for the workspace it was started in", async () => {
		const { client, close } = await connect()

		const output = textOf(await client.callTool({ name: "list_agent_sessions", arguments: {} }))

		expect(output).toContain("Retry determinism")
		expect(output).toContain("Port the checker")
		expect(output).toContain("Claude Code")
		expect(output).toContain("Tumble Code")

		await close()
	})

	it.runIf(process.platform !== "win32")("pins a symlinked startup workspace to its canonical identity", async () => {
		const alias = `${workspaceDir}-alias`
		fs.symlinkSync(workspaceDir, alias, "dir")
		try {
			const { client, close } = await connect(alias)
			const output = textOf(await client.callTool({ name: "list_agent_sessions", arguments: {} }))

			expect(output).toContain("Retry determinism")
			expect(output).toContain("Port the checker")
			await close()
		} finally {
			fs.rmSync(alias, { force: true })
		}
	})

	it.runIf(process.platform !== "win32")(
		"lists the sessions it will let you read, even when they recorded a symlinked path",
		async () => {
			// VS Code keeps whatever path the folder was opened by, so a workspace
			// reached through a symlink is recorded as the alias. Hiding it from the
			// listing while allowing the read by id leaves work an agent can only
			// find by guessing.
			const alias = `${workspaceDir}-alias`
			fs.symlinkSync(workspaceDir, alias, "dir")
			writeTumbleTask(tumbleDir, { id: "tc-alias", workspace: alias, task: "Aliased workspace session" })

			try {
				const { client, close } = await connect(workspaceDir)

				const listed = textOf(await client.callTool({ name: "list_agent_sessions", arguments: {} }))
				const read = textOf(
					await client.callTool({ name: "read_agent_session", arguments: { session_id: "tc-alias" } }),
				)

				expect(listed).toContain("Aliased workspace session")
				expect(read).not.toContain("No session with id")
				await close()
			} finally {
				fs.rmSync(alias, { force: true })
			}
		},
	)

	it.runIf(process.platform !== "win32")(
		"does not follow a retargeted startup path after server creation",
		async () => {
			const alias = `${workspaceDir}-retarget`
			const foreign = makeTempDir("mcp-retarget-foreign")
			fs.mkdirSync(path.join(foreign, "ai_plans"), { recursive: true })
			fs.writeFileSync(path.join(foreign, "ai_plans", "foreign.md"), "# Foreign secret\nnot visible\n")
			fs.symlinkSync(workspaceDir, alias, "dir")
			try {
				const { client, close } = await connect(alias)
				fs.unlinkSync(alias)
				fs.symlinkSync(foreign, alias, "dir")

				const sessions = textOf(await client.callTool({ name: "list_agent_sessions", arguments: {} }))
				const plans = textOf(await client.callTool({ name: "list_agent_plans", arguments: {} }))
				expect(sessions).toContain("Retry determinism")
				expect(plans).toContain("Workspace plan")
				expect(plans).not.toContain("Foreign secret")
				await close()
			} finally {
				fs.rmSync(alias, { force: true })
				fs.rmSync(foreign, { recursive: true, force: true })
			}
		},
	)

	it("filters to one agent and rejects an empty workspace by default", async () => {
		writeClaudeSession(claudeDir, { id: "cc-2", cwd: "/tmp/elsewhere", aiTitle: "Different project" })

		const { client, close } = await connect()

		const onlyClaude = textOf(
			await client.callTool({ name: "list_agent_sessions", arguments: { agent: "claude-code" } }),
		)
		expect(onlyClaude).toContain("Retry determinism")
		expect(onlyClaude).not.toContain("Port the checker")
		expect(onlyClaude).not.toContain("Different project")

		const everywhere = await client.callTool({ name: "list_agent_sessions", arguments: { workspace: "" } })
		expect(everywhere.isError).toBe(true)
		expect(textOf(everywhere)).toContain("workspace must not be empty")

		await close()
	})

	it("only permits cross-workspace listing after a server startup opt-in", async () => {
		writeClaudeSession(claudeDir, { id: "cc-2", cwd: "/tmp/elsewhere", aiTitle: "Different project" })
		const { client, close } = await connect(workspaceDir, true)

		const everywhere = textOf(await client.callTool({ name: "list_agent_sessions", arguments: { workspace: "" } }))
		expect(everywhere).toContain("Different project")

		await close()
	})

	it("does not read or hand off a known session from another workspace", async () => {
		writeClaudeSession(claudeDir, { id: "foreign", cwd: "/tmp/elsewhere", aiTitle: "Private project" })
		const { client, close } = await connect()

		expect(
			textOf(await client.callTool({ name: "read_agent_session", arguments: { session_id: "foreign" } })),
		).toContain("No session with id")
		expect(
			textOf(
				await client.callTool({
					name: "create_handoff",
					arguments: { session_id: "foreign", to: "tumble-code" },
				}),
			),
		).toContain("No session with id")

		await close()
	})

	it("returns a briefing by default and a paginated transcript on request", async () => {
		const { client, close } = await connect()

		const briefing = textOf(
			await client.callTool({ name: "read_agent_session", arguments: { session_id: "cc-1" } }),
		)
		expect(briefing).toContain("# Retry determinism")
		expect(briefing).toContain("## The request")
		expect(briefing).toContain("Files changed (1)")

		const transcript = textOf(
			await client.callTool({
				name: "read_agent_session",
				arguments: { session_id: "cc-1", format: "transcript", offset: 0, limit: 1 },
			}),
		)
		expect(transcript).toContain("Messages 1–1 of 3")
		expect(transcript).toContain("offset: 1")

		await close()
	})

	it("says so plainly when an id does not exist", async () => {
		const { client, close } = await connect()

		expect(
			textOf(await client.callTool({ name: "read_agent_session", arguments: { session_id: "nope" } })),
		).toContain("No session with id")

		await close()
	})

	it("carries a task across the handoff lifecycle", async () => {
		const { client, close } = await connect()

		const created = textOf(
			await client.callTool({
				name: "create_handoff",
				arguments: {
					session_id: "tc-1",
					to: "claude-code",
					next_steps: ["Run the integration suite"],
					notes: "The staging box has an old bash.",
				},
			}),
		)
		expect(created).toContain("created for claude-code")

		const listed = textOf(await client.callTool({ name: "list_handoffs", arguments: {} }))
		expect(listed).toContain("tumble-code → claude-code")
		expect(listed).toContain("open")

		const id = /`([^`]+)`/.exec(listed)![1]!

		const read = textOf(await client.callTool({ name: "read_handoff", arguments: { handoff_id: id } }))
		expect(read).toContain("- [ ] Run the integration suite")
		expect(read).toContain("The staging box has an old bash.")
		expect(read).toContain("## The request")

		const updated = textOf(
			await client.callTool({
				name: "update_handoff",
				arguments: { handoff_id: id, status: "picked-up", picked_up_by: "claude-code", note: "starting now" },
			}),
		)
		expect(updated).toContain("is now picked-up")

		expect(textOf(await client.callTool({ name: "list_handoffs", arguments: { status: "open" } }))).toBe(
			"No handoffs.",
		)

		await close()
	})

	it("does not read or update a known handoff from another workspace", async () => {
		writeTumbleTask(tumbleDir, {
			id: "foreign-task",
			workspace: "/tmp/elsewhere",
			task: "Private handoff",
			mode: "code",
		})
		const privileged = await connect(workspaceDir, true)
		const created = textOf(
			await privileged.client.callTool({
				name: "create_handoff",
				arguments: { session_id: "foreign-task", workspace: "/tmp/elsewhere", to: "claude-code" },
			}),
		)
		const id = /Handoff `([^`]+)`/.exec(created)![1]!
		await privileged.close()

		const { client, close } = await connect()

		expect(textOf(await client.callTool({ name: "read_handoff", arguments: { handoff_id: id } }))).toContain(
			"No handoff with id",
		)
		expect(
			textOf(await client.callTool({ name: "update_handoff", arguments: { handoff_id: id, status: "done" } })),
		).toContain("No handoff with id")

		await close()
	})

	it("finds a session by text in its conversation", async () => {
		const { client, close } = await connect()

		const output = textOf(await client.callTool({ name: "search_agent_sessions", arguments: { query: "flaky" } }))

		expect(output).toContain("Retry determinism")

		await close()
	})

	it("refuses to read a file that is not a plan document", async () => {
		const { client, close } = await connect()

		const output = textOf(await client.callTool({ name: "read_agent_plan", arguments: { path: "/etc/passwd" } }))

		expect(output).toContain("not a plan document")

		await close()
	})

	// Workspace-isolated plan access is the same feature on every platform: the
	// containment check differs, what the tools serve does not.
	it("lists only workspace-contained plans in ordinary workspace-isolated mode", async () => {
		const { client, close } = await connect(workspaceDir)

		const output = textOf(await client.callTool({ name: "list_agent_plans", arguments: {} }))

		expect(output).toContain("Workspace plan")
		expect(output).not.toContain("Private global plan")
		expect(output).not.toContain(path.join(claudeDir, "plans"))

		await close()
	})

	it("reads a workspace-contained plan in ordinary workspace-isolated mode", async () => {
		const { client, close } = await connect(workspaceDir)
		const plan = path.join(workspaceDir, "ai_plans", "workspace.md")

		expect(textOf(await client.callTool({ name: "read_agent_plan", arguments: { path: plan } }))).toContain(
			"Workspace plan",
		)

		await close()
	})

	it("rejects direct known-path and known-name attempts for Claude-global plans by default", async () => {
		const { client, close } = await connect(workspaceDir)
		const privatePlan = path.join(claudeDir, "plans", "private-global.md")

		for (const attemptedPath of [privatePlan, "private-global.md"]) {
			const output = textOf(
				await client.callTool({ name: "read_agent_plan", arguments: { path: attemptedPath } }),
			)
			expect(output).toContain("not a plan document this tool may read")
			expect(output).not.toContain("secret")
		}

		await close()
	})

	it("lists and directly reads Claude-global plans only after startup opt-in", async () => {
		const { client, close } = await connect(workspaceDir, true)
		const privatePlan = path.join(claudeDir, "plans", "private-global.md")

		expect(textOf(await client.callTool({ name: "list_agent_plans", arguments: {} }))).toContain(
			"Private global plan",
		)
		expect(textOf(await client.callTool({ name: "read_agent_plan", arguments: { path: privatePlan } }))).toContain(
			"secret",
		)

		await close()
	})
})
