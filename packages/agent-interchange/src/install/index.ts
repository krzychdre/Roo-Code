#!/usr/bin/env node
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
	addRegistration,
	claudeConfigPath,
	durableBundlePath,
	registration,
	removeRegistration,
	updateConfig,
} from "./config.js"

interface Args {
	action: "install" | "uninstall"
	claudeConfig: string
	tumbleConfig: string
	destination: string
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	if (args.action === "install") {
		const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-server.mjs")
		await copyAtomically(source, args.destination)
		await updateConfig(
			args.claudeConfig,
			(value) => addRegistration(value, registration(args.destination, false)),
			true,
		)
		await updateConfig(
			args.tumbleConfig,
			(value) => addRegistration(value, registration(args.destination, true)),
			false,
		)
		console.log(`Installed bundle: ${args.destination}`)
		console.log(`Updated Claude Code: ${args.claudeConfig}`)
		console.log(`Updated Tumble Code: ${args.tumbleConfig}`)
		return
	}

	await updateConfig(args.claudeConfig, removeRegistration, false)
	await updateConfig(args.tumbleConfig, removeRegistration, false)
	await fs.rm(args.destination, { force: true })
	console.log("Removed agent-interchange registrations and durable bundle.")
}

export function parseArgs(argv: string[], home = os.homedir()): Args {
	const action = argv[0]
	if (action !== "install" && action !== "uninstall") usage()

	const options = new Map<string, string>()
	for (let index = 1; index < argv.length; index += 2) {
		const key = argv[index]
		const value = argv[index + 1]
		if (!key?.startsWith("--") || !value) usage()
		options.set(key, value)
	}

	const tumbleConfig = options.get("--tumble-config") || process.env.AGENT_INTERCHANGE_TUMBLE_MCP_CONFIG
	if (!tumbleConfig) {
		throw new Error(
			"Tumble MCP config is required. Pass --tumble-config <globalStorage>/settings/mcp_settings.json " +
				"or set AGENT_INTERCHANGE_TUMBLE_MCP_CONFIG.",
		)
	}

	return {
		action,
		claudeConfig: path.resolve(options.get("--claude-config") || claudeConfigPath(home)),
		tumbleConfig: path.resolve(tumbleConfig),
		destination: path.resolve(options.get("--destination") || durableBundlePath(home)),
	}
}

async function copyAtomically(source: string, destination: string): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true })
	const temporary = `${destination}.new-${process.pid}-${Date.now()}`
	try {
		await fs.copyFile(source, temporary)
		await fs.chmod(temporary, 0o755)
		const handle = await fs.open(temporary, "r")
		try {
			await handle.sync()
		} finally {
			await handle.close()
		}
		await fs.rename(temporary, destination)
	} finally {
		await fs.rm(temporary, { force: true })
	}
}

function usage(): never {
	throw new Error(
		"Usage: agent-interchange-install <install|uninstall> --tumble-config <path> " +
			"[--claude-config <path>] [--destination <path>]",
	)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(`[agent-interchange] ${error instanceof Error ? error.message : String(error)}`)
		process.exitCode = 1
	})
}
