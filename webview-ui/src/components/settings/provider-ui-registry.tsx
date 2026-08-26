import type { ModelInfo, OrganizationAllowList, ProviderName, ProviderSettings, RouterModels } from "@roo-code/types"

import { providerValidationRegistry, type ProviderValidationStrategy } from "@src/provider-validation-registry"

import {
	Anthropic,
	Bedrock,
	DeepSeek,
	Gemini,
	LMStudio,
	LiteLLM,
	MiniMax,
	Mistral,
	Moonshot,
	Ollama,
	OpenAI,
	OpenAICompatible,
	OpenAICodex,
	OpenRouter,
	QwenCode,
	Vertex,
	VSCodeLM,
	XAI,
	ZAi,
} from "./providers"

type SetApiConfigurationField = <K extends keyof ProviderSettings>(
	field: K,
	value: ProviderSettings[K],
	isUserAction?: boolean,
) => void

export type ProviderFormRenderContext = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: SetApiConfigurationField
	uriScheme: string | undefined
	simplifySettings: boolean | undefined
	routerModels: RouterModels | undefined
	refetchRouterModels: () => void
	organizationAllowList: OrganizationAllowList
	modelValidationError: string | undefined
	selectedModelId: string
	selectedModelInfo: ModelInfo | undefined
	openAiCodexIsAuthenticated: boolean | undefined
}

export type ProviderFormId =
	| "anthropic"
	| "bedrock"
	| "deepseek"
	| "gemini"
	| "lmstudio"
	| "litellm"
	| "minimax"
	| "mistral"
	| "moonshot"
	| "ollama"
	| "openai-codex"
	| "openai-compatible"
	| "openai-native"
	| "openrouter"
	| "qwen-code"
	| "vertex"
	| "vscode-lm"
	| "xai"
	| "zai"

export type ProviderFormDefinition = {
	readonly status: "form"
	readonly formId: ProviderFormId
	readonly validation: ProviderValidationStrategy
	readonly render: (context: ProviderFormRenderContext) => React.ReactNode
}

type ProviderFormException = {
	readonly status: "no-form"
	readonly reason: "hidden-test-provider" | "headless-provider"
	readonly validation: ProviderValidationStrategy
}

export type ProviderUiDefinition = ProviderFormDefinition | ProviderFormException

type ProviderUiRegistry = {
	[provider in ProviderName]: ProviderUiDefinition
}

const withValidation = <TDefinition extends Omit<ProviderUiDefinition, "validation">>(
	provider: ProviderName,
	definition: TDefinition,
): TDefinition & { readonly validation: ProviderValidationStrategy } => ({
	...definition,
	validation: providerValidationRegistry[provider],
})

const simpleForm = (
	provider: ProviderName,
	formId: ProviderFormId,
	render: ProviderFormDefinition["render"],
): ProviderFormDefinition => withValidation(provider, { status: "form", formId, render })

export const providerUiRegistry = {
	openrouter: simpleForm("openrouter", "openrouter", (context) => (
		<OpenRouter
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
			routerModels={context.routerModels}
			selectedModelId={context.selectedModelId}
			uriScheme={context.uriScheme}
			simplifySettings={context.simplifySettings}
			organizationAllowList={context.organizationAllowList}
			modelValidationError={context.modelValidationError}
		/>
	)),
	litellm: simpleForm("litellm", "litellm", (context) => (
		<LiteLLM
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
			organizationAllowList={context.organizationAllowList}
			modelValidationError={context.modelValidationError}
			simplifySettings={context.simplifySettings}
		/>
	)),
	deepseek: simpleForm("deepseek", "deepseek", (context) => (
		<DeepSeek
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
			simplifySettings={context.simplifySettings}
		/>
	)),
	ollama: simpleForm("ollama", "ollama", (context) => (
		<Ollama
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
		/>
	)),
	lmstudio: simpleForm("lmstudio", "lmstudio", (context) => (
		<LMStudio
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
		/>
	)),
	"vscode-lm": simpleForm("vscode-lm", "vscode-lm", (context) => (
		<VSCodeLM
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
		/>
	)),
	openai: simpleForm("openai", "openai-compatible", (context) => (
		<OpenAICompatible
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
			organizationAllowList={context.organizationAllowList}
			modelValidationError={context.modelValidationError}
			simplifySettings={context.simplifySettings}
		/>
	)),
	"fake-ai": withValidation("fake-ai", { status: "no-form", reason: "hidden-test-provider" }),
	anthropic: simpleForm("anthropic", "anthropic", (context) => (
		<Anthropic
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
			simplifySettings={context.simplifySettings}
		/>
	)),
	bedrock: simpleForm("bedrock", "bedrock", (context) => (
		<Bedrock
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
			selectedModelInfo={context.selectedModelInfo}
			simplifySettings={context.simplifySettings}
		/>
	)),
	gemini: simpleForm("gemini", "gemini", (context) => (
		<Gemini
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
		/>
	)),
	"gemini-cli": withValidation("gemini-cli", { status: "no-form", reason: "headless-provider" }),
	mistral: simpleForm("mistral", "mistral", (context) => (
		<Mistral
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
			simplifySettings={context.simplifySettings}
		/>
	)),
	moonshot: simpleForm("moonshot", "moonshot", (context) => (
		<Moonshot
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
			simplifySettings={context.simplifySettings}
		/>
	)),
	minimax: simpleForm("minimax", "minimax", (context) => (
		<MiniMax
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
		/>
	)),
	"openai-codex": simpleForm("openai-codex", "openai-codex", (context) => (
		<OpenAICodex
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
			simplifySettings={context.simplifySettings}
			openAiCodexIsAuthenticated={context.openAiCodexIsAuthenticated}
		/>
	)),
	"openai-native": simpleForm("openai-native", "openai-native", (context) => (
		<OpenAI
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
			selectedModelInfo={context.selectedModelInfo}
			simplifySettings={context.simplifySettings}
		/>
	)),
	"qwen-code": simpleForm("qwen-code", "qwen-code", (context) => (
		<QwenCode
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
			simplifySettings={context.simplifySettings}
		/>
	)),
	vertex: simpleForm("vertex", "vertex", (context) => (
		<Vertex
			apiConfiguration={context.apiConfiguration}
			setApiConfigurationField={context.setApiConfigurationField}
		/>
	)),
	xai: simpleForm("xai", "xai", (context) => (
		<XAI apiConfiguration={context.apiConfiguration} setApiConfigurationField={context.setApiConfigurationField} />
	)),
	zai: simpleForm("zai", "zai", (context) => (
		<ZAi apiConfiguration={context.apiConfiguration} setApiConfigurationField={context.setApiConfigurationField} />
	)),
} satisfies ProviderUiRegistry

export const getProviderUiDefinition = (provider: ProviderName): ProviderUiDefinition => providerUiRegistry[provider]

export const renderProviderForm = (provider: ProviderName, context: ProviderFormRenderContext): React.ReactNode => {
	const definition = getProviderUiDefinition(provider)
	return definition.status === "form" ? definition.render(context) : null
}
