import * as vscode from "vscode"

import { type ModeConfig, type PromptComponent, type CustomModePrompts, type TodoItem } from "@roo-code/types"

import { Mode, modes, defaultModeSlug, getModeBySlug, getGroupName, getModeSelection } from "../../shared/modes"
import { DiffStrategy } from "../../shared/tools"
import { formatLanguage } from "../../shared/language"
import { isEmpty } from "../../utils/object"

import { McpHub } from "../../services/mcp/McpHub"
import { SkillsManager } from "../../services/skills/SkillsManager"

import type { SystemPromptSettings } from "./types"
import { slimToolsetHidesMcp } from "./tools/filter-tools-for-mode"
import {
	getRulesSection,
	getSystemInfoSection,
	getObjectiveSection,
	getSharedToolUseSection,
	getToolUseGuidelinesSection,
	getOutputEfficiencySection,
	getCapabilitiesSection,
	getMcpAvailabilitySection,
	getModesSection,
	addCustomInstructions,
	markdownFormattingSection,
	getSkillsSection,
	getDeferredToolsSection,
	getMemorySection,
	getMemoryIndexSection,
} from "./sections"

/**
 * The first bytes of every system prompt, in every mode, for every profile.
 *
 * Providers that cache by prompt prefix (llama.cpp locally, Z.ai/GLM and
 * DeepSeek-style prefix caches remotely) reuse a request's KV cache only up to
 * the first byte that differs. The mode's `roleDefinition` used to open the
 * prompt, so switching mode invalidated the cache from token 1. This opener is
 * a constant, and it names the sections where the mode's role and the mode's
 * rules really live, so a weak model still knows who it is and what it must do:
 * the pointer is load-bearing, not decorative.
 *
 * Both destinations are named on purpose. The MODE section carries only the
 * role definition; the mode's actual rulebook (a mode's `customInstructions`,
 * for example the orchestrator's delegation protocol) renders further down as
 * the "Mode-specific Instructions" block inside USER'S CUSTOM INSTRUCTIONS. A
 * pointer that named only the MODE section would send a weak model to two
 * sentences of persona and leave it reading its own protocol as a user's wish.
 *
 * Change this only with the "one-time prefix invalidation" note in the commit.
 */
export const STABLE_PROMPT_OPENER = `You are Tumble Code, an AI coding agent. Your mode is defined at the end of this prompt and both parts of it are binding on you: the MODE section states your role, and the "Mode-specific Instructions" block inside USER'S CUSTOM INSTRUCTIONS states the rules you must follow in that mode.`

/**
 * Wrap the mode's role definition in the MODE section the opener points at.
 *
 * Returns "" for an empty role definition so the join drops the header rather
 * than emitting a section with no body.
 */
export function getModeSection(roleDefinition: string): string {
	const trimmed = roleDefinition?.trim() ?? ""
	if (!trimmed) {
		return ""
	}
	return `====

MODE

${trimmed}`
}

// Helper function to get prompt component, filtering out empty objects
export function getPromptComponent(
	customModePrompts: CustomModePrompts | undefined,
	mode: string,
): PromptComponent | undefined {
	const component = customModePrompts?.[mode]
	// Return undefined if component is empty
	if (isEmpty(component)) {
		return undefined
	}
	return component
}

