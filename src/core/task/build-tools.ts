import path from "path"

import type OpenAI from "openai"

import type { ProviderSettings, ModeConfig, ModelInfo, CustomModePrompts } from "@roo-code/types"
import { customToolRegistry, formatNative } from "@roo-code/core"

import type { ClineProvider } from "../webview/ClineProvider"
import { getRooDirectoriesForCwd } from "../../services/roo-config/index.js"
import { getModeAllowedMcpServers, defaultModeSlug } from "../../shared/modes"

import { getNativeTools, getMcpServerTools } from "../prompts/tools/native-tools"
import {
	applySlimToolset,
	filterNativeToolsForMode,
	filterMcpToolsForMode,
	isSlimToolsetEnabled,
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
	// NOTE: the slim-toolset flags are read off the ACTIVE profile
	// (`apiConfiguration`), never off global settings. Profiles follow modes via
	// `modeApiConfigs`, so a mid-task mode switch swaps the profile and the next
	// request recomputes the advertised set with no cached decision anywhere.
	const filterSettings = {
		todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
		disabledTools,
		modelInfo,
		webToolsEnabled,
		slimToolset: apiConfiguration?.slimToolset,
		slimHidesMcp: apiConfiguration?.slimHidesMcp,
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
	const filteredMcpTools = filterMcpToolsForMode(mcpTools, mode, customModes, experiments, filterSettings)

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

	// Filesystem custom tools (.roo/tools) are assembled after the mode filter,
	// so they have to be sent through the same intersection explicitly or a slim
	// profile would still advertise them. Slim means slim: a user-authored tool
	// is by definition one more choice, which is exactly what the small-model
	// profile is trying to remove. A user who needs it runs a non-slim profile.
	// Routed through applySlimToolset rather than a length check so the
	// allowlist stays the single source of truth (a custom tool that happens to
	// be named like an allowlisted one is kept).
	if (nativeCustomTools.length > 0 && isSlimToolsetEnabled(filterSettings)) {
		const keptCustomToolNames = applySlimToolset(new Set(nativeCustomTools.map(getToolName)), filterSettings)
		nativeCustomTools = nativeCustomTools.filter((tool) => keptCustomToolNames.has(getToolName(tool)))
	}

	// Combine filtered tools (for backward compatibility and for allowedFunctionNames)
	const filteredTools = [...filteredNativeTools, ...filteredMcpTools, ...nativeCustomTools]

	const deferralEnabled = experiments?.deferredTools === true

	// If includeAllToolsWithRestrictions is true, return ALL tools but provide
	// allowed names based on mode filtering
	if (includeAllToolsWithRestrictions) {
		// This branch is taken for Gemini only. Normally it declares EVERY schema
		// and restricts what may actually be called through allowedFunctionNames,
		// so the model can still refer to historical tool calls.
		//
		// A slim profile cannot work that way: hiding the choice from the model is
		// the entire point, and declaring 26 schemas while blocking most of them
		// gives the worst of both (full prompt cost, no freedom). So under slim the
		// declared array is narrowed to the same set every other provider sees.
		//
		// LIMITATION, Gemini only: allowed_function_names may only name declared
		// functions, so once a schema is gone the provider itself rejects a call to
		// that name. The dispatch tolerance the slim toolset keeps everywhere else
		// (a hidden but real tool still executes, aliases still resolve) is simply
		// not reachable here. Weak models, which is who slim is for, do not run on
		// Gemini, so this is an accepted trade rather than a behaviour we want.
		const slimActive = isSlimToolsetEnabled(filterSettings)

		// Combine ALL tools (unfiltered native + all MCP + custom), or the slim set.
		const allTools = slimActive ? filteredTools : [...nativeTools, ...mcpTools, ...nativeCustomTools]

		// Extract names of tools that are allowed based on mode filtering.
		// Resolve any alias names to canonical names to ensure consistency with allTools
		// (which uses canonical names). This prevents Gemini errors when tools are renamed
		// to aliases in filteredTools but allTools contains the original canonical names.
		// Under slim, allTools IS the filtered array, so the declared names are used
		// verbatim: resolving aliases there would name a function that is not declared.
		const allowedFunctionNames = slimActive
			? filteredTools.map((tool) => getToolName(tool))
			: filteredTools.map((tool) => resolveToolAlias(getToolName(tool)))

		if (!deferralEnabled) {
			return {
				tools: allTools,
				allowedFunctionNames,
			}
		}

		const deferral = applyDeferralStrategy({
			nativeTools: slimActive ? filteredNativeTools : nativeTools,
			mcpTools: slimActive ? filteredMcpTools : mcpTools,
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
