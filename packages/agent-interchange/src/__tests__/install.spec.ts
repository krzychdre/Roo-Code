import * as fs from "node:fs"
import * as path from "node:path"

import {
	addRegistration,
	claudeConfigPath,
	durableBundlePath,
	registration,
	removeRegistration,
	SERVER_NAME,
	updateConfig,
} from "../install/config.js"
import { makeTempDir } from "./fixtures.js"
import { parseArgs } from "../install/index.js"

describe("agent-interchange installer helpers", () => {
	it("uses durable user storage rather than the checkout", () => {
		expect(durableBundlePath("/home/me", "")).toBe("/home/me/.local/share/agent-interchange/mcp-server.mjs")
		expect(claudeConfigPath("/home/me")).toBe("/home/me/.claude.json")
	})

	it("preserves unrelated config and servers when registering", () => {
		const existing = { theme: "dark", mcpServers: { other: { command: "other" } } }
		const updated = addRegistration(existing, registration("/durable/server.mjs", true))

		expect(updated.theme).toBe("dark")
		expect(updated.mcpServers?.other).toEqual({ command: "other" })
		expect(updated.mcpServers?.[SERVER_NAME]).toMatchObject({ command: "node", args: ["/durable/server.mjs"] })
	})

	it("removes only the owned registration", () => {
		const existing = { extra: 1, mcpServers: { other: { command: "other" }, [SERVER_NAME]: { command: "node" } } }
		expect(removeRegistration(existing)).toEqual({ extra: 1, mcpServers: { other: { command: "other" } } })
	})

	it("requires an explicit Tumble config and accepts test-only path overrides", () => {
		const args = parseArgs(
			[
				"install",
				"--tumble-config",
				"/tmp/tumble.json",
				"--claude-config",
				"/tmp/claude.json",
				"--destination",
				"/tmp/server.mjs",
			],
			"/home/me",
		)
		expect(args).toMatchObject({
			action: "install",
			claudeConfig: "/tmp/claude.json",
			tumbleConfig: "/tmp/tumble.json",
			destination: "/tmp/server.mjs",
		})
	})

	it("atomically updates only a temporary test config", async () => {
		const dir = makeTempDir("installer")
		const file = path.join(dir, "mcp.json")
		fs.writeFileSync(file, JSON.stringify({ untouched: true, mcpServers: { other: { command: "other" } } }))

		await updateConfig(file, (value) => addRegistration(value, registration("/durable/server.mjs", true)), false)

		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
			untouched: true,
			mcpServers: { other: { command: "other" }, [SERVER_NAME]: { command: "node" } },
		})
		expect(fs.readdirSync(dir)).toEqual(["mcp.json"])
		fs.rmSync(dir, { recursive: true, force: true })
	})
})
