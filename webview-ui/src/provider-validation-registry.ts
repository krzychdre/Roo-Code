import type { ProviderName, ProviderSettings } from "@roo-code/types"

export type ProviderValidationStrategy =
	| { readonly kind: "none" }
	| {
			readonly kind: "required-fields"
			readonly fields: readonly (keyof ProviderSettings)[]
			readonly message:
				| "settings:validation.apiKey"
				| "settings:validation.awsRegion"
				| "settings:validation.googleCloud"
				| "settings:validation.openAi"
				| "settings:validation.modelId"
				| "settings:validation.modelSelector"
				| "settings:validation.qwenCodeOauthPath"
	  }

type ProviderValidationRegistry = {
	[provider in ProviderName]: ProviderValidationStrategy
}

const noValidation = { kind: "none" } as const
const apiKeyValidation = (field: keyof ProviderSettings) =>
	({ kind: "required-fields", fields: [field], message: "settings:validation.apiKey" }) as const

export const providerValidationRegistry = {
	openrouter: apiKeyValidation("openRouterApiKey"),
	litellm: apiKeyValidation("litellmApiKey"),
	deepseek: noValidation,
	ollama: { kind: "required-fields", fields: ["ollamaModelId"], message: "settings:validation.modelId" },
	lmstudio: { kind: "required-fields", fields: ["lmStudioModelId"], message: "settings:validation.modelId" },
	"vscode-lm": {
		kind: "required-fields",
		fields: ["vsCodeLmModelSelector"],
		message: "settings:validation.modelSelector",
	},
	openai: {
		kind: "required-fields",
		fields: ["openAiBaseUrl", "openAiApiKey", "openAiModelId"],
		message: "settings:validation.openAi",
	},
	"fake-ai": noValidation,
	anthropic: apiKeyValidation("apiKey"),
	bedrock: { kind: "required-fields", fields: ["awsRegion"], message: "settings:validation.awsRegion" },
	gemini: apiKeyValidation("geminiApiKey"),
	"gemini-cli": noValidation,
	mistral: apiKeyValidation("mistralApiKey"),
	moonshot: noValidation,
	minimax: noValidation,
	"openai-codex": noValidation,
	"openai-native": apiKeyValidation("openAiNativeApiKey"),
	"qwen-code": {
		kind: "required-fields",
		fields: ["qwenCodeOauthPath"],
		message: "settings:validation.qwenCodeOauthPath",
	},
	vertex: {
		kind: "required-fields",
		fields: ["vertexProjectId", "vertexRegion"],
		message: "settings:validation.googleCloud",
	},
	xai: noValidation,
	zai: noValidation,
} satisfies ProviderValidationRegistry
