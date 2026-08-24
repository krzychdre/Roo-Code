// npx vitest run src/core/prompts/tools/__tests__/slim-toolset.spec.ts

import type OpenAI from "openai"

import { TOOL_ALIASES } from "../../../../shared/tools"
import { getNativeTools } from "../native-tools"
import {
	SLIM_TOOLSET_ALLOWLIST,
	SLIM_TOOLSET_ALLOWSET,
	applySlimToolset,
	filterMcpToolsForMode,
	filterNativeToolsForMode,
	isSlimToolsetEnabled,
	isToolAllowedInMode,
	resolveToolAlias,
	slimToolsetHidesMcp,
} from "../filter-tools-for-mode"

/** Code index stub that reports the feature as fully live, so codebase_search survives. */
const liveCodeIndexManager = {
	isFeatureEnabled: true,
	isFeatureConfigured: true,
	isInitialized: true,
} as any

/** MCP hub stub with one server that exposes a resource (keeps access_mcp_resource alive). */
const mcpHubWithResources = {
	getServers: () => [{ name: "docs", resources: [{ uri: "res://x" }] }],
} as any

function makeTool(name: string): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } },
	} as OpenAI.Chat.ChatCompletionTool
}

function names(tools: OpenAI.Chat.ChatCompletionTool[]): string[] {
	return tools.map((tool) => (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name)
}

/**
 * Advertise the real native catalog for the built-in `code` mode, which carries
 * every group (read, edit, command, mcp, web), so the intersection is exercised
 * against production data rather than a hand-picked stub list.
 */
function advertisedForCodeMode(settings: Record<string, any>, experiments: Record<string, boolean> = {}): string[] {
	return names(
		filterNativeToolsForMode(
			getNativeTools(),
			"code",
			undefined,
			experiments,
			liveCodeIndexManager,
			settings,
			mcpHubWithResources,
		),
	)
}

const fullSettings = { webToolsEnabled: true }
const slimSettings = { webToolsEnabled: true, slimToolset: true }

describe("applySlimToolset", () => {
	it("is the identity function when the profile does not ask for the slim toolset", () => {
		const tools = new Set(["read_file", "edit_file", "run_parallel_tasks", "use_mcp_tool"])

		expect(applySlimToolset(tools, undefined)).toBe(tools)
		expect(applySlimToolset(tools, {})).toBe(tools)
		expect(applySlimToolset(tools, { slimToolset: false })).toBe(tools)
		// slimHidesMcp on its own means nothing: without slimToolset there is
		// nothing to restrict.
		expect(applySlimToolset(tools, { slimHidesMcp: true })).toBe(tools)
	})

	it("only ever subtracts: a tool the mode never had is not added back", () => {
		// read_file is on the allowlist but absent from the input set.
		const result = applySlimToolset(new Set(["write_to_file"]), { slimToolset: true })

		expect([...result]).toEqual(["write_to_file"])
	})

	it("keeps the MCP tools when slimHidesMcp is explicitly false", () => {
		const tools = new Set(["read_file", "use_mcp_tool", "access_mcp_resource", "edit_file"])

		const hidden = applySlimToolset(tools, { slimToolset: true })
		const kept = applySlimToolset(tools, { slimToolset: true, slimHidesMcp: false })

		expect([...hidden].sort()).toEqual(["read_file"])
		expect([...kept].sort()).toEqual(["access_mcp_resource", "read_file", "use_mcp_tool"])
	})

	it("resolves an undefined slimHidesMcp as true, but only while slimToolset is on", () => {
		expect(slimToolsetHidesMcp({ slimToolset: true })).toBe(true)
		expect(slimToolsetHidesMcp({ slimToolset: true, slimHidesMcp: true })).toBe(true)
		expect(slimToolsetHidesMcp({ slimToolset: true, slimHidesMcp: false })).toBe(false)
		// Off profile: the MCP flag is inert in both directions.
		expect(slimToolsetHidesMcp({ slimHidesMcp: true })).toBe(false)
		expect(slimToolsetHidesMcp({})).toBe(false)
		expect(slimToolsetHidesMcp(undefined)).toBe(false)
		expect(isSlimToolsetEnabled({ slimToolset: true })).toBe(true)
		expect(isSlimToolsetEnabled({})).toBe(false)
	})
})

describe("filterNativeToolsForMode - slim toolset intersection", () => {
	it("advertises exactly the slim set for a mode carrying every group", () => {
		const advertised = advertisedForCodeMode(slimSettings, { runSlashCommand: true, imageGeneration: true })

		expect(advertised.sort()).toEqual(
			[
				// read
				"read_file",
				"search_files",
				"list_files",
				"codebase_search",
				// edit
				"apply_diff",
				"write_to_file",
				// command
				"execute_command",
				"read_artifact",
				// web
				"web_search",
				"web_fetch",
				// protocol
				"ask_followup_question",
				"attempt_completion",
				"switch_mode",
				"new_task",
				"update_todo_list",
				"skill",
				"tools_load",
			].sort(),
		)
	})

	it("hides the spare edit verbs, image generation, fan-out and slash commands", () => {
		// Ask for every opt-in edit verb through modelInfo.includedTools so the
		// full profile really does advertise them; the slim profile must not.
		const includedTools = ["edit", "search_replace", "edit_file", "apply_patch"]
		const experiments = { runSlashCommand: true, imageGeneration: true }

		const full = advertisedForCodeMode({ ...fullSettings, modelInfo: { includedTools } }, experiments)
		const slim = advertisedForCodeMode({ ...slimSettings, modelInfo: { includedTools } }, experiments)

		for (const hiddenTool of [
			"edit",
			"search_replace",
			"edit_file",
			"apply_patch",
			"generate_image",
			"run_parallel_tasks",
			"run_slash_command",
			// `use_mcp_tool` has no native schema (MCP is advertised per server,
			// see filterMcpToolsForMode below); `access_mcp_resource` does.
			"access_mcp_resource",
		]) {
			expect(full).toContain(hiddenTool)
			expect(slim).not.toContain(hiddenTool)
		}
	})

	it("keeps the protocol tools a task cannot run without", () => {
		const advertised = advertisedForCodeMode(slimSettings)

		for (const protocolTool of [
			"ask_followup_question",
			"attempt_completion",
			"switch_mode",
			"new_task",
			"update_todo_list",
			"skill",
			"tools_load",
		]) {
			expect(advertised).toContain(protocolTool)
		}
	})

	it("changes nothing when the profile leaves the slim toolset off", () => {
		const experiments = { runSlashCommand: true, imageGeneration: true }
		const base = { ...fullSettings, modelInfo: { includedTools: ["edit_file"] } }

		const withFlagAbsent = advertisedForCodeMode(base, experiments)
		const withFlagFalse = advertisedForCodeMode({ ...base, slimToolset: false }, experiments)

		expect(withFlagFalse).toEqual(withFlagAbsent)
		expect(withFlagAbsent).toContain("edit_file")
		expect(withFlagAbsent).toContain("run_parallel_tasks")
	})

	it("keeps the web tools only when the mode has the group AND web tools are enabled", () => {
		// Slim profile, web tools off globally: the group resolves to nothing.
		expect(advertisedForCodeMode({ slimToolset: true })).not.toContain("web_search")
		expect(advertisedForCodeMode({ slimToolset: true })).not.toContain("web_fetch")

		// Slim profile, web tools on: both tools survive the intersection.
		expect(advertisedForCodeMode(slimSettings)).toContain("web_search")
		expect(advertisedForCodeMode(slimSettings)).toContain("web_fetch")

		// A mode without the `web` group never gains them, slim or not.
		const readOnlyMode = [
			{ slug: "reader", name: "Reader", roleDefinition: "reads", groups: ["read"] as const },
		] as any
		const readerSlim = names(
			filterNativeToolsForMode(
				getNativeTools(),
				"reader",
				readOnlyMode,
				{},
				liveCodeIndexManager,
				slimSettings,
				mcpHubWithResources,
			),
		)
		expect(readerSlim).not.toContain("web_search")
		expect(readerSlim).not.toContain("web_fetch")
		expect(readerSlim).toContain("read_file")
	})

	it("keeps access_mcp_resource when the slim profile does not hide MCP", () => {
		const advertised = advertisedForCodeMode({ ...slimSettings, slimHidesMcp: false })

		expect(advertised).toContain("access_mcp_resource")
		// The rest of the slim restriction still applies.
		expect(advertised).not.toContain("run_parallel_tasks")
	})

	it("still honours disabledTools on top of the intersection", () => {
		const advertised = advertisedForCodeMode({ ...slimSettings, disabledTools: ["execute_command"] })

		expect(advertised).not.toContain("execute_command")
		expect(advertised).toContain("read_file")
	})

	it("lists both read_artifact and its read_command_output alias in the allowlist", () => {
		// The intersection must be correct regardless of whether alias resolution
		// already ran on the incoming set.
		expect(SLIM_TOOLSET_ALLOWLIST).toContain("read_artifact")
		expect(SLIM_TOOLSET_ALLOWLIST).toContain("read_command_output")
		expect([...applySlimToolset(new Set(["read_command_output"]), { slimToolset: true })]).toEqual([
			"read_command_output",
		])
	})
})

describe("SLIM_TOOLSET_ALLOWSET - alias parity", () => {
	it("holds an alias exactly when its target tool is allowlisted", () => {
		// Callers hand in either spelling, so the lookup set has to answer the
		// same way for both. Derived from TOOL_ALIASES, so this test fails the
		// day someone adds an alias for an allowlisted tool and forgets the set.
		for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
			expect(SLIM_TOOLSET_ALLOWSET.has(alias)).toBe(SLIM_TOOLSET_ALLOWSET.has(canonical))
		}
	})

	it("covers the concrete gap: write_file behaves like write_to_file", () => {
		expect(SLIM_TOOLSET_ALLOWSET.has("write_file")).toBe(true)
		expect(SLIM_TOOLSET_ALLOWSET.has("read_command_output")).toBe(true)
		// An alias whose target is hidden stays hidden.
		expect(SLIM_TOOLSET_ALLOWSET.has("search_and_replace")).toBe(false)
		expect([...applySlimToolset(new Set(["write_file", "search_and_replace"]), { slimToolset: true })]).toEqual([
			"write_file",
		])
	})
})

