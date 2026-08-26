import { modelSources, type ModelSourceRequest } from "@roo-code/types"

import { fetchModelSource, modelSourceRegistry } from "../modelSourceRegistry"

vi.mock("../openrouter", () => ({ getOpenRouterModels: vi.fn(async () => ({ openrouter: {} })) }))
vi.mock("../litellm", () => ({ getLiteLLMModels: vi.fn(async () => ({ litellm: {} })) }))
vi.mock("../deepseek", () => ({ getDeepSeekModels: vi.fn(async () => ({ deepseek: {} })) }))
vi.mock("../ollama", () => ({ getOllamaModels: vi.fn(async () => ({ ollama: {} })) }))
vi.mock("../lmstudio", () => ({ getLMStudioModels: vi.fn(async () => ({ lmstudio: {} })) }))
vi.mock("../../openai", () => ({ getOpenAiModels: vi.fn(async () => ["openai"]) }))
vi.mock("../../vscode-lm", () => ({ getVsCodeLmModels: vi.fn(async () => [{ vendor: "copilot", family: "gpt" }]) }))

const requestFor = (source: keyof typeof modelSources): ModelSourceRequest => ({
	requestId: `request-${source}`,
	source: modelSources[source],
})

describe("modelSourceRegistry", () => {
	it("is complete for every portable source", () => {
		expect(Object.keys(modelSourceRegistry).sort()).toEqual(Object.keys(modelSources).sort())
	})

	it.each([
		["openrouter", "openrouter"],
		["litellm", "litellm"],
		["deepseek", "deepseek"],
		["ollama", "ollama"],
		["lmstudio", "lmstudio"],
	] as const)("routes %s to its model adapter", async (source, modelId) => {
		await expect(fetchModelSource(requestFor(source), { apiConfiguration: {} })).resolves.toEqual({
			models: { [modelId]: {} },
		})
	})

	it("normalizes ID-only adapters", async () => {
		await expect(fetchModelSource(requestFor("openai-compatible"), { apiConfiguration: {} })).resolves.toEqual({
			modelIds: ["openai"],
		})
		await expect(fetchModelSource(requestFor("vscode-lm"), { apiConfiguration: {} })).resolves.toEqual({
			modelIds: ["copilot/gpt"],
		})
	})
})
