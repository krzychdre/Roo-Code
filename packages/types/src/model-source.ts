import { z } from "zod"

import { modelInfoSchema } from "./model.js"

export const modelSourceIds = [
	"openrouter",
	"litellm",
	"deepseek",
	"ollama",
	"lmstudio",
	"openai-compatible",
	"vscode-lm",
] as const

export const modelSourceIdSchema = z.enum(modelSourceIds)
export type ModelSourceId = z.infer<typeof modelSourceIdSchema>

const modelSourceBaseSchema = z.object({
	id: modelSourceIdSchema,
	payload: z.enum(["models", "modelIds"]),
})

export const requestableModelSourceSchema = z.discriminatedUnion("kind", [
	modelSourceBaseSchema.extend({ kind: z.literal("remote") }),
	modelSourceBaseSchema.extend({ kind: z.literal("local") }),
	modelSourceBaseSchema.extend({ kind: z.literal("extension") }),
])

export const modelSourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("static") }),
	modelSourceBaseSchema.extend({ kind: z.literal("remote") }),
	modelSourceBaseSchema.extend({ kind: z.literal("local") }),
	modelSourceBaseSchema.extend({ kind: z.literal("extension") }),
])

export type ModelSource = z.infer<typeof modelSourceSchema>
export type RequestableModelSource = z.infer<typeof requestableModelSourceSchema>

export const modelSources = {
	openrouter: { id: "openrouter", kind: "remote", payload: "models" },
	litellm: { id: "litellm", kind: "remote", payload: "models" },
	deepseek: { id: "deepseek", kind: "remote", payload: "models" },
	ollama: { id: "ollama", kind: "local", payload: "models" },
	lmstudio: { id: "lmstudio", kind: "local", payload: "models" },
	"openai-compatible": { id: "openai-compatible", kind: "remote", payload: "modelIds" },
	"vscode-lm": { id: "vscode-lm", kind: "extension", payload: "modelIds" },
} as const satisfies Record<ModelSourceId, ModelSource>

export const modelSourceOptionsSchema = z.object({
	baseUrl: z.string().optional(),
	apiKey: z.string().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	liteLlmBaseUrl: z.string().optional(),
	liteLlmApiKey: z.string().optional(),
})

export type ModelSourceOptions = z.infer<typeof modelSourceOptionsSchema>

export const modelSourceRequestSchema = z.object({
	requestId: z.string().min(1),
	source: requestableModelSourceSchema,
	provider: z.string().min(1).optional(),
	options: modelSourceOptionsSchema.optional(),
	refresh: z.boolean().optional(),
})

export type ModelSourceRequest = z.infer<typeof modelSourceRequestSchema>

export const modelSourceResultSchema = z.object({
	requestId: z.string().min(1),
	sourceId: modelSourceIdSchema,
	models: z.record(z.string(), modelInfoSchema).optional(),
	modelIds: z.array(z.string()).optional(),
	error: z.string().optional(),
})

export type ModelSourceResult = z.infer<typeof modelSourceResultSchema>
