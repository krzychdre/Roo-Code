import path from "path"

import type OpenAI from "openai"

import type { ProviderSettings, ModeConfig, ModelInfo, CustomModePrompts } from "@roo-code/types"
import { customToolRegistry, formatNative } from "@roo-code/core"

import type { ClineProvider } from "../webview/ClineProvider"
import { getRooDirectoriesForCwd } from "../../services/roo-config/index.js"
import { getModeAllowedMcpServers, defaultModeSlug } from "../../shared/modes"

import { getNativeTools, getMcpServerTools } from "../prompts/tools/native-tools"
import {
	filterNativeToolsForMode,
	filterMcpToolsForMode,
	resolveToolAlias,
} from "../prompts/tools/filter-tools-for-mode"
import { applyDeferralStrategy, type DeferredCatalog } from "./deferred-tools"

interface BuildToolsOptions {
	provider: ClineProvider
	cwd: string
	mode: string | undefined
	customModes: ModeConfig[] | undefined
	/**
	 * Per-slug prompt overrides for built-in modes. Carries `allowedMcpServers` for built-in
	 * modes (custom modes carry it on their ModeConfig). Used to resolve the MCP allowlist so a
	 * built-in mode can restrict servers, not just custom modes.
	 */
	customModePrompts?: CustomModePrompts
	experiments: Record<string, boolean> | undefined
	apiConfiguration: ProviderSettings | undefined
	disabledTools?: string[]
	modelInfo?: ModelInfo
	/**
	 * Global `webToolsEnabled` setting. The `web` group resolves to no tools
	 * unless this is true, so an unset value keeps the tools array identical to
	 * a build without the feature.
	 */
	webToolsEnabled?: boolean
	/**
	 * If true, returns all tools without mode filtering, but also includes
	 * the list of allowed tool names for use with allowedFunctionNames.
	 * This enables providers that support function call restrictions (e.g., Gemini)
	 * to pass all tool definitions while restricting callable tools.
	 */
	includeAllToolsWithRestrictions?: boolean
	/**
	 * Tool names the current Task has already materialized via the
	 * `tools_load` meta-tool. Each entry is re-promoted back into the active
	 * tools array so the model can actually call them on subsequent turns.
	 * Ignored unless the `deferredTools` experiment is enabled.
	 */
	materializedDeferredTools?: ReadonlySet<string>
}

interface BuildToolsResult {
	/**
	 * The tools to pass to the model.
	 * If includeAllToolsWithRestrictions is true, this includes ALL tools.
	 * Otherwise, it includes only mode-filtered tools.
	 */
	tools: OpenAI.Chat.ChatCompletionTool[]
	/**
	 * The names of tools that are allowed to be called based on mode restrictions.
	 * Only populated when includeAllToolsWithRestrictions is true.
	 * Use this with allowedFunctionNames in providers that support it.
	 */
	allowedFunctionNames?: string[]
	/**
	 * Catalog of tools whose schemas were withheld from the active `tools`
	 * array. Populated only when the `deferredTools` experiment is enabled and
	 * at least one MCP/custom tool is deferred. Consumers (`getDeferredToolsSection`)
	 * read this to advertise the names in the system prompt so the model
	 * knows what is callable via `tools_load`.
	 */
	deferredCatalog?: DeferredCatalog
}

/**
 * Extracts the function name from a tool definition.
 */
