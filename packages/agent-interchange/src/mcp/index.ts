#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { createInterchangeServer } from "./server.js"

/**
 * stdio entrypoint.
 *
 * Both clients launch MCP servers with the workspace as the process cwd, which
 * is why every workspace-scoped tool can default to it. Nothing may be written
 * to stdout except protocol frames — diagnostics go to stderr.
 */
async function main(): Promise<void> {
	const server = createInterchangeServer(process.cwd())
	const transport = new StdioServerTransport()

	await server.connect(transport)
}

main().catch((error) => {
	console.error("[agent-interchange] failed to start:", error)
	process.exit(1)
})
