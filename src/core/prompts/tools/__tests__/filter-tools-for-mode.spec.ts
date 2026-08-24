// npx vitest run core/prompts/tools/__tests__/filter-tools-for-mode.spec.ts

import type OpenAI from "openai"

import { filterNativeToolsForMode, isToolAllowedInMode } from "../filter-tools-for-mode"

function makeTool(name: string): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: {
			name,
			description: `${name} tool`,
			parameters: { type: "object", properties: {} },
		},
	} as OpenAI.Chat.ChatCompletionTool
}

describe("filterNativeToolsForMode - disabledTools", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		makeTool("execute_command"),
		makeTool("read_file"),
		makeTool("write_to_file"),
		makeTool("apply_diff"),
		makeTool("edit"),
	]

	it("removes tools listed in settings.disabledTools", () => {
		const settings = {
			disabledTools: ["execute_command"],
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("execute_command")
		expect(resultNames).toContain("read_file")
		expect(resultNames).toContain("write_to_file")
		expect(resultNames).toContain("apply_diff")
	})

	it("does not remove any tools when disabledTools is empty", () => {
		const settings = {
			disabledTools: [],
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("execute_command")
		expect(resultNames).toContain("read_file")
		expect(resultNames).toContain("write_to_file")
		expect(resultNames).toContain("apply_diff")
	})

	it("does not remove any tools when disabledTools is undefined", () => {
		const settings = {}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("execute_command")
		expect(resultNames).toContain("read_file")
	})

	it("combines disabledTools with other setting-based exclusions", () => {
		const settings = {
			disabledTools: ["execute_command"],
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("execute_command")
		expect(resultNames).toContain("read_file")
	})

	it("disables canonical tool when disabledTools contains alias name", () => {
		const settings = {
			disabledTools: ["search_and_replace"],
			modelInfo: {
				includedTools: ["search_and_replace"],
			},
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("search_and_replace")
		expect(resultNames).not.toContain("edit")
	})
})

describe("filterNativeToolsForMode - access_mcp_resource allowlist", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [makeTool("read_file"), makeTool("access_mcp_resource")]

	// Minimal McpHub stub exposing only getServers(), which is all the resource
	// availability check uses.
	function makeMcpHub(servers: Array<{ name: string; resources?: unknown[] }>): any {
		return {
			getServers: () => servers,
		}
	}

	it("keeps access_mcp_resource when an allowed server has resources", () => {
		const mcpHub = makeMcpHub([{ name: "allowed-server", resources: [{ uri: "res://x" }] }])

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {}, mcpHub, [
			"allowed-server",
		])

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("access_mcp_resource")
	})

	it("removes access_mcp_resource when only a disallowed server has resources", () => {
		// The server with resources is NOT in the allowlist, so the restricted
		// mode must not retain access_mcp_resource.
		const mcpHub = makeMcpHub([
			{ name: "allowed-server", resources: [] },
			{ name: "blocked-server", resources: [{ uri: "res://secret" }] },
		])

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {}, mcpHub, [
			"allowed-server",
		])

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("access_mcp_resource")
		expect(resultNames).toContain("read_file")
	})

	it("considers all servers when no allowlist is provided (unrestricted mode)", () => {
		const mcpHub = makeMcpHub([{ name: "any-server", resources: [{ uri: "res://y" }] }])

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {}, mcpHub)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("access_mcp_resource")
	})

	it("removes access_mcp_resource when the allowlist is empty", () => {
		const mcpHub = makeMcpHub([{ name: "some-server", resources: [{ uri: "res://z" }] }])

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {}, mcpHub, [])

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("access_mcp_resource")
	})

	// Defense in depth: even if a caller forgets to thread `allowedMcpServers`, the
	// function must fall back to the mode config's own allowlist so a restricted mode
	// can never retain access_mcp_resource based on resources from disallowed servers.
	describe("falls back to modeConfig.allowedMcpServers when the parameter is omitted", () => {
		const restrictedMode = {
			slug: "restricted",
			name: "Restricted",
			roleDefinition: "restricted role",
			groups: ["read", "mcp"],
			allowedMcpServers: ["allowed-server"],
		} as any

		it("removes access_mcp_resource when only a disallowed server has resources (param omitted)", () => {
			const mcpHub = makeMcpHub([
				{ name: "allowed-server", resources: [] },
				{ name: "blocked-server", resources: [{ uri: "res://secret" }] },
			])

			// Note: the 8th argument (allowedMcpServers) is intentionally omitted to
			// simulate a caller that does not thread the allowlist through.
			const result = filterNativeToolsForMode(
				nativeTools,
				"restricted",
				[restrictedMode],
				undefined,
				undefined,
				{},
				mcpHub,
			)

			const resultNames = result.map((t) => (t as any).function.name)
			expect(resultNames).not.toContain("access_mcp_resource")
			expect(resultNames).toContain("read_file")
		})

		it("keeps access_mcp_resource when an allowed server has resources (param omitted)", () => {
			const mcpHub = makeMcpHub([
				{ name: "allowed-server", resources: [{ uri: "res://x" }] },
				{ name: "blocked-server", resources: [{ uri: "res://secret" }] },
			])

			const result = filterNativeToolsForMode(
				nativeTools,
				"restricted",
				[restrictedMode],
				undefined,
				undefined,
				{},
				mcpHub,
			)

			const resultNames = result.map((t) => (t as any).function.name)
			expect(resultNames).toContain("access_mcp_resource")
		})

		it("prefers the explicit parameter over the mode config allowlist when both are provided", () => {
			// The mode config allows "allowed-server", but the explicit parameter
			// allows only "blocked-server" (which has the resources), so the explicit
			// parameter must win and access_mcp_resource is retained.
			const mcpHub = makeMcpHub([
				{ name: "allowed-server", resources: [] },
				{ name: "blocked-server", resources: [{ uri: "res://secret" }] },
			])

			const result = filterNativeToolsForMode(
				nativeTools,
				"restricted",
				[restrictedMode],
				undefined,
				undefined,
				{},
				mcpHub,
				["blocked-server"],
			)

			const resultNames = result.map((t) => (t as any).function.name)
			expect(resultNames).toContain("access_mcp_resource")
		})
	})
})

