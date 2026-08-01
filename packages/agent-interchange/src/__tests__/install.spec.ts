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
import { parseArgs, runInstaller, type Args } from "../install/index.js"

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(value), "utf8")
}

function installerFixture(action: Args["action"], existingBundle = false) {
	const dir = makeTempDir(`installer-${action}`)
	const args: Args = {
		action,
		claudeConfig: path.join(dir, "claude.json"),
		tumbleConfig: path.join(dir, "tumble.json"),
		destination: path.join(dir, "data", "mcp-server.mjs"),
	}
	const source = path.join(dir, "source.mjs")
	fs.writeFileSync(source, "new bundle", "utf8")
	writeJson(args.claudeConfig, {
		claudeOnly: true,
		mcpServers: { other: { command: "claude-other" }, [SERVER_NAME]: { command: "old-claude" } },
	})
	writeJson(args.tumbleConfig, {
		tumbleOnly: true,
		mcpServers: { other: { command: "tumble-other" }, [SERVER_NAME]: { command: "old-tumble" } },
	})
	if (existingBundle) {
		fs.mkdirSync(path.dirname(args.destination), { recursive: true })
		fs.writeFileSync(args.destination, "old bundle", { mode: 0o700 })
	}
	const before = new Map(
		[args.claudeConfig, args.tumbleConfig, args.destination].map((file) => [
			file,
			fs.existsSync(file) ? fs.readFileSync(file) : undefined,
		]),
	)
	return { dir, args, source, before }
}

function expectRestored(before: Map<string, Buffer | undefined>): void {
	for (const [file, content] of before) {
		if (content === undefined) {
			expect(fs.existsSync(file)).toBe(false)
		} else {
			expect(fs.readFileSync(file)).toEqual(content)
		}
	}
}

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

	it("rolls back a failed fresh install without leaving a bundle or partial config", async () => {
		const fixture = installerFixture("install")
		try {
			await expect(
				runInstaller(fixture.args, {
					source: fixture.source,
					afterMutation: (mutation) => {
						if (mutation === "claude-config") throw new Error("injected install failure")
					},
				}),
			).rejects.toThrow("injected install failure")
			expectRestored(fixture.before)
		} finally {
			fs.rmSync(fixture.dir, { recursive: true, force: true })
		}
	})

	it("rolls back a failed update without destroying the previous bundle or registrations", async () => {
		const fixture = installerFixture("install", true)
		try {
			await expect(
				runInstaller(fixture.args, {
					source: fixture.source,
					afterMutation: (mutation) => {
						if (mutation === "tumble-config") throw new Error("injected update failure")
					},
				}),
			).rejects.toThrow("injected update failure")
			expectRestored(fixture.before)
			expect(fs.statSync(fixture.args.destination).mode & 0o777).toBe(0o700)
		} finally {
			fs.rmSync(fixture.dir, { recursive: true, force: true })
		}
	})

	it("rolls back a failed uninstall without losing the installed bundle or registrations", async () => {
		const fixture = installerFixture("uninstall", true)
		try {
			await expect(
				runInstaller(fixture.args, {
					source: fixture.source,
					afterMutation: (mutation) => {
						if (mutation === "bundle") throw new Error("injected uninstall failure")
					},
				}),
			).rejects.toThrow("injected uninstall failure")
			expectRestored(fixture.before)
		} finally {
			fs.rmSync(fixture.dir, { recursive: true, force: true })
		}
	})

	it("preflights both configs before mutating any target", async () => {
		const fixture = installerFixture("install", true)
		try {
			fs.writeFileSync(fixture.args.tumbleConfig, "not json", "utf8")
			fixture.before.set(fixture.args.tumbleConfig, Buffer.from("not json"))
			await expect(runInstaller(fixture.args, { source: fixture.source })).rejects.toThrow()
			expectRestored(fixture.before)
		} finally {
			fs.rmSync(fixture.dir, { recursive: true, force: true })
		}
	})
})
