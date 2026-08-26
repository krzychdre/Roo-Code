import { z } from "zod"

import { modelInfoSchema, reasoningEffortSettingSchema, verbosityLevelsSchema, serviceTierSchema } from "./model.js"
import { codebaseIndexProviderSchema } from "./codebase-index.js"
import { activeProviderIdsForPublicApi, providerIdsForPublicApi, retiredProviderIds } from "./provider-registry.js"

/**
 * constants
 */

export const DEFAULT_CONSECUTIVE_MISTAKE_LIMIT = 3

/**
 * InternalProvider
 *
 * Internal providers require internal VSCode API calls in order to get the
 * model list.
 */

export const internalProviders = ["vscode-lm"] as const

export type InternalProvider = (typeof internalProviders)[number]

export const isInternalProvider = (key: string): key is InternalProvider =>
	internalProviders.includes(key as InternalProvider)

/**
 * CustomProvider
 *
 * Custom providers are completely configurable within Roo Code settings.
 */

export const customProviders = ["openai"] as const

export type CustomProvider = (typeof customProviders)[number]

export const isCustomProvider = (key: string): key is CustomProvider => customProviders.includes(key as CustomProvider)

/**
 * FauxProvider
 *
 * Faux providers do not make external inference calls and therefore do not have
 * model lists.
 */

export const fauxProviders = ["fake-ai"] as const

export type FauxProvider = (typeof fauxProviders)[number]

export const isFauxProvider = (key: string): key is FauxProvider => fauxProviders.includes(key as FauxProvider)

/**
 * ProviderName
 */

export const providerNames = activeProviderIdsForPublicApi

export const providerNamesSchema = z.enum(providerNames)

export type ProviderName = z.infer<typeof providerNamesSchema>

export const isProviderName = (key: unknown): key is ProviderName =>
	typeof key === "string" && providerNames.includes(key as ProviderName)

/**
 * RetiredProviderName
 */

export const retiredProviderNames = retiredProviderIds

export const retiredProviderNamesSchema = z.enum(retiredProviderNames)

export type RetiredProviderName = z.infer<typeof retiredProviderNamesSchema>

export const isRetiredProvider = (value: string): value is RetiredProviderName =>
	retiredProviderNames.includes(value as RetiredProviderName)

export const providerNamesWithRetired = providerIdsForPublicApi

export const providerNamesWithRetiredSchema = z.union([providerNamesSchema, retiredProviderNamesSchema])

export type ProviderNameWithRetired = z.infer<typeof providerNamesWithRetiredSchema>

/**
 * ProviderSettingsEntry
 */

export const providerSettingsEntrySchema = z.object({
	id: z.string(),
	name: z.string(),
	apiProvider: providerNamesWithRetiredSchema.optional(),
	modelId: z.string().optional(),
})

export type ProviderSettingsEntry = z.infer<typeof providerSettingsEntrySchema>

/**
 * ProviderSettings
 */

const baseProviderSettingsSchema = z.object({
	includeMaxTokens: z.boolean().optional(),
	todoListEnabled: z.boolean().optional(),
	modelTemperature: z.number().nullish(),
	rateLimitSeconds: z.number().optional(),
	consecutiveMistakeLimit: z.number().min(0).optional(),

	// Slim toolset: a profile-level switch that intersects the advertised tool
	// set down to a small, unambiguous allowlist. Small models pick the wrong
	// edit verb when six of them are offered; this is the per-profile answer.
	// Profiles follow modes through `modeApiConfigs`, so the restriction
	// recomputes on every mode switch without any persisted task state.
	// Plain optional booleans (never nullish) so profiles serialized with
	// exclude_none semantics simply omit them.
	slimToolset: z.boolean().optional(),
	// Whether the slim toolset also hides MCP tools. Only consulted while
	// `slimToolset` is on, where an undefined value means true (MCP schemas are
	// the single largest tool-prompt cost).
	slimHidesMcp: z.boolean().optional(),

	// Model reasoning.
	enableReasoningEffort: z.boolean().optional(),
	reasoningEffort: reasoningEffortSettingSchema.optional(),
	modelMaxTokens: z.number().optional(),
	modelMaxThinkingTokens: z.number().optional(),

	// Model verbosity.
	verbosity: verbosityLevelsSchema.optional(),
})

