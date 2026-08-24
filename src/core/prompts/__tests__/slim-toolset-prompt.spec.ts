// npx vitest run src/core/prompts/__tests__/slim-toolset-prompt.spec.ts

vi.mock("os", () => {
	const os = {
		homedir: () => "/home/user",
		platform: () => "linux",
		arch: () => "x64",
		type: () => "Linux",
		release: () => "5.4.0",
		hostname: () => "test-host",
		tmpdir: () => "/tmp",
		endianness: () => "LE",
		loadavg: () => [0, 0, 0],
		totalmem: () => 8589934592,
		freemem: () => 4294967296,
		cpus: () => [],
		networkInterfaces: () => ({}),
		userInfo: () => ({ username: "test", uid: 1000, gid: 1000, shell: "/bin/bash", homedir: "/home/user" }),
	}
	return { default: os, ...os }
})

vi.mock("default-shell", () => ({ default: "/bin/zsh" }))
vi.mock("os-name", () => ({ default: () => "Linux" }))
vi.mock("../../../utils/shell", () => ({ getShell: () => "/bin/zsh" }))

vi.mock("vscode", () => ({
	env: { language: "en" },
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/test/path" } }],
		getWorkspaceFolder: vi.fn().mockReturnValue({ uri: { fsPath: "/test/path" } }),
	},
	window: { activeTextEditor: undefined },
	EventEmitter: vi.fn().mockImplementation(() => ({ event: vi.fn(), fire: vi.fn(), dispose: vi.fn() })),
}))

vi.mock("../sections/modes", () => ({
	getModesSection: vi.fn().mockImplementation(async () => "====\n\nMODES\n\n- Test modes section"),
}))

vi.mock("../sections/custom-instructions", () => ({
	addCustomInstructions: vi.fn().mockResolvedValue(""),
}))

vi.mock("../sections/memory", () => ({
	getMemorySection: vi.fn().mockResolvedValue(""),
	getMemoryIndexSection: vi.fn().mockResolvedValue(""),
}))

// The advertised tools array is built here too, from the SAME flags, because the
// prompt text alone cannot prove the feature works: the system prompt carries no
// tool catalog (see `toolsCatalog` in system.ts), so a name-absence assertion
// against the prompt string passes even with the feature deleted.
vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: vi.fn(() => ({
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			isInitialized: true,
		})),
	},
}))

import type OpenAI from "openai"
import type * as vscode from "vscode"

import type { ProviderSettings } from "@roo-code/types"

import type { McpHub } from "../../../services/mcp/McpHub"
import type { ClineProvider } from "../../webview/ClineProvider"
import { buildNativeToolsArrayWithRestrictions } from "../../task/build-tools"
import { SYSTEM_PROMPT } from "../system"
import type { SystemPromptSettings } from "../types"

const mockContext = {
	extensionPath: "/mock/extension/path",
	globalStoragePath: "/mock/storage/path",
	subscriptions: [],
	workspaceState: { get: () => undefined, update: () => Promise.resolve() },
	globalState: { get: () => undefined, update: () => Promise.resolve(), setKeysForSync: () => {} },
	extensionUri: { fsPath: "/mock/extension/path" },
	globalStorageUri: { fsPath: "/mock/settings/path" },
	asAbsolutePath: (relativePath: string) => `/mock/extension/path/${relativePath}`,
	extension: { packageJSON: { version: "1.0.0" } },
} as unknown as vscode.ExtensionContext

/** MCP hub with one connected server exposing one tool, so every MCP prompt path has something to say. */
const mcpHubWithServer = {
	getServers: () => [
		{
			name: "docs-server",
			disabled: false,
			resources: [{ uri: "docs://index", name: "Docs index" }],
			tools: [{ name: "lookup", description: "Look a symbol up.", inputSchema: { type: "object" } }],
		},
	],
	isConnecting: false,
	dispose: async () => {},
} as unknown as McpHub

