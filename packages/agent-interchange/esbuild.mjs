import * as esbuild from "esbuild"

/**
 * The MCP server has to run as a plain `node <file>` command, because that is
 * what both clients spawn — Claude Code from `.mcp.json`, Tumble Code from its
 * MCP settings. Bundling keeps that command free of workspace resolution and
 * of a build step in the consumer.
 */
await esbuild.build({
	entryPoints: ["src/mcp/index.ts"],
	outfile: "dist/mcp-server.mjs",
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	banner: {
		// The SDK's dependencies still reach for CommonJS globals in places.
		// The shebang comes from the entry file — esbuild keeps it, and a second
		// one here would land on line 2 and make the bundle unparseable.
		js: [
			"import { createRequire as __createRequire } from 'node:module'",
			"const require = __createRequire(import.meta.url)",
		].join("\n"),
	},
	logLevel: "info",
})