// Several of the providers share common model config properties.
const apiModelIdProviderModelSchema = baseProviderSettingsSchema.extend({
	apiModelId: z.string().optional(),
})

const anthropicSchema = apiModelIdProviderModelSchema.extend({
	apiKey: z.string().optional(),
	anthropicBaseUrl: z.string().optional(),
	anthropicUseAuthToken: z.boolean().optional(),
	anthropicBeta1MContext: z.boolean().optional(), // Enable 'context-1m-2025-08-07' beta for 1M context window.
})

const openRouterSchema = baseProviderSettingsSchema.extend({
	openRouterApiKey: z.string().optional(),
	openRouterModelId: z.string().optional(),
	openRouterBaseUrl: z.string().optional(),
	openRouterSpecificProvider: z.string().optional(),
})

const bedrockSchema = apiModelIdProviderModelSchema.extend({
	awsAccessKey: z.string().optional(),
	awsSecretKey: z.string().optional(),
	awsSessionToken: z.string().optional(),
	awsRegion: z.string().optional(),
	awsUseCrossRegionInference: z.boolean().optional(),
	awsUseGlobalInference: z.boolean().optional(), // Enable Global Inference profile routing when supported
	awsUsePromptCache: z.boolean().optional(),
	awsProfile: z.string().optional(),
	awsUseProfile: z.boolean().optional(),
	awsApiKey: z.string().optional(),
	awsUseApiKey: z.boolean().optional(),
	awsCustomArn: z.string().optional(),
	awsModelContextWindow: z.number().optional(),
	awsBedrockEndpointEnabled: z.boolean().optional(),
	awsBedrockEndpoint: z.string().optional(),
	awsBedrock1MContext: z.boolean().optional(), // Enable 'context-1m-2025-08-07' beta for 1M context window.
	awsBedrockServiceTier: z.enum(["STANDARD", "FLEX", "PRIORITY"]).optional(), // AWS Bedrock service tier selection
})

const vertexSchema = apiModelIdProviderModelSchema.extend({
	vertexKeyFile: z.string().optional(),
	vertexJsonCredentials: z.string().optional(),
	vertexProjectId: z.string().optional(),
	vertexRegion: z.string().optional(),
	vertex1MContext: z.boolean().optional(), // Enable 'context-1m-2025-08-07' beta for 1M context window.
})

const openAiSchema = baseProviderSettingsSchema.extend({
	openAiBaseUrl: z.string().optional(),
	openAiApiKey: z.string().optional(),
	openAiR1FormatEnabled: z.boolean().optional(),
	openAiModelId: z.string().optional(),
	openAiCustomModelInfo: modelInfoSchema.nullish(),
	openAiUseAzure: z.boolean().optional(),
	azureApiVersion: z.string().optional(),
	openAiStreamingEnabled: z.boolean().optional(),
	openAiHostHeader: z.string().optional(), // Keep temporarily for backward compatibility during migration.
	openAiHeaders: z.record(z.string(), z.string()).optional(),
})

const ollamaSchema = baseProviderSettingsSchema.extend({
	ollamaModelId: z.string().optional(),
	ollamaBaseUrl: z.string().optional(),
	ollamaApiKey: z.string().optional(),
	ollamaNumCtx: z.number().int().min(128).optional(),
})

const vsCodeLmSchema = baseProviderSettingsSchema.extend({
	vsCodeLmModelSelector: z
		.object({
			vendor: z.string().optional(),
			family: z.string().optional(),
			version: z.string().optional(),
			id: z.string().optional(),
		})
		.optional(),
})

const lmStudioSchema = baseProviderSettingsSchema.extend({
	lmStudioModelId: z.string().optional(),
	lmStudioBaseUrl: z.string().optional(),
	lmStudioDraftModelId: z.string().optional(),
	lmStudioSpeculativeDecodingEnabled: z.boolean().optional(),
})

const geminiSchema = apiModelIdProviderModelSchema.extend({
	geminiApiKey: z.string().optional(),
	googleGeminiBaseUrl: z.string().optional(),
})

const geminiCliSchema = apiModelIdProviderModelSchema.extend({
	geminiCliOAuthPath: z.string().optional(),
	geminiCliProjectId: z.string().optional(),
})

