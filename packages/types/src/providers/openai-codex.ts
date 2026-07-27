import type { ModelInfo } from "../model.js"

/**
 * OpenAI Codex Provider
 *
 * This provider uses OAuth authentication via ChatGPT Plus/Pro subscription
 * instead of direct API keys. Requests are routed to the Codex backend at
 * https://chatgpt.com/backend-api/codex/responses
 */

export type OpenAiCodexModelId = keyof typeof openAiCodexModels

export const openAiCodexDefaultModelId: OpenAiCodexModelId = "gpt-5.6-sol"

/**
 * The Codex backend rejects `max_output_tokens`, so this provider never sends it
 * (see `buildRequestBody` in `src/api/providers/openai-codex.ts`). `maxTokens` here
 * is therefore purely a bookkeeping value: it is what `getModelMaxOutputTokens`
 * reserves out of the context window for the response, which in turn sets the
 * auto-condense/truncation threshold (`contextWindow * 0.9 - reservedTokens`).
 *
 * GPT-5 model IDs bypass the usual 20%-of-context clamp in `getModelMaxOutputTokens`,
 * so on the 200k subscription window the reserve must be kept at 20% by hand —
 * otherwise a 128k reserve leaves only ~52k of usable context and condensing fires
 * almost immediately.
 */
const SUBSCRIPTION_200K_MAX_OUTPUT_TOKENS = 40_000

const commonSubscriptionModelInfo = {
	includedTools: ["apply_patch"],
	excludedTools: ["apply_diff", "write_to_file"],
	supportsPromptCache: true,
	inputPrice: 0,
	outputPrice: 0,
	supportsTemperature: false,
} satisfies Partial<ModelInfo>

/** Models currently documented for Codex with ChatGPT sign-in. */
export const openAiCodexModels = {
	"gpt-5.6-sol": {
		...commonSubscriptionModelInfo,
		maxTokens: SUBSCRIPTION_200K_MAX_OUTPUT_TOKENS,
		contextWindow: 200_000,
		supportsImages: true,
		supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
		reasoningEffort: "medium",
		supportsVerbosity: true,
		description:
			"GPT-5.6 Sol: Flagship model for complex coding, computer use, research, and cybersecurity via ChatGPT subscription",
	},
	"gpt-5.6-terra": {
		...commonSubscriptionModelInfo,
		maxTokens: SUBSCRIPTION_200K_MAX_OUTPUT_TOKENS,
		contextWindow: 200_000,
		supportsImages: true,
		supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
		reasoningEffort: "medium",
		supportsVerbosity: true,
		description: "GPT-5.6 Terra: Balanced model for everyday coding and knowledge work via ChatGPT subscription",
	},
	"gpt-5.6-luna": {
		...commonSubscriptionModelInfo,
		maxTokens: SUBSCRIPTION_200K_MAX_OUTPUT_TOKENS,
		contextWindow: 200_000,
		supportsImages: true,
		supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
		reasoningEffort: "medium",
		supportsVerbosity: true,
		description: "GPT-5.6 Luna: Fast model for clear, repeatable, high-volume work via ChatGPT subscription",
	},
	"gpt-5.5": {
		...commonSubscriptionModelInfo,
		maxTokens: SUBSCRIPTION_200K_MAX_OUTPUT_TOKENS,
		contextWindow: 200_000,
		supportsImages: true,
		supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh"],
		reasoningEffort: "medium",
		supportsVerbosity: true,
		description: "GPT-5.5: Previous-generation frontier model via ChatGPT subscription",
	},
	"gpt-5.3-codex-spark": {
		...commonSubscriptionModelInfo,
		maxTokens: 8_192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
		reasoningEffort: "medium",
		description: "GPT-5.3 Codex Spark: Fast, text-only preview available to ChatGPT Pro users",
	},
	"gpt-5.4": {
		...commonSubscriptionModelInfo,
		maxTokens: SUBSCRIPTION_200K_MAX_OUTPUT_TOKENS,
		contextWindow: 200_000,
		supportsImages: true,
		supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh"],
		reasoningEffort: "none",
		supportsVerbosity: true,
		description: "GPT-5.4: Frontier model for professional work via ChatGPT subscription",
	},
	"gpt-5.4-mini": {
		...commonSubscriptionModelInfo,
		maxTokens: SUBSCRIPTION_200K_MAX_OUTPUT_TOKENS,
		contextWindow: 200_000,
		supportsImages: true,
		supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh"],
		reasoningEffort: "none",
		supportsVerbosity: true,
		description: "GPT-5.4 Mini: Fast model for responsive coding tasks and subagents via ChatGPT subscription",
	},
} as const satisfies Record<string, ModelInfo>