const baseSettings: SystemPromptSettings = {
	todoListEnabled: true,
	useAgentRules: false,
	newTaskRequireTodos: false,
}

async function buildPrompt(settings: SystemPromptSettings): Promise<string> {
	return SYSTEM_PROMPT(
		mockContext,
		"/test/path",
		false,
		mcpHubWithServer,
		undefined,
		"code",
		undefined,
		undefined,
		undefined,
		{ deferredTools: true },
		"en",
		undefined,
		settings,
	)
}

/**
 * The tools array the same profile would send with the same flags. The prompt
 * and the tool array are two halves of one request, so both are checked against
 * one settings object.
 */
async function buildAdvertisedToolNames(apiConfiguration: ProviderSettings): Promise<string[]> {
	const provider = {
		getMcpHub: () => mcpHubWithServer,
		context: {} as unknown,
	} as unknown as ClineProvider

	const result = await buildNativeToolsArrayWithRestrictions({
		provider,
		cwd: "/test/path",
		mode: "code",
		customModes: undefined,
		experiments: { runSlashCommand: true, imageGeneration: true },
		apiConfiguration,
		// Opt every alternative edit verb in, so the full profile really does
		// advertise them and the slim comparison is not vacuous.
		modelInfo: { includedTools: ["edit", "search_replace", "edit_file", "apply_patch"] } as any,
		webToolsEnabled: true,
	})

	return result.tools.map((tool) => (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name)
}

describe("system prompt - slim toolset", () => {
	it("mentions no MCP server anywhere for a slim profile (default: MCP hidden)", async () => {
		const prompt = await buildPrompt({ ...baseSettings, slimToolset: true })

		// Capabilities MCP line and the deferred-tools catalog both go away,
		// because the tool array no longer carries a single MCP schema.
		expect(prompt).not.toContain("MCP servers")
		expect(prompt).not.toContain("docs-server")
		expect(prompt).not.toContain("lookup")
	})

	it("keeps the MCP prompt sections when the slim profile leaves MCP alone", async () => {
		const prompt = await buildPrompt({ ...baseSettings, slimToolset: true, slimHidesMcp: false })

		expect(prompt).toContain("MCP servers")
		expect(prompt).toContain("docs-server")
	})

	it("keeps the MCP prompt sections for a normal profile", async () => {
		const withoutFlags = await buildPrompt(baseSettings)
		const withSlimOff = await buildPrompt({ ...baseSettings, slimToolset: false, slimHidesMcp: true })

		expect(withoutFlags).toContain("MCP servers")
		// slimHidesMcp is inert while slimToolset is off, so the prompt is byte-identical.
		expect(withSlimOff).toBe(withoutFlags)
	})

	it("advertises no hidden tool for the same settings the prompt was built from", async () => {
		// Asserting the hidden names are missing from the prompt STRING proves
		// nothing: the system prompt carries no tool catalog, so those names are
		// absent for a full profile too. The load-bearing assertion is against the
		// tools array the model actually receives.
		const hiddenTools = [
			"edit_file",
			"apply_patch",
			"search_replace",
			"edit",
			"generate_image",
			"run_parallel_tasks",
			"run_slash_command",
			"access_mcp_resource",
		]

		const slim = await buildAdvertisedToolNames({ apiProvider: "openai", slimToolset: true })
		const full = await buildAdvertisedToolNames({ apiProvider: "openai" })

		for (const hiddenTool of hiddenTools) {
			expect(slim).not.toContain(hiddenTool)
			expect(full).toContain(hiddenTool)
		}

		// No MCP schema either, matching the prompt having no MCP section.
		expect(slim.some((name) => name.includes("docs-server"))).toBe(false)
		expect(full.some((name) => name.includes("docs-server"))).toBe(true)

		// The tools it may use are still there.
		expect(slim).toContain("execute_command")
		expect(slim).toContain("list_files")
		expect(slim).toContain("apply_diff")
	})
})