const openAiCodexSchema = apiModelIdProviderModelSchema.extend({
	// No additional settings needed - uses OAuth authentication
})

const openAiNativeSchema = apiModelIdProviderModelSchema.extend({
	openAiNativeApiKey: z.string().optional(),
	openAiNativeBaseUrl: z.string().optional(),
	// OpenAI Responses API service tier for openai-native provider only.
	// UI should only expose this when the selected model supports flex/priority.
	openAiNativeServiceTier: serviceTierSchema.optional(),
})

const mistralSchema = apiModelIdProviderModelSchema.extend({
	mistralApiKey: z.string().optional(),
	mistralCodestralUrl: z.string().optional(),
})

const deepSeekSchema = apiModelIdProviderModelSchema.extend({
	deepSeekBaseUrl: z.string().optional(),
	deepSeekApiKey: z.string().optional(),
})

const moonshotSchema = apiModelIdProviderModelSchema.extend({
	moonshotBaseUrl: z
		.union([z.literal("https://api.moonshot.ai/v1"), z.literal("https://api.moonshot.cn/v1")])
		.optional(),
	moonshotApiKey: z.string().optional(),
})

const minimaxSchema = apiModelIdProviderModelSchema.extend({
	minimaxBaseUrl: z
		.union([z.literal("https://api.minimax.io/v1"), z.literal("https://api.minimaxi.com/v1")])
		.optional(),
	minimaxApiKey: z.string().optional(),
})

const fakeAiSchema = baseProviderSettingsSchema.extend({
	fakeAi: z.unknown().optional(),
})

const xaiSchema = apiModelIdProviderModelSchema.extend({
	xaiApiKey: z.string().optional(),
})

const litellmSchema = baseProviderSettingsSchema.extend({
	litellmBaseUrl: z.string().optional(),
	litellmApiKey: z.string().optional(),
	litellmModelId: z.string().optional(),
	litellmUsePromptCache: z.boolean().optional(),
})

const qwenCodeSchema = apiModelIdProviderModelSchema.extend({
	qwenCodeOauthPath: z.string().optional(),
})

export const zaiApiLineSchema = z.enum(["international_coding", "china_coding", "international_api", "china_api"])

export type ZaiApiLine = z.infer<typeof zaiApiLineSchema>

const zaiSchema = apiModelIdProviderModelSchema.extend({
	zaiApiKey: z.string().optional(),
	zaiApiLine: zaiApiLineSchema.optional(),
})

const defaultSchema = z.object({
	apiProvider: z.undefined(),
})

export const providerSettingsSchemaDiscriminated = z.discriminatedUnion("apiProvider", [
	anthropicSchema.merge(z.object({ apiProvider: z.literal("anthropic") })),
	openRouterSchema.merge(z.object({ apiProvider: z.literal("openrouter") })),
	bedrockSchema.merge(z.object({ apiProvider: z.literal("bedrock") })),
	vertexSchema.merge(z.object({ apiProvider: z.literal("vertex") })),
	openAiSchema.merge(z.object({ apiProvider: z.literal("openai") })),
	ollamaSchema.merge(z.object({ apiProvider: z.literal("ollama") })),
	vsCodeLmSchema.merge(z.object({ apiProvider: z.literal("vscode-lm") })),
	lmStudioSchema.merge(z.object({ apiProvider: z.literal("lmstudio") })),
	geminiSchema.merge(z.object({ apiProvider: z.literal("gemini") })),
	geminiCliSchema.merge(z.object({ apiProvider: z.literal("gemini-cli") })),
	openAiCodexSchema.merge(z.object({ apiProvider: z.literal("openai-codex") })),
	openAiNativeSchema.merge(z.object({ apiProvider: z.literal("openai-native") })),
	mistralSchema.merge(z.object({ apiProvider: z.literal("mistral") })),
	deepSeekSchema.merge(z.object({ apiProvider: z.literal("deepseek") })),
	moonshotSchema.merge(z.object({ apiProvider: z.literal("moonshot") })),
	minimaxSchema.merge(z.object({ apiProvider: z.literal("minimax") })),
	fakeAiSchema.merge(z.object({ apiProvider: z.literal("fake-ai") })),
	xaiSchema.merge(z.object({ apiProvider: z.literal("xai") })),
	litellmSchema.merge(z.object({ apiProvider: z.literal("litellm") })),
	zaiSchema.merge(z.object({ apiProvider: z.literal("zai") })),
	qwenCodeSchema.merge(z.object({ apiProvider: z.literal("qwen-code") })),
	defaultSchema,
])

