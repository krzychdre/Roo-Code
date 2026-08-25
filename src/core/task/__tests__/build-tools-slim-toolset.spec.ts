// npx vitest run src/core/task/__tests__/build-tools-slim-toolset.spec.ts

import type OpenAI from "openai"

import type { ProviderSettings } from "@roo-code/types"

import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import type { ClineProvider } from "../../webview/ClineProvider"

// The code index is reported as fully live so codebase_search survives and the
// slim allowlist is exercised against a realistic set.
vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: vi.fn(() => ({
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			isInitialized: true,
		})),
	},
}))

// Two filesystem custom tools, as a user's .roo/tools directory would provide.
// They are only picked up when the `customTools` experiment is on.
const customToolFixtures = [
	{ name: "apply_patch_custom", description: "A user-authored patch tool." },
	{ name: "deploy_to_staging", description: "A user-authored deploy tool." },
]

vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		loadFromDirectoriesIfStale: vi.fn(async () => {}),
		getAllSerialized: vi.fn(() => customToolFixtures),
		has: vi.fn(() => false),
	},
	formatNative: (tool: { name: string; description: string }) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	}),
}))

vi.mock("../../../services/roo-config/index.js", () => ({
	getRooDirectoriesForCwd: () => ["/test/path/.roo"],
}))

const mcpHub = {
	getServers: () => [
		{
			name: "docs-server",
			disabled: false,
			resources: [{ uri: "docs://index", name: "Docs index" }],
			tools: [{ name: "lookup", description: "Look a symbol up.", inputSchema: { type: "object" } }],
		},
	],
} as any

const provider = {
	getMcpHub: () => mcpHub,
	context: {} as unknown,
} as unknown as ClineProvider

/**
 * The two API profiles a user would bind to two different modes. Only the slim
 * flags differ; everything else is irrelevant to tool advertising.
 */
const profiles: Record<string, ProviderSettings> = {
	"qwen-slim": { apiProvider: "openai", slimToolset: true },
	"opus-full": { apiProvider: "anthropic" },
}

/**
 * Stand-in for the `modeApiConfigs` binding, resolved here by hand.
 *
 * The production path is not exercised by this file: `ClineProvider.handleModeSwitch`
 * activates the new mode's saved profile, and `TaskApiLoop.attemptApiRequest`
 * re-reads `providerRef.deref().getState()` (and therefore `state.apiConfiguration`)
 * on every single request before handing it to the builder. What these tests pin
 * down is the builder's half of that contract: it derives the advertised set purely
 * from the apiConfiguration it is handed, keeping nothing from the previous call.
 */
const modeApiConfigs: Record<string, string> = {
	code: "qwen-slim",
	architect: "opus-full",
}

async function advertisedToolsForMode(mode: string): Promise<string[]> {
	const apiConfiguration = profiles[modeApiConfigs[mode]]
	const result = await buildNativeToolsArrayWithRestrictions({
		provider,
		cwd: "/test/path",
		mode,
		customModes: undefined,
		experiments: { runSlashCommand: true, imageGeneration: true },
		apiConfiguration,
		webToolsEnabled: true,
	})
	return result.tools.map((tool) => (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name)
}

describe("buildNativeToolsArrayWithRestrictions - slim toolset per profile", () => {
	it("reads the slim flags off the ACTIVE profile, not off global settings", async () => {
		const slim = await advertisedToolsForMode("code")

		expect(slim).toContain("apply_diff")
		expect(slim).toContain("write_to_file")
		expect(slim).toContain("execute_command")
		expect(slim).not.toContain("run_parallel_tasks")
		expect(slim).not.toContain("run_slash_command")
		expect(slim).not.toContain("generate_image")
		expect(slim).not.toContain("access_mcp_resource")
		// No per-server MCP schema either: slimHidesMcp defaults to true.
		expect(slim.some((name) => name.includes("docs-server"))).toBe(false)
	})

	it("caches nothing: each call derives the set from the apiConfiguration it is handed", async () => {
		// Two calls, the profiles a mode switch would swap between. Nothing about
		// the first (slim) call survives into the second, which is what makes the
		// restriction safe across a mid-task mode switch: the per-request state
		// read in TaskApiLoop.attemptApiRequest is the only input.
		const slim = await advertisedToolsForMode("code")
		const full = await advertisedToolsForMode("architect")

		expect(slim).not.toContain("run_parallel_tasks")
		expect(full).toContain("run_parallel_tasks")
		expect(full).toContain("run_slash_command")
		expect(full).toContain("access_mcp_resource")
		expect(full.some((name) => name.includes("docs-server"))).toBe(true)

		// And back again: the restriction follows the profile in both directions.
		const slimAgain = await advertisedToolsForMode("code")
		expect(slimAgain).toEqual(slim)
	})

	it("keeps MCP schemas when the slim profile sets slimHidesMcp to false", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: { apiProvider: "openai", slimToolset: true, slimHidesMcp: false },
			webToolsEnabled: true,
		})
		const names = result.tools.map((tool) => (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name)

		expect(names.some((name) => name.includes("docs-server"))).toBe(true)
		expect(names).toContain("access_mcp_resource")
		// The non-MCP half of the restriction still applies.
		expect(names).not.toContain("run_parallel_tasks")
	})
})

