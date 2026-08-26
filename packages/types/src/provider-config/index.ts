import { z } from "zod"

import { activeProviderIds, retiredProviderIds } from "../provider-registry.js"
import {
	anthropicConfigSchema,
	bedrockConfigSchema,
	deepSeekConfigSchema,
	fakeAiConfigSchema,
	geminiCliConfigSchema,
	geminiConfigSchema,
	litellmConfigSchema,
	lmStudioConfigSchema,
	minimaxConfigSchema,
	mistralConfigSchema,
	moonshotConfigSchema,
	ollamaConfigSchema,
	openAiCodexConfigSchema,
	openAiConfigSchema,
	openAiNativeConfigSchema,
	openRouterConfigSchema,
	qwenCodeConfigSchema,
	vertexConfigSchema,
	vsCodeLmConfigSchema,
	xaiConfigSchema,
	zaiConfigSchema,
} from "./configs.js"
import { sharedProfileSettingsSchema } from "./shared.js"

export * from "./configs.js"
export * from "./compatibility.js"
export * from "./shared.js"

export type KnownProviderId = (typeof activeProviderIds)[number]
export type RetiredProviderId = (typeof retiredProviderIds)[number]

export const providerConfigSchemas = {
	anthropic: anthropicConfigSchema,
	openrouter: openRouterConfigSchema,
	bedrock: bedrockConfigSchema,
	vertex: vertexConfigSchema,
	openai: openAiConfigSchema,
	ollama: ollamaConfigSchema,
	"vscode-lm": vsCodeLmConfigSchema,
	lmstudio: lmStudioConfigSchema,
	gemini: geminiConfigSchema,
	"gemini-cli": geminiCliConfigSchema,
	"openai-codex": openAiCodexConfigSchema,
	"openai-native": openAiNativeConfigSchema,
	mistral: mistralConfigSchema,
	deepseek: deepSeekConfigSchema,
	moonshot: moonshotConfigSchema,
	minimax: minimaxConfigSchema,
	"fake-ai": fakeAiConfigSchema,
	xai: xaiConfigSchema,
	litellm: litellmConfigSchema,
	zai: zaiConfigSchema,
	"qwen-code": qwenCodeConfigSchema,
} satisfies { [K in KnownProviderId]: z.ZodTypeAny }

type ProviderConfigMap = {
	[K in KnownProviderId]: z.infer<(typeof providerConfigSchemas)[K] & z.ZodTypeAny>
}

export type ProviderConfig<K extends KnownProviderId = KnownProviderId> = ProviderConfigMap[K]
export type KnownProviderConfiguration<K extends KnownProviderId = KnownProviderId> = K extends KnownProviderId
	? { providerId: K; config: ProviderConfigMap[K] }
	: never

export const knownProviderConfigurationSchema = z.discriminatedUnion("providerId", [
	z.object({ providerId: z.literal("anthropic"), config: providerConfigSchemas.anthropic }),
	z.object({ providerId: z.literal("openrouter"), config: providerConfigSchemas.openrouter }),
	z.object({ providerId: z.literal("bedrock"), config: providerConfigSchemas.bedrock }),
	z.object({ providerId: z.literal("vertex"), config: providerConfigSchemas.vertex }),
	z.object({ providerId: z.literal("openai"), config: providerConfigSchemas.openai }),
	z.object({ providerId: z.literal("ollama"), config: providerConfigSchemas.ollama }),
	z.object({ providerId: z.literal("vscode-lm"), config: providerConfigSchemas["vscode-lm"] }),
	z.object({ providerId: z.literal("lmstudio"), config: providerConfigSchemas.lmstudio }),
	z.object({ providerId: z.literal("gemini"), config: providerConfigSchemas.gemini }),
	z.object({ providerId: z.literal("gemini-cli"), config: providerConfigSchemas["gemini-cli"] }),
	z.object({ providerId: z.literal("openai-codex"), config: providerConfigSchemas["openai-codex"] }),
	z.object({ providerId: z.literal("openai-native"), config: providerConfigSchemas["openai-native"] }),
	z.object({ providerId: z.literal("mistral"), config: providerConfigSchemas.mistral }),
	z.object({ providerId: z.literal("deepseek"), config: providerConfigSchemas.deepseek }),
	z.object({ providerId: z.literal("moonshot"), config: providerConfigSchemas.moonshot }),
	z.object({ providerId: z.literal("minimax"), config: providerConfigSchemas.minimax }),
	z.object({ providerId: z.literal("fake-ai"), config: providerConfigSchemas["fake-ai"] }),
	z.object({ providerId: z.literal("xai"), config: providerConfigSchemas.xai }),
	z.object({ providerId: z.literal("litellm"), config: providerConfigSchemas.litellm }),
	z.object({ providerId: z.literal("zai"), config: providerConfigSchemas.zai }),
	z.object({ providerId: z.literal("qwen-code"), config: providerConfigSchemas["qwen-code"] }),
])

export const retiredProviderConfigurationSchema = z.object({
	providerId: z.enum(retiredProviderIds),
	opaqueLegacyPayload: z.record(z.string(), z.unknown()),
})

export const unknownProviderConfigurationSchema = z.object({
	providerId: z.string(),
	opaqueLegacyPayload: z.record(z.string(), z.unknown()),
})

export type RetiredProviderConfiguration = z.infer<typeof retiredProviderConfigurationSchema>
export type UnknownProviderConfiguration = z.infer<typeof unknownProviderConfigurationSchema>
export type OpaqueProviderConfiguration = RetiredProviderConfiguration | UnknownProviderConfiguration

export const narrowedProviderSettingsSchema = z.object({
	provider: knownProviderConfigurationSchema,
	shared: sharedProfileSettingsSchema.optional(),
})

export type NarrowedProviderSettings = z.infer<typeof narrowedProviderSettingsSchema>

export const opaqueNarrowedProviderSettingsSchema = z.object({
	provider: z.union([retiredProviderConfigurationSchema, unknownProviderConfigurationSchema]),
})

export type OpaqueNarrowedProviderSettings = z.infer<typeof opaqueNarrowedProviderSettingsSchema>