async function generatePrompt(
	context: vscode.ExtensionContext,
	cwd: string,
	supportsComputerUse: boolean,
	mode: Mode,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	promptComponent?: PromptComponent,
	customModeConfigs?: ModeConfig[],
	globalCustomInstructions?: string,
	experiments?: Record<string, boolean>,
	language?: string,
	rooIgnoreInstructions?: string,
	settings?: SystemPromptSettings,
	todoList?: TodoItem[],
	modelId?: string,
	skillsManager?: SkillsManager,
	materializedDeferredTools?: ReadonlySet<string>,
): Promise<string> {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	// Get the full mode config to ensure we have the role definition (used for groups, etc.)
	const modeConfig = getModeBySlug(mode, customModeConfigs) || modes.find((m) => m.slug === mode) || modes[0]
	const { roleDefinition, baseInstructions } = getModeSelection(mode, promptComponent, customModeConfigs)

	// Check if MCP functionality should be included.
	// A slim profile that hides MCP removes the tool schemas from the request, so
	// every MCP mention in the prompt has to disappear with them: the tool filter
	// (`slimToolsetHidesMcp`) is the single source of truth for that decision.
	const mcpHiddenBySlimToolset = slimToolsetHidesMcp(settings)
	const hasMcpGroup =
		!mcpHiddenBySlimToolset && modeConfig.groups.some((groupEntry) => getGroupName(groupEntry) === "mcp")
	// Resolve the per-mode MCP allowlist. For built-in modes the allowlist lives in the prompt
	// override (promptComponent, already resolved for this mode); custom modes carry it on the
	// ModeConfig. The override wins when present (matches getModeAllowedMcpServers precedence).
	const allowedMcpServers = promptComponent?.allowedMcpServers ?? modeConfig.allowedMcpServers

	// Hoist the allowlist Set once (matches the sibling call sites, e.g. mcp_server.ts) instead
	// of constructing a new Set on every `.filter` iteration.
	const allowSet = allowedMcpServers ? new Set(allowedMcpServers) : undefined

	let hasMcpServers = false
	if (mcpHub) {
		const servers = allowSet ? mcpHub.getServers().filter((s) => allowSet.has(s.name)) : mcpHub.getServers()
		hasMcpServers = servers.length > 0
	}
	const shouldIncludeMcp = hasMcpGroup && hasMcpServers

	// Tool calling is native-only.
	const effectiveProtocol = "native"

	const [modesSection, skillsSection] = await Promise.all([
		getModesSection(context),
		getSkillsSection(skillsManager, mode as string),
	])

	// Tools catalog is not included in the system prompt.
	const toolsCatalog = ""

	const deferredToolsSection = getDeferredToolsSection({
		experiments,
		mcpHub: shouldIncludeMcp ? mcpHub : undefined,
		// Forward the allowlist so the deferred catalog honors the per-mode restriction; otherwise a
		// restricted mode would still advertise every server's tools when deferredTools is enabled.
		allowedMcpServers,
		// Note: custom tools advertised in this section would need the
		// CustomToolRegistry — gated behind the `customTools` experiment.
		// For v1 we only advertise MCP tools in the catalog; custom tools
		// are still deferred at the API layer but discovered by name via
		// the existing skill/custom-tool flow if the user has them enabled.
		customTools: [],
		materializedDeferredTools,
	})

	// Memory system: the behavioral section (what/when/how to save) and the
	// truncated MEMORY.md index. Both are workspace-scoped and mode-independent,
	// so they close the stable head (WS-F sections 7). Both read from disk and
	// return "" when memory is disabled.
	const [memorySection, memoryIndex] = await Promise.all([getMemorySection(cwd), getMemoryIndexSection(cwd)])

	const customInstructionsSection = await addCustomInstructions(
		baseInstructions,
		globalCustomInstructions || "",
		cwd,
		mode,
		{
			language: language ?? formatLanguage(vscode.env.language),
			rooIgnoreInstructions,
			settings,
		},
	)

	// ------------------------------------------------------------------
	// STABLE HEAD (WS-F sections 1-7).
	//
	// Every byte here is identical for every mode and every profile on this
	// workspace and machine, so a provider that caches by prompt prefix keeps
	// its cache across mode switches instead of re-prefilling from token 1.
	// Nothing that varies with the mode, the model, or the request may be
	// added to this list; see CONTRIBUTING.md, "KV-cache contract".
	// ------------------------------------------------------------------
	const stableHead: string[] = [
		// 1. Identity, byte-identical everywhere, pointing at the MODE section.
		STABLE_PROMPT_OPENER,
		// 2. Formatting rules.
		markdownFormattingSection(),
		// 3. Tool-use protocol boilerplate. `toolsCatalog` is always "" (the
		//    catalog is carried by the native tools array, not by the prompt).
		getSharedToolUseSection() + toolsCatalog,
		getToolUseGuidelinesSection(),
		// 4. Conciseness steering.
		getOutputEfficiencySection(),
		// 5. The loop's objective. Constant text, no inputs at all.
		getObjectiveSection(),
		// 6. Capabilities and machine facts. Vary with the workspace and the
		//    machine, never with the mode, so they still share across modes.
		getCapabilitiesSection(cwd),
		getSystemInfoSection(cwd),
		// 7. Memory: behavioral instructions plus the MEMORY.md index. Both are
		//    mode-independent, which is why they sit at the end of the head
		//    rather than in the tail: a mode switch keeps them cached. The cost
		//    is that writing a memory mid-task invalidates the tail after them.
		memorySection,
		memoryIndex,
	]

	// ------------------------------------------------------------------
	// VARIABLE TAIL (WS-F section 8).
	//
	// Everything whose bytes depend on the mode, the profile or the model.
	// Ordered so the pieces that change least often come first.
	// ------------------------------------------------------------------
	const variableTail: string[] = [
		// Per-mode: depends on the mode's MCP group and its server allowlist.
		// The hub is forwarded only when the mode exposes the MCP group, and the
		// allowlist goes with it, so this text follows the SAME convention as the
		// tool-listing layer (one source of truth for which servers are visible).
		getMcpAvailabilitySection(hasMcpGroup ? mcpHub : undefined, allowedMcpServers),
		// Per-settings: the list of installed modes.
		modesSection,
		// Per-mode: skills are filtered by the current mode.
		skillsSection,
		// Per-workspace and per-profile (shell, cwd, stealth-model flag).
		getRulesSection(cwd, settings),
		// Per-mode: the role the opener points at.
		getModeSection(roleDefinition),
		// Per-mode and per-user: language, global and mode instructions, rules files.
		customInstructionsSection,
		// LAST on purpose. This is the only section that mutates WITHIN a
		// conversation: every `tools_load` materialization drops an entry from the
		// catalog, so anything printed after it would be re-prefilled on the next
		// request. Nothing follows it, so the invalidation costs its own bytes and
		// no more. Being last also gives the two-step `tools_load` procedure the
		// recency a weak model needs to actually follow it.
		deferredToolsSection,
	]

	// One canonical separator between sections, and empty sections drop out
	// entirely. Building the prompt by join instead of by template literal is
	// what makes an absent optional section cost zero bytes rather than a
	// varying run of blank lines.
	return (
		[...stableHead, ...variableTail]
			// The nullish guard is deliberate: a section builder that returns nothing
			// (a disabled feature, a stubbed dependency) must drop out of the prompt,
			// never render the word "undefined" into it, which is what the previous
			// template-literal assembly did.
			.map((section) => (section ?? "").trim())
			.filter((section) => section.length > 0)
			.join("\n\n")
	)
}

