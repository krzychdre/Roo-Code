export * from "./anthropic.js"
export * from "./bedrock.js"
export * from "./deepseek.js"
export * from "./gemini.js"
export * from "./lite-llm.js"
export * from "./lm-studio.js"
export * from "./mistral.js"
export * from "./moonshot.js"
export * from "./ollama.js"
export * from "./openai.js"
export * from "./openai-codex.js"
export * from "./openai-codex-rate-limits.js"
export * from "./openrouter.js"
export * from "./qwen-code.js"
export * from "./vertex.js"
export * from "./vscode-llm.js"
export * from "./xai.js"
export * from "./zai.js"
export * from "./minimax.js"

import { anthropicDefaultModelId } from "./anthropic.js"
import { bedrockDefaultModelId } from "./bedrock.js"
import { deepSeekDefaultModelId } from "./deepseek.js"
import { geminiDefaultModelId } from "./gemini.js"
import { litellmDefaultModelId } from "./lite-llm.js"
import { mistralDefaultModelId } from "./mistral.js"
import { moonshotDefaultModelId } from "./moonshot.js"
import { openAiCodexDefaultModelId } from "./openai-codex.js"
import { openRouterDefaultModelId } from "./openrouter.js"
import { qwenCodeDefaultModelId } from "./qwen-code.js"
import { vertexDefaultModelId } from "./vertex.js"
import { vscodeLlmDefaultModelId } from "./vscode-llm.js"
import { xaiDefaultModelId } from "./xai.js"
import { internationalZAiDefaultModelId, mainlandZAiDefaultModelId } from "./zai.js"
import { minimaxDefaultModelId } from "./minimax.js"

// Import the ProviderName type from provider-settings to avoid duplication
import type { ProviderName } from "../provider-settings.js"

/**
 * Get the default model ID for a given provider.
 * This function returns only the provider's default model ID, without considering user configuration.
 * Used as a fallback when provider models are still loading.
 */
export function getProviderDefaultModelId(
	provider: ProviderName,
	options: { isChina?: boolean } = { isChina: false },
): string {
	switch (provider) {
		case "openrouter":
			return openRouterDefaultModelId
		case "litellm":
			return litellmDefaultModelId
		case "xai":
			return xaiDefaultModelId
		case "bedrock":
			return bedrockDefaultModelId
		case "vertex":
			return vertexDefaultModelId
		case "gemini":
			return geminiDefaultModelId
		case "deepseek":
			return deepSeekDefaultModelId
		case "moonshot":
			return moonshotDefaultModelId
		case "minimax":
			return minimaxDefaultModelId
		case "zai":
			return options?.isChina ? mainlandZAiDefaultModelId : internationalZAiDefaultModelId
		case "openai-native":
			return "gpt-4o" // Based on openai-native patterns
		case "openai-codex":
			return openAiCodexDefaultModelId
		case "mistral":
			return mistralDefaultModelId
		case "openai":
			return "" // OpenAI provider uses custom model configuration
		case "ollama":
			return "" // Ollama uses dynamic model selection
		case "lmstudio":
			return "" // LMStudio uses dynamic model selection
		case "vscode-lm":
			return vscodeLlmDefaultModelId
		case "qwen-code":
			return qwenCodeDefaultModelId
		case "anthropic":
		case "gemini-cli":
		case "fake-ai":
		default:
			return anthropicDefaultModelId
	}
}
