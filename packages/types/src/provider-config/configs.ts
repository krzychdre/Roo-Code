import { z } from "zod"

import { serviceTierSchema } from "../model.js"
import { zaiApiLineSchema } from "../provider-settings.js"
import { apiModelConfigSchema, emptyProviderConfigSchema, openAiCompatibleConfigSchema } from "./shared.js"

export const anthropicConfigSchema = apiModelConfigSchema.extend({
	anthropicBaseUrl: z.string().optional(),
	anthropicUseAuthToken: z.boolean().optional(),
	anthropicBeta1MContext: z.boolean().optional(),
})

export const openRouterConfigSchema = z
	.object({
		openRouterModelId: z.string().optional(),
		openRouterBaseUrl: z.string().optional(),
		openRouterSpecificProvider: z.string().optional(),
	})
	.strict()

export const bedrockConfigSchema = apiModelConfigSchema.extend({
	awsRegion: z.string().optional(),
	awsUseCrossRegionInference: z.boolean().optional(),
	awsUseGlobalInference: z.boolean().optional(),
	awsUsePromptCache: z.boolean().optional(),
	awsProfile: z.string().optional(),
	awsUseProfile: z.boolean().optional(),
	awsUseApiKey: z.boolean().optional(),
	awsCustomArn: z.string().optional(),
	awsModelContextWindow: z.number().optional(),
	awsBedrockEndpointEnabled: z.boolean().optional(),
	awsBedrockEndpoint: z.string().optional(),
	awsBedrock1MContext: z.boolean().optional(),
	awsBedrockServiceTier: z.enum(["STANDARD", "FLEX", "PRIORITY"]).optional(),
})

export const vertexConfigSchema = apiModelConfigSchema.extend({
	vertexKeyFile: z.string().optional(),
	vertexProjectId: z.string().optional(),
	vertexRegion: z.string().optional(),
	vertex1MContext: z.boolean().optional(),
})

export const openAiConfigSchema = openAiCompatibleConfigSchema.extend({ apiModelId: z.string().optional() })

export const ollamaConfigSchema = z
	.object({
		ollamaModelId: z.string().optional(),
		ollamaBaseUrl: z.string().optional(),
		ollamaNumCtx: z.number().int().min(128).optional(),
	})
	.strict()

export const vsCodeLmConfigSchema = z
	.object({
		vsCodeLmModelSelector: z
			.object({
				vendor: z.string().optional(),
				family: z.string().optional(),
				version: z.string().optional(),
				id: z.string().optional(),
			})
			.optional(),
	})
	.strict()

export const lmStudioConfigSchema = z
	.object({
		lmStudioModelId: z.string().optional(),
		lmStudioBaseUrl: z.string().optional(),
		lmStudioDraftModelId: z.string().optional(),
		lmStudioSpeculativeDecodingEnabled: z.boolean().optional(),
	})
	.strict()

export const geminiConfigSchema = apiModelConfigSchema.extend({ googleGeminiBaseUrl: z.string().optional() })

export const geminiCliConfigSchema = apiModelConfigSchema.extend({
	geminiCliOAuthPath: z.string().optional(),
	geminiCliProjectId: z.string().optional(),
})

export const openAiCodexConfigSchema = apiModelConfigSchema

export const openAiNativeConfigSchema = apiModelConfigSchema.extend({
	openAiNativeBaseUrl: z.string().optional(),
	openAiNativeServiceTier: serviceTierSchema.optional(),
})

export const mistralConfigSchema = apiModelConfigSchema.extend({ mistralCodestralUrl: z.string().optional() })
export const deepSeekConfigSchema = apiModelConfigSchema.extend({ deepSeekBaseUrl: z.string().optional() })
export const moonshotConfigSchema = apiModelConfigSchema.extend({
	moonshotBaseUrl: z
		.union([z.literal("https://api.moonshot.ai/v1"), z.literal("https://api.moonshot.cn/v1")])
		.optional(),
})
export const minimaxConfigSchema = apiModelConfigSchema.extend({
	minimaxBaseUrl: z
		.union([z.literal("https://api.minimax.io/v1"), z.literal("https://api.minimaxi.com/v1")])
		.optional(),
})
export const fakeAiConfigSchema = z.object({ fakeAi: z.unknown().optional() }).strict()
export const xaiConfigSchema = apiModelConfigSchema
export const litellmConfigSchema = z
	.object({
		litellmBaseUrl: z.string().optional(),
		litellmModelId: z.string().optional(),
		litellmUsePromptCache: z.boolean().optional(),
	})
	.strict()

export const zaiConfigSchema = apiModelConfigSchema.extend({ zaiApiLine: zaiApiLineSchema.optional() })
export const qwenCodeConfigSchema = apiModelConfigSchema.extend({ qwenCodeOauthPath: z.string().optional() })

export const rooConfigSchema = apiModelConfigSchema
export const humanRelayConfigSchema = emptyProviderConfigSchema
