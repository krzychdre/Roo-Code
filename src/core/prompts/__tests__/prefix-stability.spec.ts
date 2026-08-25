// npx vitest run src/core/prompts/__tests__/prefix-stability.spec.ts
//
// WS-F: the system prompt has to be KV-cache friendly.
//
// A provider that caches by prompt prefix (llama.cpp locally, Z.ai/GLM and
// DeepSeek-style prefix caches remotely) reuses a cached request only up to the
// first byte that differs. Two properties are therefore load-bearing and are
// asserted here against the REAL assembly, never a stub:
//
//  1. BYTE STABILITY: the same inputs produce byte-identical output, so nothing
//     volatile (a timestamp, a Map iteration order, a locale-dependent sort)
//     leaks into the prompt.
//  2. COMMON-PREFIX MAXIMIZATION: two modes on the same workspace share the
//     whole stable head, so a mode switch does not re-prefill from token 1.

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

// The modes list needs the extension's settings directory; stub it to a fixed
// string so this file measures prompt ORDER, not the tester's mode inventory.
vi.mock("../sections/modes", () => ({
	getModesSection: vi.fn().mockImplementation(async () => "====\n\nMODES\n\n- Test modes section"),
}))

// Memory reads MEMORY.md from the user's real home directory. Fixed bodies keep
// the numbers below reproducible on any machine.
//
// The two stubs are spelled out twice on purpose: `vi.mock` factories are
// hoisted above every const in this file, so the factory below cannot reference
// these names. The copies here are what the assertions locate in the built
// prompt; keep the two in step if either is edited. The index stub is stored
// trimmed, because the assembly trims every section before joining it.
const MEMORY_BODY_STUB = "# auto memory\n\nMemory behavioral body."
const MEMORY_INDEX_STUB = "Contents of MEMORY.md:\n\n- [Entry](file.md)"

vi.mock("../sections/memory", () => ({
	getMemorySection: vi.fn().mockResolvedValue("# auto memory\n\nMemory behavioral body."),
	getMemoryIndexSection: vi.fn().mockResolvedValue("\nContents of MEMORY.md:\n\n- [Entry](file.md)"),
}))

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
import { SYSTEM_PROMPT, STABLE_PROMPT_OPENER } from "../system"
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