export const providerSettingsSchema = z.object({
	apiProvider: providerNamesWithRetiredSchema.optional(),
	...anthropicSchema.shape,
	...openRouterSchema.shape,
	...bedrockSchema.shape,
	...vertexSchema.shape,
	...openAiSchema.shape,
	...ollamaSchema.shape,
	...vsCodeLmSchema.shape,
	...lmStudioSchema.shape,
	...geminiSchema.shape,
	...geminiCliSchema.shape,
	...openAiCodexSchema.shape,
	...openAiNativeSchema.shape,
	...mistralSchema.shape,
	...deepSeekSchema.shape,
	...moonshotSchema.shape,
	...minimaxSchema.shape,
	...fakeAiSchema.shape,
	...xaiSchema.shape,
	...litellmSchema.shape,
	...zaiSchema.shape,
	...qwenCodeSchema.shape,
	...codebaseIndexProviderSchema.shape,
})

export type ProviderSettings = z.infer<typeof providerSettingsSchema>

export const providerSettingsWithIdSchema = providerSettingsSchema.extend({ id: z.string().optional() })

export const discriminatedProviderSettingsWithIdSchema = providerSettingsSchemaDiscriminated.and(
	z.object({ id: z.string().optional() }),
)

export type ProviderSettingsWithId = z.infer<typeof providerSettingsWithIdSchema>

export const PROVIDER_SETTINGS_KEYS = providerSettingsSchema.keyof().options

/**
 * ModelIdKey
 */

export const modelIdKeys = [
	"apiModelId",
	"openRouterModelId",
	"openAiModelId",
	"ollamaModelId",
	"lmStudioModelId",
	"lmStudioDraftModelId",
	"litellmModelId",
] as const satisfies readonly (keyof ProviderSettings)[]

export type ModelIdKey = (typeof modelIdKeys)[number]

export const getModelId = (settings: ProviderSettings): string | undefined => {
	const modelIdKey = modelIdKeys.find((key) => settings[key])
	return modelIdKey ? settings[modelIdKey] : undefined
}

/**
 * TypicalProvider
 */

export type TypicalProvider = Exclude<ProviderName, InternalProvider | CustomProvider | FauxProvider>

export const isTypicalProvider = (key: unknown): key is TypicalProvider =>
	isProviderName(key) && !isInternalProvider(key) && !isCustomProvider(key) && !isFauxProvider(key)

export const modelIdKeysByProvider: Record<TypicalProvider, ModelIdKey> = {
	anthropic: "apiModelId",
	openrouter: "openRouterModelId",
	bedrock: "apiModelId",
	vertex: "apiModelId",
	"openai-codex": "apiModelId",
	"openai-native": "openAiModelId",
	ollama: "ollamaModelId",
	lmstudio: "lmStudioModelId",
	gemini: "apiModelId",
	"gemini-cli": "apiModelId",
	mistral: "apiModelId",
	moonshot: "apiModelId",
	minimax: "apiModelId",
	deepseek: "apiModelId",
	"qwen-code": "apiModelId",
	xai: "apiModelId",
	litellm: "litellmModelId",
	zai: "apiModelId",
}

/**
 * ANTHROPIC_STYLE_PROVIDERS
 */

// Providers that use Anthropic-style API protocol.
export const ANTHROPIC_STYLE_PROVIDERS: ProviderName[] = ["anthropic", "bedrock", "minimax"]

export const getApiProtocol = (provider: ProviderName | undefined, modelId?: string): "anthropic" | "openai" => {
	if (provider && ANTHROPIC_STYLE_PROVIDERS.includes(provider)) {
		return "anthropic"
	}

	if (provider && provider === "vertex" && modelId && modelId.toLowerCase().includes("claude")) {
		return "anthropic"
	}

	return "openai"
}
