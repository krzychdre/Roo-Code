import type { ModelInfo } from "../model.js"

// https://platform.deepseek.com/docs/api
// preserveReasoning enables interleaved thinking mode for tool calls:
// DeepSeek requires reasoning_content to be passed back during tool call
// continuation within the same turn. See: https://api-docs.deepseek.com/guides/thinking_mode
export type DeepSeekModelId = keyof typeof deepSeekModels

export const deepSeekDefaultModelId: DeepSeekModelId = "deepseek-v4-flash"

// DeepSeek prices vary by time of day: standard (peak) rates apply 01:00-04:00
// and 06:00-10:00 UTC on weekdays, and off-peak rates are exactly half. The
// figures below are the standard (peak) rates so cost estimates never come in
// under what the user is actually charged.
export const deepSeekModels = {
	"deepseek-v4-flash": {
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoningEffort: ["disable", "low", "medium", "high", "xhigh"],
		preserveReasoning: true,
		reasoningEffort: "high",
		inputPrice: 0.44, // $0.44 per million tokens (cache miss, standard rate) - Updated Aug 26, 2026
		outputPrice: 1.32, // $1.32 per million tokens (standard rate) - Updated Aug 26, 2026
		cacheWritesPrice: 0.44, // $0.44 per million tokens (cache miss, standard rate) - Updated Aug 26, 2026
		cacheReadsPrice: 0.014, // $0.014 per million tokens (cache hit, standard rate) - Updated Aug 26, 2026
		description: `DeepSeek-V4-Flash is DeepSeek's fast, cost-efficient V4 model. It supports thinking and non-thinking modes, JSON output, tool calls, chat prefix completion (beta), and FIM completion (beta) in non-thinking mode.`,
	},
	"deepseek-v4-pro": {
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoningEffort: ["disable", "low", "medium", "high", "xhigh"],
		preserveReasoning: true,
		reasoningEffort: "high",
		inputPrice: 1.32, // $1.32 per million tokens (cache miss, standard rate) - Updated Aug 26, 2026
		outputPrice: 3.96, // $3.96 per million tokens (standard rate) - Updated Aug 26, 2026
		cacheWritesPrice: 1.32, // $1.32 per million tokens (cache miss, standard rate) - Updated Aug 26, 2026
		cacheReadsPrice: 0.044, // $0.044 per million tokens (cache hit, standard rate) - Updated Aug 26, 2026
		description: `DeepSeek-V4-Pro is DeepSeek's strongest V4 model for reasoning, coding, long-context, and agentic workloads. It supports thinking and non-thinking modes, JSON output, tool calls, chat prefix completion (beta), and FIM completion (beta) in non-thinking mode.`,
	},
	"deepseek-v4-flash-vision-exp": {
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["disable", "low", "medium", "high", "xhigh"],
		preserveReasoning: true,
		reasoningEffort: "high",
		inputPrice: 0.44, // $0.44 per million tokens (cache miss, standard rate) - Updated Aug 26, 2026
		outputPrice: 1.32, // $1.32 per million tokens (standard rate) - Updated Aug 26, 2026
		cacheWritesPrice: 0.44, // $0.44 per million tokens (cache miss, standard rate) - Updated Aug 26, 2026
		cacheReadsPrice: 0.014, // $0.014 per million tokens (cache hit, standard rate) - Updated Aug 26, 2026
		description: `DeepSeek-V4-Flash-Vision-Exp is the experimental vision variant of V4-Flash, priced identically but able to read images. FIM completion is not available on this model.`,
	},
} as const satisfies Record<string, ModelInfo>

// https://api-docs.deepseek.com/quick_start/parameter_settings
export const DEEP_SEEK_DEFAULT_TEMPERATURE = 0.3
