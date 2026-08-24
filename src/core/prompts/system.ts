import * as vscode from "vscode"

import { type ModeConfig, type PromptComponent, type CustomModePrompts, type TodoItem } from "@roo-code/types"

import { Mode, modes, defaultModeSlug, getModeBySlug, getGroupName, getModeSelection } from "../../shared/modes"
import { DiffStrategy } from "../../shared/tools"
import { formatLanguage } from "../../shared/language"
import { isEmpty } from "../../utils/object"

import { McpHub } from "../../services/mcp/McpHub"
import { CodeIndexManager } from "../../services/code-index/manager"
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
	getModesSection,
	addCustomInstructions,
	markdownFormattingSection,
	getSkillsSection,
	getDeferredToolsSection,
	getMemorySection,
	getMemoryIndexSection,
} from "./sections"

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

	const codeIndexManager = CodeIndexManager.getInstance(context, cwd)

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

	// Memory system: the behavioral section (what/when/how to save) is injected
	// between the rules and system-info sections; the truncated MEMORY.md index
	// is appended after custom instructions so memory stays orthogonal to mode
	// rules. Both read from disk and return "" when memory is disabled.
	const [memorySection, memoryIndex] = await Promise.all([getMemorySection(cwd), getMemoryIndexSection(cwd)])

	const basePrompt = `${roleDefinition}

${markdownFormattingSection()}

${getSharedToolUseSection()}${toolsCatalog}

	${getToolUseGuidelinesSection()}

${getOutputEfficiencySection()}

${
	// Forward the hub only when the mode actually exposes the MCP group, and pass the per-mode
	// allowlist through so the capabilities section filters servers using the SAME convention as
	// the tool-listing layer (a single source of truth for which servers are visible).
	getCapabilitiesSection(cwd, hasMcpGroup ? mcpHub : undefined, allowedMcpServers)
}
${deferredToolsSection ? `\n${deferredToolsSection}\n` : ""}
${modesSection}
${skillsSection ? `\n${skillsSection}` : ""}
${getRulesSection(cwd, settings)}
${memorySection ? `\n\n${memorySection}\n` : ""}
${getSystemInfoSection(cwd)}

${getObjectiveSection()}

${await addCustomInstructions(baseInstructions, globalCustomInstructions || "", cwd, mode, {
	language: language ?? formatLanguage(vscode.env.language),
	rooIgnoreInstructions,
	settings,
})}${memoryIndex}`

	return basePrompt
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