describe("filterMcpToolsForMode - slim toolset", () => {
	const mcpTools = [makeTool("mcp--docs--search"), makeTool("mcp--docs--fetch")]

	it("drops every per-server schema when the slim profile hides MCP", () => {
		expect(filterMcpToolsForMode(mcpTools, "code", undefined, {}, { slimToolset: true })).toEqual([])
		expect(
			filterMcpToolsForMode(mcpTools, "code", undefined, {}, { slimToolset: true, slimHidesMcp: true }),
		).toEqual([])
	})

	it("keeps the schemas when slimHidesMcp is false or the slim toolset is off", () => {
		expect(
			names(filterMcpToolsForMode(mcpTools, "code", undefined, {}, { slimToolset: true, slimHidesMcp: false })),
		).toEqual(["mcp--docs--search", "mcp--docs--fetch"])
		expect(names(filterMcpToolsForMode(mcpTools, "code", undefined, {}))).toEqual([
			"mcp--docs--search",
			"mcp--docs--fetch",
		])
		// slimHidesMcp without slimToolset must not hide anything.
		expect(names(filterMcpToolsForMode(mcpTools, "code", undefined, {}, { slimHidesMcp: true }))).toEqual([
			"mcp--docs--search",
			"mcp--docs--fetch",
		])
	})
})