describe("buildNativeToolsArrayWithRestrictions - slim toolset and filesystem custom tools", () => {
	const buildWithCustomTools = (apiConfiguration: ProviderSettings) =>
		buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: { customTools: true },
			apiConfiguration,
			webToolsEnabled: true,
		})

	it("advertises none of the user-authored tools under a slim profile", async () => {
		const result = await buildWithCustomTools({ apiProvider: "openai", slimToolset: true })
		const names = result.tools.map((tool) => (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name)

		// Custom tools are concatenated after the mode filter, so they need the
		// intersection applied explicitly or they would slip through.
		expect(names).not.toContain("apply_patch_custom")
		expect(names).not.toContain("deploy_to_staging")
		expect(names).toContain("apply_diff")
	})

	it("keeps the user-authored tools when the profile is not slim", async () => {
		const result = await buildWithCustomTools({ apiProvider: "openai" })
		const names = result.tools.map((tool) => (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name)

		expect(names).toContain("apply_patch_custom")
		expect(names).toContain("deploy_to_staging")
	})
})

describe("buildNativeToolsArrayWithRestrictions - slim toolset on the Gemini branch", () => {
	// includeAllToolsWithRestrictions is set for Gemini only (see ApiRequestBuilder).
	const buildForGemini = (apiConfiguration: ProviderSettings) =>
		buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/test/path",
			mode: "code",
			customModes: undefined,
			experiments: { runSlashCommand: true, imageGeneration: true },
			apiConfiguration,
			webToolsEnabled: true,
			includeAllToolsWithRestrictions: true,
		})

	it("declares exactly the slim set, matching allowedFunctionNames, for a slim profile", async () => {
		const result = await buildForGemini({ apiProvider: "gemini", slimToolset: true })
		const declared = result.tools.map((tool) => (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name)

		// Gemini's allowed_function_names may only name declared functions, so the
		// two lists have to be the same set, in the same order here.
		expect(result.allowedFunctionNames).toEqual(declared)
		expect(declared).not.toContain("edit_file")
		expect(declared).not.toContain("apply_patch")
		expect(declared).not.toContain("generate_image")
		expect(declared).not.toContain("run_parallel_tasks")
		expect(declared).not.toContain("run_slash_command")
		expect(declared).not.toContain("access_mcp_resource")
		expect(declared.some((name) => name.includes("docs-server"))).toBe(false)
		expect(declared).toContain("apply_diff")
		expect(declared).toContain("write_to_file")
	})

	it("still declares the whole universe when the profile is not slim", async () => {
		const result = await buildForGemini({ apiProvider: "gemini" })
		const declared = result.tools.map((tool) => (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name)

		// Unchanged pre-slim behaviour: every schema is declared so the model can
		// still refer to historical calls, and allowedFunctionNames is the narrower
		// mode-filtered list.
		expect(declared).toContain("edit_file")
		expect(declared).toContain("apply_patch")
		expect(declared).toContain("generate_image")
		expect(declared.some((name) => name.includes("docs-server"))).toBe(true)
		expect(result.allowedFunctionNames!.length).toBeLessThan(declared.length)
		expect(result.allowedFunctionNames).not.toContain("edit_file")
	})
})