function getToolName(tool: OpenAI.Chat.ChatCompletionTool): string {
	return (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name
}

/**
 * Builds the complete tools array for native protocol requests.
 * Combines native tools and MCP tools, filtered by mode restrictions.
 *
 * @param options - Configuration options for building the tools
 * @returns Array of filtered native and MCP tools
 */
export async function buildNativeToolsArray(options: BuildToolsOptions): Promise<OpenAI.Chat.ChatCompletionTool[]> {
	const result = await buildNativeToolsArrayWithRestrictions(options)
	return result.tools
}

/**
 * Builds the complete tools array for native protocol requests with optional mode restrictions.
 * When includeAllToolsWithRestrictions is true, returns ALL tools but also provides
 * the list of allowed tool names for use with allowedFunctionNames.
 *
 * This enables providers like Gemini to pass all tool definitions to the model
 * (so it can reference historical tool calls) while restricting which tools
 * can actually be invoked via allowedFunctionNames in toolConfig.
 *
 * @param options - Configuration options for building the tools
 * @returns BuildToolsResult with tools array and optional allowedFunctionNames
 */
export async function buildNativeToolsArrayWithRestrictions(options: BuildToolsOptions): Promise<BuildToolsResult> {
	const {
		provider,
		cwd,
		mode,
		customModes,
		customModePrompts,
		experiments,
		apiConfiguration,
		disabledTools,
		modelInfo,
		webToolsEnabled,
		includeAllToolsWithRestrictions,
		materializedDeferredTools,
	} = options

	const mcpHub = provider.getMcpHub()

	// Get CodeIndexManager for feature checking.
	const { CodeIndexManager } = await import("../../services/code-index/manager")
	const codeIndexManager = CodeIndexManager.getInstance(provider.context, cwd)

	// Build settings object for tool filtering.
	const filterSettings = {
		todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
		disabledTools,
		modelInfo,
		webToolsEnabled,
	}

	// Check if the model supports images for read_file tool description.
	const supportsImages = modelInfo?.supportsImages ?? false

	// Build native tools with dynamic read_file tool based on settings.
	const nativeTools = getNativeTools({
		supportsImages,
	})

	// Resolve the per-mode MCP allowlist for filtering. Works for built-in modes (override in
	// customModePrompts) as well as custom modes (allowlist on the ModeConfig).
	const allowedMcpServers = getModeAllowedMcpServers(mode ?? defaultModeSlug, customModes, customModePrompts)

	// Filter native tools based on mode restrictions. The allowlist is forwarded so the
	// access_mcp_resource availability check only considers resources from allowed servers;
	// otherwise a restricted mode could still read resources from disallowed servers.
	const filteredNativeTools = filterNativeToolsForMode(
		nativeTools,
		mode,
		customModes,
		experiments,
		codeIndexManager,
		filterSettings,
		mcpHub,
		allowedMcpServers,
	)

	// Filter MCP tools based on mode restrictions.
	const mcpTools = getMcpServerTools(mcpHub, allowedMcpServers)
	const filteredMcpTools = filterMcpToolsForMode(mcpTools, mode, customModes, experiments)

	// Add custom tools if they are available and the experiment is enabled.
	let nativeCustomTools: OpenAI.Chat.ChatCompletionFunctionTool[] = []

	if (experiments?.customTools) {
		const toolDirs = getRooDirectoriesForCwd(cwd).map((dir) => path.join(dir, "tools"))
		await customToolRegistry.loadFromDirectoriesIfStale(toolDirs)
		const customTools = customToolRegistry.getAllSerialized()

		if (customTools.length > 0) {
			nativeCustomTools = customTools.map(formatNative)
		}
	}

	// Combine filtered tools (for backward compatibility and for allowedFunctionNames)
	const filteredTools = [...filteredNativeTools, ...filteredMcpTools, ...nativeCustomTools]

	const deferralEnabled = experiments?.deferredTools === true

	// If includeAllToolsWithRestrictions is true, return ALL tools but provide
	// allowed names based on mode filtering
	if (includeAllToolsWithRestrictions) {
		// Combine ALL tools (unfiltered native + all MCP + custom)
		const allTools = [...nativeTools, ...mcpTools, ...nativeCustomTools]

		// Extract names of tools that are allowed based on mode filtering.
		// Resolve any alias names to canonical names to ensure consistency with allTools
		// (which uses canonical names). This prevents Gemini errors when tools are renamed
		// to aliases in filteredTools but allTools contains the original canonical names.
		const allowedFunctionNames = filteredTools.map((tool) => resolveToolAlias(getToolName(tool)))

		if (!deferralEnabled) {
			return {
				tools: allTools,
				allowedFunctionNames,
			}
		}

		const deferral = applyDeferralStrategy({
			nativeTools,
			mcpTools,
			customTools: nativeCustomTools,
			materializedDeferredTools: materializedDeferredTools ?? new Set<string>(),
		})

		return {
			tools: deferral.activeTools,
			// IMPORTANT: keep deferred names in allowedFunctionNames so providers
			// like Gemini still allow the model to call them once materialized
			// via `tools_load`. allTools already covers the deferred names; we
			// re-resolve via the deferred catalog to be explicit.
			allowedFunctionNames: Array.from(
				new Set([...allowedFunctionNames, ...deferral.catalog.entries.map((e) => e.name)]),
			),
			deferredCatalog: deferral.catalog,
		}
	}

	if (!deferralEnabled) {
		return {
			tools: filteredTools,
		}
	}

	const deferral = applyDeferralStrategy({
		nativeTools: filteredNativeTools,
		mcpTools: filteredMcpTools,
		customTools: nativeCustomTools,
		materializedDeferredTools: materializedDeferredTools ?? new Set<string>(),
	})

	return {
		tools: deferral.activeTools,
		deferredCatalog: deferral.catalog,
	}
}
