import { activeProviderIds, type ProviderSettings } from "@roo-code/types"

type MockHandlerInstance = {
	providerClass: string
	options: unknown
}

const { providerMocks, nativeOllamaMock } = vi.hoisted(() => {
	const providerClassNames = [
		"AnthropicHandler",
		"AnthropicVertexHandler",
		"AwsBedrockHandler",
		"DeepSeekHandler",
		"FakeAIHandler",
		"GeminiHandler",
		"LiteLLMHandler",
		"LmStudioHandler",
		"MiniMaxHandler",
		"MistralHandler",
		"MoonshotHandler",
		"OpenAiCodexHandler",
		"OpenAiHandler",
		"OpenAiNativeHandler",
		"OpenRouterHandler",
		"QwenCodeHandler",
		"VertexHandler",
		"VsCodeLmHandler",
		"XAIHandler",
		"ZAiHandler",
	] as const

	const makeMockHandler = (providerClass: string) =>
		class MockHandler {
			readonly providerClass = providerClass

			constructor(readonly options: unknown) {}
		}

	return {
		providerMocks: Object.fromEntries(
			providerClassNames.map((providerClass) => [providerClass, makeMockHandler(providerClass)]),
		),
		nativeOllamaMock: makeMockHandler("NativeOllamaHandler"),
	}
})

vi.mock("../providers", () => providerMocks)
vi.mock("../providers/native-ollama", () => ({ NativeOllamaHandler: nativeOllamaMock }))

import { buildApiHandler } from "../index"
import {
	providerIdsWithoutRuntimeHandler,
	runtimeProviderRegistry,
	type RuntimeProviderId,
} from "../runtime-provider-registry"

const runtimeProviderCases = [
	["openrouter", "OpenRouterHandler"],
	["litellm", "LiteLLMHandler"],
	["deepseek", "DeepSeekHandler"],
	["ollama", "NativeOllamaHandler"],
	["lmstudio", "LmStudioHandler"],
	["vscode-lm", "VsCodeLmHandler"],
	["openai", "OpenAiHandler"],
	["fake-ai", "FakeAIHandler"],
	["anthropic", "AnthropicHandler"],
	["bedrock", "AwsBedrockHandler"],
	["gemini", "GeminiHandler"],
	["mistral", "MistralHandler"],
	["moonshot", "MoonshotHandler"],
	["minimax", "MiniMaxHandler"],
	["openai-codex", "OpenAiCodexHandler"],
	["openai-native", "OpenAiNativeHandler"],
	["qwen-code", "QwenCodeHandler"],
	["vertex", "VertexHandler"],
	["xai", "XAIHandler"],
	["zai", "ZAiHandler"],
] as const satisfies readonly (readonly [RuntimeProviderId, string])[]

const asMockHandler = (handler: ReturnType<typeof buildApiHandler>): MockHandlerInstance =>
	handler as unknown as MockHandlerInstance

describe("runtimeProviderRegistry", () => {
	it("covers every portable active/hidden provider that has a runtime handler", () => {
		expect(providerIdsWithoutRuntimeHandler).toEqual(["gemini-cli"])

		const expectedRuntimeProviderIds = activeProviderIds.filter(
			(providerId) => !providerIdsWithoutRuntimeHandler.includes(providerId as "gemini-cli"),
		)

		expect(Object.keys(runtimeProviderRegistry).sort()).toEqual([...expectedRuntimeProviderIds].sort())
		expect(runtimeProviderCases.map(([providerId]) => providerId).sort()).toEqual(
			[...expectedRuntimeProviderIds].sort(),
		)
	})

	it.each(runtimeProviderCases)("builds the %s handler and forwards its options", (apiProvider, providerClass) => {
		const handler = asMockHandler(
			buildApiHandler({
				apiProvider,
				apiModelId: "test-model",
				apiKey: "test-key",
			}),
		)

		expect(handler.providerClass).toBe(providerClass)
		expect(handler.options).toEqual({ apiModelId: "test-model", apiKey: "test-key" })
	})

	it("preserves the Anthropic Vertex selection and option forwarding for Claude models", () => {
		const handler = asMockHandler(
			buildApiHandler({
				apiProvider: "vertex",
				apiModelId: "claude-3-7-sonnet",
				vertexProjectId: "project-id",
				vertexRegion: "region",
			}),
		)

		expect(handler.providerClass).toBe("AnthropicVertexHandler")
		expect(handler.options).toEqual({
			apiModelId: "claude-3-7-sonnet",
			vertexProjectId: "project-id",
			vertexRegion: "region",
		})
	})

	it("defaults an undefined provider to Anthropic", () => {
		const handler = asMockHandler(buildApiHandler({ apiModelId: "claude-default" }))

		expect(handler.providerClass).toBe("AnthropicHandler")
		expect(handler.options).toEqual({ apiModelId: "claude-default" })
	})

	it("preserves the Anthropic fallback for a portable provider without a runtime handler", () => {
		const handler = asMockHandler(buildApiHandler({ apiProvider: "gemini-cli", apiModelId: "gemini-model" }))

		expect(handler.providerClass).toBe("AnthropicHandler")
		expect(handler.options).toEqual({ apiModelId: "gemini-model" })
	})

	it("rejects an unknown provider ID instead of executing with a fallback", () => {
		const configuration = {
			apiProvider: "future-provider",
			apiModelId: "future-model",
		} as unknown as ProviderSettings

		expect(() => buildApiHandler(configuration)).toThrow(
			'Provider "future-provider" is unknown to this version and cannot be executed.',
		)
	})

	it("continues to reject retired provider IDs before registry lookup", () => {
		expect(() => buildApiHandler({ apiProvider: "groq" })).toThrow('Sorry, provider "groq" is no longer supported.')
	})
})
