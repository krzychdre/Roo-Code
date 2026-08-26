import type { ModelSourceId } from "./model-source.js"

export const providerLifecycles = ["active", "hidden", "retired"] as const

export type ProviderLifecycle = (typeof providerLifecycles)[number]

type ProviderDefinitionBase = {
	readonly id: string
	readonly lifecycle: ProviderLifecycle
	readonly modelSource?: ModelSourceId
}

export type SelectableProviderDefinition = ProviderDefinitionBase & {
	readonly lifecycle: "active"
	readonly label: string
	readonly displayOrder: number
	readonly featured?: boolean
}

export type HiddenProviderDefinition = ProviderDefinitionBase & {
	readonly lifecycle: "hidden"
	readonly label?: string
	readonly displayOrder?: number
}

export type RetiredProviderDefinition = ProviderDefinitionBase & {
	readonly lifecycle: "retired"
	readonly label?: string
	readonly displayOrder?: number
}

export type ProviderDefinition = SelectableProviderDefinition | HiddenProviderDefinition | RetiredProviderDefinition

/**
 * Portable provider inventory.
 *
 * Registry order preserves the public active-provider order (using the first
 * occurrence of each ID), followed by the historical retired-provider order.
 * Existing settings labels, selector order, and featured placement are captured
 * only for selectable providers; hidden and retired providers deliberately make
 * no UI claim yet.
 *
 * The former `providerNames` declaration contained `deepseek` twice because it
 * appeared in both the dynamic-provider list and the explicit provider list. A provider
 * identity can only occur once in the registry; retaining the first occurrence
 * keeps the public provider union and parsing behavior unchanged.
 */
export const providerRegistry = [
	{
		id: "openrouter",
		lifecycle: "active",
		label: "OpenRouter",
		displayOrder: 16,
		featured: true,
		modelSource: "openrouter",
	},
	{ id: "litellm", lifecycle: "active", label: "LiteLLM", displayOrder: 7, modelSource: "litellm" },
	{ id: "deepseek", lifecycle: "active", label: "DeepSeek", displayOrder: 3, modelSource: "deepseek" },
	{ id: "ollama", lifecycle: "active", label: "Ollama", displayOrder: 12, modelSource: "ollama" },
	{ id: "lmstudio", lifecycle: "active", label: "LM Studio", displayOrder: 8, modelSource: "lmstudio" },
	{
		id: "vscode-lm",
		lifecycle: "active",
		label: "VS Code LM API",
		displayOrder: 23,
		modelSource: "vscode-lm",
	},
	{
		id: "openai",
		lifecycle: "active",
		label: "OpenAI Compatible",
		displayOrder: 15,
		modelSource: "openai-compatible",
	},
	{ id: "fake-ai", lifecycle: "hidden" },
	{ id: "anthropic", lifecycle: "active", label: "Anthropic", displayOrder: 1 },
	{ id: "bedrock", lifecycle: "active", label: "Amazon Bedrock", displayOrder: 0 },
	{ id: "gemini", lifecycle: "active", label: "Google Gemini", displayOrder: 6 },
	{ id: "gemini-cli", lifecycle: "hidden" },
	{ id: "mistral", lifecycle: "active", label: "Mistral", displayOrder: 10 },
	{ id: "moonshot", lifecycle: "active", label: "Moonshot", displayOrder: 11 },
	{ id: "minimax", lifecycle: "active", label: "MiniMax", displayOrder: 9 },
	{ id: "openai-codex", lifecycle: "active", label: "OpenAI - ChatGPT Plus/Pro", displayOrder: 13 },
	{ id: "openai-native", lifecycle: "active", label: "OpenAI", displayOrder: 14 },
	{ id: "qwen-code", lifecycle: "active", label: "Qwen Code", displayOrder: 18 },
	{ id: "vertex", lifecycle: "active", label: "GCP Vertex AI", displayOrder: 5 },
	{ id: "xai", lifecycle: "active", label: "xAI (Grok)", displayOrder: 24 },
	{ id: "zai", lifecycle: "active", label: "Z.ai", displayOrder: 25 },
	{ id: "cerebras", lifecycle: "retired" },
	{ id: "chutes", lifecycle: "retired" },
	{ id: "deepinfra", lifecycle: "retired" },
	{ id: "doubao", lifecycle: "retired" },
	{ id: "featherless", lifecycle: "retired" },
	{ id: "groq", lifecycle: "retired" },
	{ id: "huggingface", lifecycle: "retired" },
	{ id: "io-intelligence", lifecycle: "retired" },
	{ id: "baseten", lifecycle: "retired" },
	{ id: "fireworks", lifecycle: "retired" },
	{ id: "poe", lifecycle: "retired" },
	{ id: "requesty", lifecycle: "retired" },
	{ id: "sambanova", lifecycle: "retired" },
	{ id: "unbound", lifecycle: "retired" },
	{ id: "vercel-ai-gateway", lifecycle: "retired" },
] as const satisfies readonly ProviderDefinition[]

export type ProviderRegistryEntry = (typeof providerRegistry)[number]
export type ProviderId = ProviderRegistryEntry["id"]
export type ActiveProviderDefinition = Extract<ProviderRegistryEntry, { readonly lifecycle: "active" | "hidden" }>
export type SelectableProviderRegistryEntry = Extract<ProviderRegistryEntry, { readonly lifecycle: "active" }> &
	SelectableProviderDefinition