describe("isToolAllowedInMode - slim toolset", () => {
	const check = (tool: string, settings: Record<string, any>) =>
		isToolAllowedInMode(tool as any, "code", undefined, {}, liveCodeIndexManager, settings)

	it("mirrors the intersection so prompt text never names a hidden tool", () => {
		// Hidden by the slim allowlist, available on the same mode otherwise.
		expect(check("run_parallel_tasks", slimSettings)).toBe(false)
		expect(check("run_parallel_tasks", fullSettings)).toBe(true)
		expect(check("access_mcp_resource", slimSettings)).toBe(false)
		expect(check("access_mcp_resource", fullSettings)).toBe(true)
		// On the allowlist: unaffected.
		expect(check("apply_diff", slimSettings)).toBe(true)
		expect(check("read_file", slimSettings)).toBe(true)
		// Alias of an allowlisted tool, checked here BEFORE alias resolution runs,
		// so it has to be in the lookup set by name.
		expect(check("write_file", slimSettings)).toBe(true)
		expect(check("write_file", fullSettings)).toBe(true)
		expect(check("read_command_output", slimSettings)).toBe(true)
		// MCP kept when the profile says so.
		expect(check("access_mcp_resource", { ...slimSettings, slimHidesMcp: false })).toBe(true)
		expect(check("use_mcp_tool", { ...slimSettings, slimHidesMcp: false })).toBe(true)
		expect(check("use_mcp_tool", slimSettings)).toBe(false)
	})
})

describe("slim toolset - dispatch tolerance", () => {
	it("keeps resolving hidden alias names to executable tools", () => {
		// Hiding is prompt-side only. A model that still emits a hidden name must
		// execute, never error: `search_and_replace` reaches `edit`,
		// `write_file` reaches `write_to_file`, `read_command_output` reaches
		// `read_artifact`. Alias resolution is untouched by the slim flags.
		expect(resolveToolAlias("search_and_replace")).toBe("edit")
		expect(resolveToolAlias("write_file")).toBe("write_to_file")
		expect(resolveToolAlias("read_command_output")).toBe("read_artifact")
		expect(TOOL_ALIASES["search_and_replace"]).toBe("edit")
	})

	it("does not add any hard block: the permission layer never sees the slim flags", async () => {
		// `edit_file` is a real, separately implemented tool (not an alias). A
		// slim profile hides its schema, but a model that calls it anyway still
		// executes: isToolAllowedForMode takes no slim parameter, so its answer
		// is identical with the slim profile active.
		const { isToolAllowedForMode } = await import("../../../tools/validateToolUse")

		expect(isToolAllowedForMode("edit_file", "code", [], undefined, undefined, {}, ["edit_file"])).toBe(true)
		expect(isToolAllowedForMode("search_and_replace", "code", [], undefined, undefined, {}, ["edit"])).toBe(true)
		expect(isToolAllowedForMode("read_command_output", "code", [], undefined, undefined, {})).toBe(true)
	})
})
