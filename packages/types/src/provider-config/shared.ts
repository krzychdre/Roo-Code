import { z } from "zod"

import { codebaseIndexProviderSchema } from "../codebase-index.js"
import { modelInfoSchema, reasoningEffortSettingSchema, verbosityLevelsSchema } from "../model.js"

export const sharedProfileSettingsSchema = z
	.object({
		includeMaxTokens: z.boolean().optional(),
		todoListEnabled: z.boolean().optional(),
		enableReasoningEffort: z.boolean().optional(),
		modelTemperature: z.number().nullish(),
		rateLimitSeconds: z.number().optional(),
		consecutiveMistakeLimit: z.number().min(0).optional(),
		slimToolset: z.boolean().optional(),
		slimHidesMcp: z.boolean().optional(),
		reasoningEffort: reasoningEffortSettingSchema.optional(),
		modelMaxTokens: z.number().optional(),
		modelMaxThinkingTokens: z.number().optional(),
		verbosity: verbosityLevelsSchema.optional(),
		...codebaseIndexProviderSchema.shape,
	})
	.strict()

export type SharedProfileSettings = z.infer<typeof sharedProfileSettingsSchema>

export const apiModelConfigSchema = z
	.object({
		apiModelId: z.string().optional(),
	})
	.strict()

export const openAiCompatibleConfigSchema = z
	.object({
		openAiBaseUrl: z.string().optional(),
		openAiR1FormatEnabled: z.boolean().optional(),
		openAiModelId: z.string().optional(),
		openAiCustomModelInfo: modelInfoSchema.nullish(),
		openAiUseAzure: z.boolean().optional(),
		azureApiVersion: z.string().optional(),
		openAiStreamingEnabled: z.boolean().optional(),
		openAiHostHeader: z.string().optional(),
		openAiHeaders: z.record(z.string(), z.string()).optional(),
	})
	.strict()

export const emptyProviderConfigSchema = z.object({}).strict()