export const SYSTEM_PROMPT = async (
	context: vscode.ExtensionContext,
	cwd: string,
	supportsComputerUse: boolean,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	mode: Mode = defaultModeSlug,
	customModePrompts?: CustomModePrompts,
	customModes?: ModeConfig[],
	globalCustomInstructions?: string,
	experiments?: Record<string, boolean>,
	language?: string,
	rooIgnoreInstructions?: string,
	settings?: SystemPromptSettings,
	todoList?: TodoItem[],
	modelId?: string,
	skillsManager?: SkillsManager,
	materializedDeferredTools?: ReadonlySet<string>,
): Promise<string> => {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	// Check if it's a custom mode
	const promptComponent = getPromptComponent(customModePrompts, mode)

	// Get full mode config from custom modes or fall back to built-in modes
	const currentMode = getModeBySlug(mode, customModes) || modes.find((m) => m.slug === mode) || modes[0]

	return generatePrompt(
		context,
		cwd,
		supportsComputerUse,
		currentMode.slug,
		mcpHub,
		diffStrategy,
		promptComponent,
		customModes,
		globalCustomInstructions,
		experiments,
		language,
		rooIgnoreInstructions,
		settings,
		todoList,
		modelId,
		skillsManager,
		materializedDeferredTools,
	)
}
