import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { withLockedJsonTransaction } from "../../../../src/utils/safeWriteJson.js"

export const SERVER_NAME = "agent-interchange"

export interface McpConfig {
	mcpServers?: Record<string, unknown>
	[key: string]: unknown
}

export interface Registration {
	command: "node"
	args: string[]
	type?: "stdio"
	alwaysAllow?: string[]
}

export function durableBundlePath(home = os.homedir(), dataHome = process.env.XDG_DATA_HOME): string {
	return path.join(dataHome?.trim() || path.join(home, ".local", "share"), SERVER_NAME, "mcp-server.mjs")
}

export function claudeConfigPath(home = os.homedir()): string {
	return path.join(home, ".claude.json")
}

export function registration(bundlePath: string, tumble: boolean): Registration {
	return {
		...(tumble ? {} : { type: "stdio" as const }),
		command: "node",
		args: [path.resolve(bundlePath)],
		...(tumble
			? {
					alwaysAllow: ["list_agent_sessions", "read_agent_session", "list_handoffs", "read_handoff"],
				}
			: {}),
	}
}

export function addRegistration(config: McpConfig, value: Registration): McpConfig {
	const servers = isRecord(config.mcpServers) ? config.mcpServers : {}
	return { ...config, mcpServers: { ...servers, [SERVER_NAME]: value } }
}

export function removeRegistration(config: McpConfig): McpConfig {
	if (!isRecord(config.mcpServers) || !(SERVER_NAME in config.mcpServers)) return config
	const servers = { ...config.mcpServers }
	delete servers[SERVER_NAME]
	return { ...config, mcpServers: servers }
}

export async function updateConfig(
	file: string,
	update: (config: McpConfig) => McpConfig,
	allowMissing: boolean,
): Promise<boolean> {
	return withLockedJsonTransaction(file, file, async (writeJson) => {
		let config: McpConfig
		try {
			config = JSON.parse(await fs.readFile(file, "utf8")) as McpConfig
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !allowMissing) throw error
			config = {}
		}

		if (!isRecord(config)) throw new Error(`MCP config must contain a JSON object: ${file}`)
		const next = update(config)
		if (next === config) return false
		await writeJson(next, { prettyPrint: true })
		return true
	})
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}
