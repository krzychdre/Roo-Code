import type { ModelInfo } from "../model.js"

// https://docs.mistral.ai/models
// https://docs.mistral.ai/inference/pricing
// https://docs.mistral.ai/inference/model-lifecycle
export type MistralModelId = keyof typeof mistralModels

// Kept on codestral so the default keeps routing to codestral.mistral.ai, the
// dedicated code endpoint the handler selects for `codestral-` prefixed IDs.
export const mistralDefaultModelId: MistralModelId = "codestral-latest"

// Mistral retired the separate Devstral (coding) and Magistral (reasoning)
// families; Mistral Small 4 is the hybrid successor that folds instruct,
// reasoning and coding into a single model. The Pixtral line is gone too, as
// vision is now built into the general-purpose models.
//
// `-latest` aliases silently roll onto newer versions along with their pricing,
// so the dated IDs are listed alongside them for anyone who needs to pin.
//
// maxTokens is not published per model, so the previous conservative 8192
// default is kept except where the docs state a figure.
export const mistralModels = {
	"mistral-medium-latest": {
		maxTokens: 8192,
		contextWindow: 256_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 1.5,
		outputPrice: 7.5,
		description: "Mistral Medium 3.5 (v26.04), Mistral's multimodal mid-tier model.",
	},
	"mistral-small-latest": {
		maxTokens: 8192,
		contextWindow: 256_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.6,
		description:
			"Mistral Small 4 (v26.03), a hybrid model combining instruct, reasoning and coding, and the successor to the retired Devstral and Magistral families.",
	},
	"mistral-large-latest": {
		maxTokens: 8192,
		contextWindow: 256_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.5,
		outputPrice: 1.5,
		description: "Mistral Large 3 (v25.12), Mistral's multimodal flagship.",
	},
	"ministral-14b-latest": {
		maxTokens: 8192,
		contextWindow: 256_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.2,
		outputPrice: 0.2,
		description: "Ministral 3 14B (v25.12), the largest of the Ministral 3 edge models.",
	},
	"ministral-8b-latest": {
		maxTokens: 8192,
		contextWindow: 256_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.15,
		description: "Ministral 3 8B (v25.12).",
	},
	"ministral-3b-latest": {
		maxTokens: 8192,
		contextWindow: 256_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.1,
		description: "Ministral 3 3B (v25.12), the smallest of the Ministral 3 edge models.",
	},
	"codestral-latest": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.3,
		outputPrice: 0.9,
		description: "Codestral (v25.08), Mistral's dedicated code model.",
	},
	"zai-glm-5-2": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 1.4,
		outputPrice: 4.4,
		description: "Z.ai GLM 5.2, a text-only third-party model served through Mistral's platform.",
	},
} as const satisfies Record<string, ModelInfo>

export const MISTRAL_DEFAULT_TEMPERATURE = 1