export type RetiredProviderRegistryEntry = Extract<ProviderRegistryEntry, { readonly lifecycle: "retired" }>

export const providerClassifications = ["known-active", "known-hidden", "retired", "unknown"] as const

export type ProviderClassification = (typeof providerClassifications)[number]

type ProviderIds<TDefinitions extends readonly ProviderDefinition[]> = TDefinitions extends readonly [
	infer THead extends ProviderDefinition,
	...infer TTail extends readonly ProviderDefinition[],
]
	? readonly [THead["id"], ...ProviderIds<TTail>]
	: readonly []

type ProviderIdsByLifecycle<
	TDefinitions extends readonly ProviderDefinition[],
	TLifecycle extends ProviderLifecycle,
> = TDefinitions extends readonly [
	infer THead extends ProviderDefinition,
	...infer TTail extends readonly ProviderDefinition[],
]
	? THead["lifecycle"] extends TLifecycle
		? readonly [THead["id"], ...ProviderIdsByLifecycle<TTail, TLifecycle>]
		: ProviderIdsByLifecycle<TTail, TLifecycle>
	: readonly []

type InsertProviderIdAfter<
	TIds extends readonly string[],
	TAnchor extends TIds[number],
	TId extends TIds[number],
> = TIds extends readonly [infer THead extends string, ...infer TTail extends readonly string[]]
	? THead extends TAnchor
		? readonly [THead, TId, ...TTail]
		: readonly [THead, ...InsertProviderIdAfter<TTail, TAnchor, TId>]
	: readonly []

const selectProviderIds = <const TDefinitions extends readonly ProviderDefinition[]>(
	definitions: TDefinitions,
): ProviderIds<TDefinitions> => definitions.map(({ id }) => id) as unknown as ProviderIds<TDefinitions>

const selectProviderIdsByLifecycle = <
	const TDefinitions extends readonly ProviderDefinition[],
	const TLifecycles extends readonly ProviderLifecycle[],
>(
	definitions: TDefinitions,
	lifecycles: TLifecycles,
): ProviderIdsByLifecycle<TDefinitions, TLifecycles[number]> =>
	definitions
		.filter((definition) => lifecycles.some((lifecycle) => lifecycle === definition.lifecycle))
		.map(({ id }) => id) as unknown as ProviderIdsByLifecycle<TDefinitions, TLifecycles[number]>

const insertProviderIdAfter = <
	const TIds extends readonly string[],
	const TAnchor extends TIds[number],
	const TId extends TIds[number],
>(
	ids: TIds,
	anchor: TAnchor,
	id: TId,
): InsertProviderIdAfter<TIds, TAnchor, TId> => {
	const insertionIndex = ids.indexOf(anchor) + 1

	return [...ids.slice(0, insertionIndex), id, ...ids.slice(insertionIndex)] as unknown as InsertProviderIdAfter<
		TIds,
		TAnchor,
		TId
	>
}

const concatenateProviderIds = <const TFirst extends readonly string[], const TSecond extends readonly string[]>(
	first: TFirst,
	second: TSecond,
): readonly [...TFirst, ...TSecond] => [...first, ...second]

export const activeProviderIds = selectProviderIdsByLifecycle(providerRegistry, ["active", "hidden"])
export const retiredProviderIds = selectProviderIdsByLifecycle(providerRegistry, ["retired"])
export const providerIds = selectProviderIds(providerRegistry)

/**
 * Preserves the historical public array value, where `deepseek` occurred twice.
 * The duplicate was originally anchored after `baseten`; with `baseten` retired,
 * the duplicate now follows `bedrock` (the adjacent active provider). New
 * consumers should prefer the unique registry definitions and selectors.
 */
export const activeProviderIdsForPublicApi = insertProviderIdAfter(activeProviderIds, "bedrock", "deepseek")
export const providerIdsForPublicApi = concatenateProviderIds(activeProviderIdsForPublicApi, retiredProviderIds)

export const getProviderDefinition = (id: string): ProviderRegistryEntry | undefined =>
	providerRegistry.find((definition) => definition.id === id)

export const classifyProvider = (id: unknown): ProviderClassification => {
	if (typeof id !== "string") {
		return "unknown"
	}

	const definition = getProviderDefinition(id)
	if (!definition) {
		return "unknown"
	}

	switch (definition.lifecycle) {
		case "active":
			return "known-active"
		case "hidden":
			return "known-hidden"
		case "retired":
			return "retired"
	}
}

export const getActiveProviderDefinitions = (): readonly ActiveProviderDefinition[] =>
	providerRegistry.filter((definition): definition is ActiveProviderDefinition => definition.lifecycle !== "retired")

export const getSelectableProviderDefinitions = (): readonly SelectableProviderRegistryEntry[] =>
	providerRegistry
		.filter((definition): definition is SelectableProviderRegistryEntry => definition.lifecycle === "active")
		.sort((left, right) => {
			const leftFeatured = "featured" in left && left.featured
			const rightFeatured = "featured" in right && right.featured

			return Number(rightFeatured) - Number(leftFeatured) || left.displayOrder - right.displayOrder
		})

export const getRetiredProviderDefinitions = (): readonly RetiredProviderRegistryEntry[] =>
	providerRegistry.filter(
		(definition): definition is RetiredProviderRegistryEntry => definition.lifecycle === "retired",
	)