/** Two servers, each with a tool and a resource, so every MCP prompt path has something to say. */
const mcpHubWithServers = {
	getServers: () => [
		{
			name: "docs-server",
			disabled: false,
			resources: [{ uri: "docs://index", name: "Docs index" }],
			tools: [{ name: "lookup", description: "Look a symbol up.", inputSchema: { type: "object" } }],
		},
		{
			name: "build-server",
			disabled: false,
			resources: [],
			tools: [{ name: "compile", description: "Compile the project.", inputSchema: { type: "object" } }],
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

/**
 * The modes whose prompts must share the stable head.
 *
 * Orchestrator is in the list on purpose: it is the ONLY built-in mode here
 * without the `mcp` group, so a code-to-orchestrator switch is the real worst
 * case (the two prompts part company at the MCP SERVERS section, the first
 * entry of the variable tail). Leaving it out would have measured a shared
 * prefix that no orchestrator flow ever gets.
 */
const MODES = ["code", "architect", "ask", "debug", "orchestrator"] as const

async function buildPrompt(
	mode: string,
	settings: SystemPromptSettings = baseSettings,
	mcpHub: McpHub | undefined = mcpHubWithServers,
	experiments: Record<string, boolean> = {},
): Promise<string> {
	return SYSTEM_PROMPT(
		mockContext,
		"/test/path",
		false,
		mcpHub,
		undefined,
		mode as never,
		undefined,
		undefined,
		undefined,
		experiments,
		"en",
		undefined,
		settings,
	)
}

function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length)
	let i = 0
	while (i < max && a[i] === b[i]) {
		i++
	}
	return i
}

/**
 * Markers for the stable head, in the order they must appear. Every one of them
 * is mode-independent; anything mode-dependent belongs after them.
 */
const STABLE_HEAD_MARKERS = [
	STABLE_PROMPT_OPENER,
	"====\n\nMARKDOWN RULES",
	"====\n\nTOOL USE",
	"# Tool Use Guidelines",
	"# Output Efficiency",
	"====\n\nOBJECTIVE",
	"====\n\nCAPABILITIES",
	"====\n\nSYSTEM INFORMATION",
	MEMORY_BODY_STUB,
	MEMORY_INDEX_STUB,
]

/** Markers for the variable tail, in the order they must appear. */
const VARIABLE_TAIL_MARKERS = [
	"====\n\nMCP SERVERS",
	"====\n\nMODES",
	"====\n\nRULES",
	"====\n\nMODE\n\n",
	"====\n\nUSER'S CUSTOM INSTRUCTIONS",
]

describe("system prompt byte stability", () => {
	it.each(MODES)("builds byte-identical prompts twice for %s mode", async (mode) => {
		const first = await buildPrompt(mode)
		const second = await buildPrompt(mode)

		// strictEqual, not toEqual: one differing byte is a cache miss.
		expect(second).toStrictEqual(first)
	})

	it.each(MODES)("builds byte-identical prompts twice for %s mode with the slim toolset on", async (mode) => {
		const slim: SystemPromptSettings = { ...baseSettings, slimToolset: true }
		const first = await buildPrompt(mode, slim)
		const second = await buildPrompt(mode, slim)

		expect(second).toStrictEqual(first)
	})

	it("keeps the two slim settings apart while each stays stable", async () => {
		const slimOn = await buildPrompt("code", { ...baseSettings, slimToolset: true })
		const slimOff = await buildPrompt("code", { ...baseSettings, slimToolset: false })

		// Each build is reproducible...
		expect(await buildPrompt("code", { ...baseSettings, slimToolset: true })).toStrictEqual(slimOn)
		expect(await buildPrompt("code", { ...baseSettings, slimToolset: false })).toStrictEqual(slimOff)

		// ...and the slim profile really does drop the MCP text, so the two are
		// not accidentally the same string (which would make this test vacuous).
		expect(slimOn).not.toEqual(slimOff)
		expect(slimOn).not.toContain("MCP servers")
		expect(slimOff).toContain("MCP servers")
	})

	it("puts the whole stable head before the first byte that varies", async () => {
		const slimOn = await buildPrompt("code", { ...baseSettings, slimToolset: true })
		const slimOff = await buildPrompt("code", { ...baseSettings, slimToolset: false })

		const shared = slimOn.slice(0, commonPrefixLength(slimOn, slimOff))

		for (const marker of STABLE_HEAD_MARKERS) {
			expect(shared).toContain(marker)
		}
	})
})

describe("system prompt common prefix across modes", () => {
	/**
	 * Floor for the prefix two different modes share, in bytes, MEASURED WITH AN
	 * MCP HUB CONNECTED, which is what `buildPrompt` does by default.
	 *
	 * The hub matters. Without one, the five modes here share 11684 bytes,
	 * because MCP SERVERS is empty for all of them and the shared region runs on
	 * through MODES and RULES. With a hub connected the worst pair is
	 * code vs orchestrator: orchestrator has no `mcp` group, so the two prompts
	 * part company at the MCP SERVERS section and share 8252 bytes, which is the
	 * stable head (8243) plus its trailing separator. That worst case is the
	 * number this floor guards, because it is the one an orchestrator flow
	 * actually pays. Before WS-F the same measurement gave 17 bytes.
	 *
	 * HOW TO UPDATE THIS NUMBER LEGITIMATELY: it may only ever go UP, unless a PR
	 * deliberately shortens a stable-head section (deleting text, moving a section
	 * into the tail because it turned out to be mode-dependent). Lowering it
	 * because "the test broke" hides exactly the regression this file exists to
	 * catch: something mode-dependent creeping into the head. The gap between the
	 * floor and the measured 8252 is there so ordinary edits to head TEXT (a
	 * reworded rule) do not fail the suite.
	 */
	const MIN_SHARED_PREFIX_BYTES = 8000

	it("shares at least the stable head between every pair of modes", async () => {
		const prompts = new Map<string, string>()
		for (const mode of MODES) {
			prompts.set(mode, await buildPrompt(mode))
		}

		for (const mode of MODES) {
			expect(prompts.get(mode)!.startsWith(STABLE_PROMPT_OPENER)).toBe(true)
		}

		for (let i = 0; i < MODES.length; i++) {
			for (let j = i + 1; j < MODES.length; j++) {
				const a = prompts.get(MODES[i])!
				const b = prompts.get(MODES[j])!
				const shared = commonPrefixLength(a, b)

				expect(shared).toBeGreaterThanOrEqual(MIN_SHARED_PREFIX_BYTES)

				// The contractual assertion: the shared region covers the whole
				// stable head, computed from where the head's last section (the
				// memory index) ends rather than from a hardcoded offset.
				const headEnd = a.indexOf(MEMORY_INDEX_STUB) + MEMORY_INDEX_STUB.length
				expect(headEnd).toBeGreaterThan(0)
				expect(shared).toBeGreaterThanOrEqual(headEnd)

				// ...and every head section really is inside it.
				const sharedText = a.slice(0, shared)
				for (const marker of STABLE_HEAD_MARKERS) {
					expect(sharedText).toContain(marker)
				}

				// The prompts do eventually diverge: without this the pair could
				// be identical and the assertions above would be vacuous.
				expect(shared).toBeLessThan(Math.min(a.length, b.length))
			}
		}
	})

	it("shares more than the head between modes that agree about MCP", async () => {
		// Control for the test above: the 8252-byte worst case is caused by the
		// MCP group difference, not by the head being short. Two modes that both
		// carry the `mcp` group keep sharing well past it.
		const code = await buildPrompt("code")
		const debug = await buildPrompt("debug")
		const shared = commonPrefixLength(code, debug)

		expect(shared).toBeGreaterThan(code.indexOf("====\n\nRULES"))
	})
})

describe("system prompt section order", () => {
	it("emits every stable-head section before every variable-tail section", async () => {
		const prompt = await buildPrompt("code")

		const headIndexes = STABLE_HEAD_MARKERS.map((marker) => {
			const index = prompt.indexOf(marker)
			expect(index, `stable-head marker missing: ${marker}`).toBeGreaterThan(-1)
			return index
		})
		const tailIndexes = VARIABLE_TAIL_MARKERS.map((marker) => {
			const index = prompt.indexOf(marker)
			expect(index, `variable-tail marker missing: ${marker}`).toBeGreaterThan(-1)
			return index
		})

		// Head sections in the documented order.
		for (let i = 1; i < headIndexes.length; i++) {
			expect(headIndexes[i]).toBeGreaterThan(headIndexes[i - 1])
		}

		// Tail sections in the documented order.
		for (let i = 1; i < tailIndexes.length; i++) {
			expect(tailIndexes[i]).toBeGreaterThan(tailIndexes[i - 1])
		}

		// No tail section may start before the head has finished.
		expect(Math.min(...tailIndexes)).toBeGreaterThan(Math.max(...headIndexes))
	})

	it("puts the deferred-tools catalog last of all", async () => {
		// The catalog is the only section that shrinks WITHIN a conversation:
		// every `tools_load` materialization removes an entry. Anything printed
		// after it would be re-prefilled on the next request, so nothing may be.
		const prompt = await buildPrompt("code", baseSettings, mcpHubWithServers, { deferredTools: true })

		const catalogIndex = prompt.indexOf("# Deferred tools (load on demand)")
		expect(catalogIndex).toBeGreaterThan(-1)

		for (const marker of [...STABLE_HEAD_MARKERS, ...VARIABLE_TAIL_MARKERS]) {
			expect(prompt.indexOf(marker), `section printed after the catalog: ${marker}`).toBeLessThan(catalogIndex)
		}
	})

	it("matches the canonical full-prompt snapshot", async () => {
		// Regression guard: an accidental reorder shows up as a reviewable diff.
		// Regenerate with `npx vitest run -u src/core/prompts/__tests__/prefix-stability.spec.ts`
		// and state the KV-cache effect of the change in the commit message.
		const prompt = await buildPrompt("code")

		await expect(prompt).toMatchFileSnapshot("./__snapshots__/prefix-stability/canonical-code-prompt.snap")
	})
})

describe("MCP server ordering is independent of connection order", () => {
	/**
	 * `McpHub.getServers()` returns connection order, and a server that
	 * reconnects (config edit, file watcher, manual restart) is deleted and
	 * re-appended, so it jumps to the end. Both the prompt and the advertised
	 * tools array must be blind to that.
	 */
	const serverA = {
		name: "alpha-server",
		disabled: false,
		resources: [{ uri: "alpha://index", name: "Alpha index" }],
		tools: [{ name: "ping", description: "Ping alpha.", inputSchema: { type: "object" } }],
	}
	const serverB = {
		name: "zeta-server",
		disabled: false,
		resources: [{ uri: "zeta://index", name: "Zeta index" }],
		tools: [{ name: "scan", description: "Scan zeta.", inputSchema: { type: "object" } }],
	}

	const hubReturning = (servers: unknown[]) =>
		({
			getServers: () => servers,
			isConnecting: false,
			dispose: async () => {},
		}) as unknown as McpHub

	const forwardHub = hubReturning([serverA, serverB])
	const reversedHub = hubReturning([serverB, serverA])

	it("builds the same prompt whichever order the hub lists its servers in", async () => {
		// `deferredTools` on, so the catalog actually names the servers: with it
		// off the prompt mentions no server at all and the test would be vacuous.
		const forward = await buildPrompt("code", baseSettings, forwardHub, { deferredTools: true })
		const reversed = await buildPrompt("code", baseSettings, reversedHub, { deferredTools: true })

		expect(reversed).toStrictEqual(forward)
		expect(forward).toContain("alpha-server")
		expect(forward).toContain("zeta-server")
	})

	it("advertises the same tools array whichever order the hub lists its servers in", async () => {
		const namesFor = async (hub: McpHub): Promise<string[]> => {
			const provider = { getMcpHub: () => hub, context: {} as unknown } as unknown as ClineProvider
			const result = await buildNativeToolsArrayWithRestrictions({
				provider,
				cwd: "/test/path",
				mode: "code",
				customModes: undefined,
				experiments: {},
				apiConfiguration: { apiProvider: "openai" },
				webToolsEnabled: true,
			})
			return result.tools.map((tool) => (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name)
		}

		const forward = await namesFor(forwardHub)
		const reversed = await namesFor(reversedHub)

		expect(reversed).toEqual(forward)
		// Not vacuous: both servers really are advertised, alpha before zeta.
		const alphaIndex = forward.findIndex((name) => name.includes("alpha-server"))
		const zetaIndex = forward.findIndex((name) => name.includes("zeta-server"))
		expect(alphaIndex).toBeGreaterThan(-1)
		expect(zetaIndex).toBeGreaterThan(alphaIndex)
	})
})

describe("advertised tool array order", () => {
	/**
	 * The tools array is part of the request prefix for providers that cache tool
	 * schemas, so its order must be a pure function of the configuration too.
	 */
	async function buildToolNames(apiConfiguration: ProviderSettings, mode = "code"): Promise<string[]> {
		const provider = {
			getMcpHub: () => mcpHubWithServers,
			context: {} as unknown,
		} as unknown as ClineProvider

		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/test/path",
			mode,
			customModes: undefined,
			experiments: {},
			apiConfiguration,
			webToolsEnabled: true,
		})

		return result.tools.map((tool) => (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name)
	}

	it("advertises the same tools in the same order for a fixed config", async () => {
		const first = await buildToolNames({ apiProvider: "openai" })
		const second = await buildToolNames({ apiProvider: "openai" })

		expect(second).toEqual(first)
		// Not vacuous: the array really carries the native tools and both MCP servers.
		expect(first).toContain("read_file")
		expect(first.filter((name) => name.includes("docs-server")).length).toBe(1)
		expect(first.filter((name) => name.includes("build-server")).length).toBe(1)
	})

	it("advertises the same tools in the same order for a fixed slim config", async () => {
		const first = await buildToolNames({ apiProvider: "openai", slimToolset: true })
		const second = await buildToolNames({ apiProvider: "openai", slimToolset: true })

		expect(second).toEqual(first)
		expect(first.some((name) => name.includes("docs-server"))).toBe(false)
	})
})
