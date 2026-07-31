import * as fs from "node:fs"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { createInterchangeServer } from "../mcp/server.js"
import { makeTempDir, writeClaudeSession, writeTumbleTask } from "./fixtures.js"

/**
 * The server is exercised through a real MCP client over an in-memory
 * transport, so the schemas, the tool names and the shape of every response are
 * checked the way a client will actually see them.
 */

const WORKSPACE = "/tmp/interchange-workspace"

async function connect(defaultCwd = WORKSPACE) {
	const server = createInterchangeServer(defaultCwd)
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

		process.env.CLAUDE_CONFIG_DIR = claudeDir
		process.env.AGENT_INTERCHANGE_TUMBLE_STORAGE = tumbleDir
		process.env.AGENT_INTERCHANGE_DIR = handoffRoot

		writeClaudeSession(claudeDir, { id: "cc-1", cwd: WORKSPACE, aiTitle: "Retry determinism" })
		writeTumbleTask(tumbleDir, { id: "tc-1", workspace: WORKSPACE, task: "Port the checker", mode: "code" })
	})

	afterEach(() => {
		delete process.env.CLAUDE_CONFIG_DIR
		delete process.env.AGENT_INTERCHANGE_TUMBLE_STORAGE
		delete process.env.AGENT_INTERCHANGE_DIR

		for (const dir of [claudeDir, tumbleDir, handoffRoot]) {
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

	it("filters to one agent, and to no workspace at all", async () => {
		writeClaudeSession(claudeDir, { id: "cc-2", cwd: "/tmp/elsewhere", aiTitle: "Different project" })

		const { client, close } = await connect()

		const onlyClaude = textOf(
			await client.callTool({ name: "list_agent_sessions", arguments: { agent: "claude-code" } }),
		)
		expect(onlyClaude).toContain("Retry determinism")
		expect(onlyClaude).not.toContain("Port the checker")
		expect(onlyClaude).not.toContain("Different project")

		const everywhere = textOf(await client.callTool({ name: "list_agent_sessions", arguments: { workspace: "" } }))
		expect(everywhere).toContain("Different project")

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
})
