// npx vitest run src/core/task/__tests__/build-tools-deferral.spec.ts
import type OpenAI from "openai"

import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import type { ClineProvider } from "../../webview/ClineProvider"

// Mock the CodeIndexManager import path used inside build-tools.ts
vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: vi.fn(() => ({
			isFeatureEnabled: () => false,
			isInitialized: () => false,
		})),
	},
}))

// Mock filterNativeToolsForMode/filterMcpToolsForMode so we can keep the test
// hermetic — we want to verify the deferral pass, not the mode filter.
vi.mock("../../prompts/tools/filter-tools-for-mode", () => ({
	filterNativeToolsForMode: (tools: OpenAI.Chat.ChatCompletionTool[]) => tools,
	filterMcpToolsForMode: (tools: OpenAI.Chat.ChatCompletionTool[]) => tools,
	resolveToolAlias: (name: string) => name,
	// The slim toolset is off in every case here, so these stand in as no-ops.
	// Slim behaviour has its own suite in build-tools-slim-toolset.spec.ts.
	isSlimToolsetEnabled: () => false,
	applySlimToolset: (tools: Set<string>) => tools,
}))

// Stub the native-tool catalog with a tiny known list.
vi.mock("../../prompts/tools/native-tools", () => {
	const nativeFn = (name: string): OpenAI.Chat.ChatCompletionFunctionTool => ({
		type: "function",
		function: {
			name,
			description: `Native ${name}`,
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	})
	const mcpFn = (server: string, tool: string): OpenAI.Chat.ChatCompletionFunctionTool => ({
		type: "function",
		function: {
			name: `mcp--${server}--${tool}`,
			description: `MCP ${tool} on ${server}.`,
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	})
	return {
		getNativeTools: () => [nativeFn("read_file"), nativeFn("apply_diff"), nativeFn("tools_load")],
		getMcpServerTools: () => [
			mcpFn("weather", "get_current"),
			mcpFn("weather", "get_forecast"),
			mcpFn("jira", "search"),
		],
	}
})

const makeProvider = (experiments: Record<string, boolean> | undefined): ClineProvider =>
	({
		getMcpHub: () => undefined,
		context: {} as unknown,
	}) as unknown as ClineProvider

describe("buildNativeToolsArrayWithRestrictions — deferral", () => {
	it("with deferredTools experiment OFF returns the full tool universe unchanged (v0 behavior)", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider: makeProvider({}),
			cwd: "/tmp",
			mode: "code",
			customModes: undefined,
			experiments: { deferredTools: false },
			apiConfiguration: undefined,
		})
		const names = result.tools.map((t) => (t as OpenAI.Chat.ChatCompletionFunctionTool).function.name)
		// Native + MCP all present, no deferred catalog
		expect(names).toContain("read_file")
		expect(names).toContain("apply_diff")
		expect(names).toContain("mcp--weather--get_current")
		expect(names).toContain("mcp--weather--get_forecast")
		expect(names).toContain("mcp--jira--search")
		expect(result.deferredCatalog).toBeUndefined()
	})

	it("with deferredTools experiment ON drops MCP schemas and exposes the catalog", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider: makeProvider({}),
			cwd: "/tmp",
			mode: "code",
			customModes: undefined,
			experiments: { deferredTools: true },
			apiConfiguration: undefined,
		})
		const names = result.tools.map((t) => (t as OpenAI.Chat.ChatCompletionFunctionTool).function.name)
		// Native + tools_load still present
		expect(names).toContain("read_file")
		expect(names).toContain("tools_load")
		// MCP schemas removed
		expect(names).not.toContain("mcp--weather--get_current")
		expect(names).not.toContain("mcp--jira--search")
		// Catalog populated
		expect(result.deferredCatalog).toBeDefined()
		expect(result.deferredCatalog?.entries.length).toBe(3)
	})

	it("re-expands materialized deferred tools when a Task already loaded them", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider: makeProvider({}),
			cwd: "/tmp",
			mode: "code",
			customModes: undefined,
			experiments: { deferredTools: true },
			apiConfiguration: undefined,
			materializedDeferredTools: new Set(["mcp--weather--get_current"]),
		})
		const names = result.tools.map((t) => (t as OpenAI.Chat.ChatCompletionFunctionTool).function.name)
		// The materialized one is now active
		expect(names).toContain("mcp--weather--get_current")
		// The others are still deferred
		expect(names).not.toContain("mcp--weather--get_forecast")
		expect(names).not.toContain("mcp--jira--search")
		expect(result.deferredCatalog?.entries.length).toBe(2)
	})

	it("with includeAllToolsWithRestrictions=true keeps deferred tool names in allowedFunctionNames", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider: makeProvider({}),
			cwd: "/tmp",
			mode: "code",
			customModes: undefined,
			experiments: { deferredTools: true },
			apiConfiguration: undefined,
			includeAllToolsWithRestrictions: true,
		})
		// allowedFunctionNames must include the deferred MCP names so the
		// Gemini path can still let the model call them once materialized.
		expect(result.allowedFunctionNames).toContain("mcp--weather--get_current")
		expect(result.allowedFunctionNames).toContain("mcp--jira--search")
	})
})
