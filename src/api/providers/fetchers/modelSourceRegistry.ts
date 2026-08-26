import type { ModelRecord, ModelSourceId, ModelSourceRequest } from "@roo-code/types"

import type { ApiHandlerOptions, GetModelsOptions } from "../../../shared/api"
import { getOpenAiModels } from "../openai"
import { getVsCodeLmModels } from "../vscode-lm"
import { flushModels, getModels } from "./modelCache"

export type ModelSourcePayload = { models: ModelRecord; modelIds?: never } | { modelIds: string[]; models?: never }

type ModelSourceAdapter = {
	fetch: (request: ModelSourceRequest, context: ModelSourceContext) => Promise<ModelSourcePayload>
}

export type ModelSourceContext = {
	apiConfiguration: ApiHandlerOptions
}

const wrapModels = (models: ModelRecord): ModelSourcePayload => ({ models })

const getCachedModels = async (request: ModelSourceRequest, context: ModelSourceContext): Promise<ModelRecord> => {
	const sourceId = request.source.id
	if (sourceId === "openai-compatible" || sourceId === "vscode-lm") {
		throw new Error(`Source ${sourceId} does not use the shared model cache`)
	}

	const options: GetModelsOptions =
		sourceId === "litellm"
			? {
					provider: sourceId,
					apiKey: request.options?.liteLlmApiKey ?? context.apiConfiguration.litellmApiKey ?? "",
					baseUrl: request.options?.liteLlmBaseUrl ?? context.apiConfiguration.litellmBaseUrl ?? "",
				}
			: sourceId === "ollama"
				? { provider: sourceId, baseUrl: request.options?.baseUrl, apiKey: request.options?.apiKey }
				: sourceId === "lmstudio"
					? { provider: sourceId, baseUrl: request.options?.baseUrl }
					: sourceId === "deepseek"
						? {
								provider: sourceId,
								baseUrl: request.options?.baseUrl,
								apiKey: request.options?.apiKey,
							}
						: { provider: sourceId }

	if (request.refresh) {
		await flushModels(options, true)
	}
	return getModels(options)
}

export const modelSourceRegistry = {
	openrouter: {
		fetch: async (request, context) => wrapModels(await getCachedModels(request, context)),
	},
	litellm: {
		fetch: async (request, context) => wrapModels(await getCachedModels(request, context)),
	},
	deepseek: {
		fetch: async (request, context) => wrapModels(await getCachedModels(request, context)),
	},
	ollama: {
		fetch: async (request, context) => wrapModels(await getCachedModels(request, context)),
	},
	lmstudio: {
		fetch: async (request, context) => wrapModels(await getCachedModels(request, context)),
	},
	"openai-compatible": {
		fetch: async (request) => ({
			modelIds: await getOpenAiModels(
				request.options?.baseUrl,
				request.options?.apiKey,
				request.options?.headers,
			),
		}),
	},
	"vscode-lm": {
		fetch: async () => ({
			modelIds: (await getVsCodeLmModels()).map((model) => `${model.vendor}/${model.family}`),
		}),
	},
} satisfies Record<ModelSourceId, ModelSourceAdapter>

export async function fetchModelSource(
	request: ModelSourceRequest,
	context: ModelSourceContext,
): Promise<ModelSourcePayload> {
	return modelSourceRegistry[request.source.id].fetch(request, context)
}