describe("filterNativeToolsForMode - web group", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		makeTool("read_file"),
		makeTool("web_search"),
		makeTool("web_fetch"),
	]

	const names = (tools: OpenAI.Chat.ChatCompletionTool[]) => tools.map((t) => (t as any).function.name)

	it("advertises no web tools when webToolsEnabled is false", () => {
		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {
			webToolsEnabled: false,
		})

		expect(names(result)).toEqual(["read_file"])
	})

	it("advertises no web tools when webToolsEnabled is absent", () => {
		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {})

		expect(names(result)).toEqual(["read_file"])
	})

	it("advertises both web tools in a mode that carries the group when enabled", () => {
		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {
			webToolsEnabled: true,
		})

		expect(names(result)).toContain("web_search")
		expect(names(result)).toContain("web_fetch")
	})

	it("still hides the web tools in a mode without the group even when enabled", () => {
		// The orchestrator mode carries no tool groups at all.
		const result = filterNativeToolsForMode(nativeTools, "orchestrator", undefined, undefined, undefined, {
			webToolsEnabled: true,
		})

		expect(names(result)).not.toContain("web_search")
		expect(names(result)).not.toContain("web_fetch")
	})

	it("honors disabledTools for a single web tool while the group stays on", () => {
		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {
			webToolsEnabled: true,
			disabledTools: ["web_fetch"],
		})

		expect(names(result)).toContain("web_search")
		expect(names(result)).not.toContain("web_fetch")
	})
})

describe("isToolAllowedInMode - web group", () => {
	it("returns false for web tools when webToolsEnabled is off", () => {
		expect(isToolAllowedInMode("web_search", "code", undefined, undefined, undefined, {})).toBe(false)
		expect(isToolAllowedInMode("web_fetch", "code", undefined, undefined, undefined, {})).toBe(false)
	})

	it("returns true for web tools in a web-capable mode when enabled", () => {
		const settings = { webToolsEnabled: true }
		expect(isToolAllowedInMode("web_search", "ask", undefined, undefined, undefined, settings)).toBe(true)
		expect(isToolAllowedInMode("web_fetch", "ask", undefined, undefined, undefined, settings)).toBe(true)
	})
})
