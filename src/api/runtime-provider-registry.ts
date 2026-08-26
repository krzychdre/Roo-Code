import type { ActiveProviderDefinition } from "@roo-code/types"

import type { ApiHandlerOptions } from "../shared/api"

import type { ApiHandler } from "./index"
import {
	AnthropicHandler,
	AnthropicVertexHandler,
	AwsBedrockHandler,
	DeepSeekHandler,
	FakeAIHandler,
	GeminiHandler,
	LiteLLMHandler,
	LmStudioHandler,
	MiniMaxHandler,
	MistralHandler,
	MoonshotHandler,
	OpenAiCodexHandler,
	OpenAiHandler,
	OpenAiNativeHandler,
	OpenRouterHandler,
	QwenCodeHandler,
	VertexHandler,
	VsCodeLmHandler,
	XAIHandler,
	ZAiHandler,
} from "./providers"
import { NativeOllamaHandler } from "./providers/native-ollama"

type PortableActiveProviderId = ActiveProviderDefinition["id"]

/**
 * Portable active/hidden providers that do not have a dedicated runtime handler.
 *
 * `gemini-cli` is retained in the portable inventory for profile compatibility,
 * but the pre-registry factory had no matching case and therefore used the
 * Anthropic fallback. Keeping it outside the runtime registry preserves that
 * behavior without claiming that it has a runtime implementation.
 */
export const providerIdsWithoutRuntimeHandler = ["gemini-cli"] as const satisfies readonly PortableActiveProviderId[]

export type RuntimeProviderId = Exclude<PortableActiveProviderId, (typeof providerIdsWithoutRuntimeHandler)[number]>

export type RuntimeProviderFactory = (options: ApiHandlerOptions) => ApiHandler

export const runtimeProviderRegistry = {
	openrouter: (options) => new OpenRouterHandler(options),
	litellm: (options) => new LiteLLMHandler(options),
	deepseek: (options) => new DeepSeekHandler(options),
	ollama: (options) => new NativeOllamaHandler(options),
	lmstudio: (options) => new LmStudioHandler(options),
	"vscode-lm": (options) => new VsCodeLmHandler(options),
	openai: (options) => new OpenAiHandler(options),
	"fake-ai": (options) => new FakeAIHandler(options),
	anthropic: (options) => new AnthropicHandler(options),
	bedrock: (options) => new AwsBedrockHandler(options),
	gemini: (options) => new GeminiHandler(options),
	mistral: (options) => new MistralHandler(options),
	moonshot: (options) => new MoonshotHandler(options),
	minimax: (options) => new MiniMaxHandler(options),
	"openai-codex": (options) => new OpenAiCodexHandler(options),
	"openai-native": (options) => new OpenAiNativeHandler(options),
	"qwen-code": (options) => new QwenCodeHandler(options),
	vertex: (options) =>
		options.apiModelId?.startsWith("claude") ? new AnthropicVertexHandler(options) : new VertexHandler(options),
	xai: (options) => new XAIHandler(options),
	zai: (options) => new ZAiHandler(options),
} satisfies Record<RuntimeProviderId, RuntimeProviderFactory>

export const defaultRuntimeProviderId = "anthropic" satisfies RuntimeProviderId

const runtimeProviderFactoriesById: ReadonlyMap<string, RuntimeProviderFactory> = new Map(
	Object.entries(runtimeProviderRegistry),
)

export const getRuntimeProviderFactory = (providerId: string | undefined): RuntimeProviderFactory | undefined =>
	providerId ? runtimeProviderFactoriesById.get(providerId) : undefined
