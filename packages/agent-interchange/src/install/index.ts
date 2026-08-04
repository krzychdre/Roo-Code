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
	readConfig,
	removeRegistration,
	updateConfig,
} from "./config.js"

export interface Args {
	action: "install" | "uninstall"
	claudeConfig: string
	tumbleConfig: string
	destination: string
}

type Mutation = "bundle" | "claude-config" | "tumble-config"

export interface InstallerOptions {
	/** Test seam for end-to-end rollback verification. */
	afterMutation?: (mutation: Mutation) => void | Promise<void>
	/** Test-only source override; production always installs the sibling bundle. */
	source?: string
}

interface FileSnapshot {
	path: string
	existed: boolean
	content?: Buffer
	mode?: number
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	await runInstaller(args)
}

export async function runInstaller(args: Args, options: InstallerOptions = {}): Promise<void> {
	const source = options.source ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-server.mjs")
	const snapshots = await preflight(args, source)

	try {
		if (args.action === "install") {
			await copyAtomically(source, args.destination)
			await options.afterMutation?.("bundle")
			await updateConfig(
				args.claudeConfig,
				(value) => addRegistration(value, registration(args.destination, false)),
				true,
			)
			await options.afterMutation?.("claude-config")
			await updateConfig(
				args.tumbleConfig,
				(value) => addRegistration(value, registration(args.destination, true)),
				false,
			)
			await options.afterMutation?.("tumble-config")
			console.log(`Installed bundle: ${args.destination}`)
			console.log(`Updated Claude Code: ${args.claudeConfig}`)
			console.log(`Updated Tumble Code: ${args.tumbleConfig}`)
			return
		}

		await updateConfig(args.claudeConfig, removeRegistration, false)
		await options.afterMutation?.("claude-config")
		await updateConfig(args.tumbleConfig, removeRegistration, false)
		await options.afterMutation?.("tumble-config")
		await fs.rm(args.destination, { force: true })
		await options.afterMutation?.("bundle")
		console.log("Removed agent-interchange registrations and durable bundle.")
	} catch (error) {
		try {
			await rollback(snapshots)
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "Installer failed and rollback was incomplete")
		}
		throw error
	}
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
	const content = await fs.readFile(source)
	await writeAtomically(destination, content, 0o755)
}

async function writeAtomically(destination: string, content: Buffer, mode: number): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true })
	const temporary = `${destination}.new-${process.pid}-${Date.now()}`
	try {
		const handle = await fs.open(temporary, "wx", mode)
		try {
			await handle.writeFile(content)
			await handle.sync()
		} finally {
			await handle.close()
		}
		await fs.rename(temporary, destination)
	} finally {
		await fs.rm(temporary, { force: true })
	}
}

async function preflight(args: Args, source: string): Promise<FileSnapshot[]> {
	const targets = [args.destination, args.claudeConfig, args.tumbleConfig].map((file) => path.resolve(file))
	if (new Set(targets).size !== targets.length) {
		throw new Error("Bundle, Claude config, and Tumble config must be different files")
	}

	if (args.action === "install") {
		await fs.access(source, fs.constants.R_OK)
	}

	await Promise.all([readConfig(args.claudeConfig, args.action === "install"), readConfig(args.tumbleConfig, false)])
	const snapshots = await Promise.all(targets.map(snapshot))
	await Promise.all(targets.map(assertWritable))
	return snapshots
}

async function snapshot(file: string): Promise<FileSnapshot> {
	try {
		const [content, stat] = await Promise.all([fs.readFile(file), fs.stat(file)])
		return { path: file, existed: true, content, mode: stat.mode & 0o7777 }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, existed: false }
		throw error
	}
}

async function assertWritable(file: string): Promise<void> {
	try {
		await fs.access(file, fs.constants.W_OK)
		return
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}

	let ancestor = path.dirname(file)
	for (;;) {
		try {
			await fs.access(ancestor, fs.constants.W_OK)
			return
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			const parent = path.dirname(ancestor)
			if (parent === ancestor) throw error
			ancestor = parent
		}
	}
}

async function rollback(snapshots: FileSnapshot[]): Promise<void> {
	const errors: unknown[] = []
	for (const entry of [...snapshots].reverse()) {
		try {
			if (entry.existed) {
				await writeAtomically(entry.path, entry.content!, entry.mode!)
			} else {
				await fs.rm(entry.path, { force: true })
			}
		} catch (error) {
			errors.push(error)
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, "Could not restore all installer targets")
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
