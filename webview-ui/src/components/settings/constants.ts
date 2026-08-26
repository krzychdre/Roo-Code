import {
	type ProviderName,
	type ModelInfo,
	anthropicModels,
	bedrockModels,
	deepSeekModels,
	moonshotModels,
	geminiModels,
	mistralModels,
	openAiNativeModels,
	openAiCodexModels,
	qwenCodeModels,
	vertexModels,
	xaiModels,
	internationalZAiModels,
	minimaxModels,
	getSelectableProviderDefinitions,
} from "@roo-code/types"

export const MODELS_BY_PROVIDER: Partial<Record<ProviderName, Record<string, ModelInfo>>> = {
	anthropic: anthropicModels,
	bedrock: bedrockModels,
	deepseek: deepSeekModels,
	moonshot: moonshotModels,
	gemini: geminiModels,
	mistral: mistralModels,
	"openai-native": openAiNativeModels,
	"openai-codex": openAiCodexModels,
	"qwen-code": qwenCodeModels,
	vertex: vertexModels,
	xai: xaiModels,
	zai: internationalZAiModels,
	minimax: minimaxModels,
}

const PROXY_PROVIDER_IDS = new Set<ProviderName>(["openai", "lmstudio", "ollama", "litellm"])

// Compatibility view for webview consumers; provider inventory, labels, order, and lifecycle live in the portable registry.
export const PROVIDERS = getSelectableProviderDefinitions().map(({ id, label }) => ({
	value: id,
	label,
	proxy: PROXY_PROVIDER_IDS.has(id),
}))
