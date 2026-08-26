import {
	getActiveProviderDefinitions,
	classifyProvider,
	getProviderDefinition,
	getRetiredProviderDefinitions,
	getSelectableProviderDefinitions,
	providerRegistry,
} from "../provider-registry.js"
import {
	providerNames,
	providerNamesWithRetired,
	providerSettingsSchemaDiscriminated,
	retiredProviderNames,
	type ProviderName,
	type ProviderNameWithRetired,
} from "../provider-settings.js"

const expectedActiveProviderIds = [
	"openrouter",
	"litellm",
	"deepseek",
	"ollama",
	"lmstudio",
	"vscode-lm",
	"openai",
	"fake-ai",
	"anthropic",
	"bedrock",
	"deepseek",
	"gemini",
	"gemini-cli",
	"mistral",
	"moonshot",
	"minimax",
	"openai-codex",
	"openai-native",
	"qwen-code",
	"vertex",
	"xai",
	"zai",
] as const

const expectedRetiredProviderIds = [
	"cerebras",
	"chutes",
	"deepinfra",
	"doubao",
	"featherless",
	"groq",
	"huggingface",
	"io-intelligence",
	"baseten",
	"fireworks",
	"poe",
	"requesty",
	"sambanova",
	"unbound",
	"vercel-ai-gateway",
] as const

const expectedSelectableProviderIds = [
	"openrouter",
	"bedrock",
	"anthropic",
	"deepseek",
	"vertex",
	"gemini",
	"litellm",
	"lmstudio",
	"minimax",
	"mistral",
	"moonshot",
	"ollama",
	"openai-codex",
	"openai-native",
	"openai",
	"qwen-code",
	"vscode-lm",
	"xai",
	"zai",
] as const

describe("providerRegistry", () => {
	it("contains unique, serializable definitions", () => {
		const ids = providerRegistry.map(({ id }) => id)

		expect(new Set(ids).size).toBe(ids.length)
		expect(JSON.parse(JSON.stringify(providerRegistry))).toEqual(providerRegistry)
	})

	it("drives the public active and retired provider lists", () => {
		expect([...new Set(providerNames)]).toEqual(getActiveProviderDefinitions().map(({ id }) => id))
		expect(retiredProviderNames).toEqual(getRetiredProviderDefinitions().map(({ id }) => id))
		expect([...new Set(providerNamesWithRetired)]).toEqual(providerRegistry.map(({ id }) => id))
	})

	it("preserves stable public and display order", () => {
		expect(providerNames).toEqual(expectedActiveProviderIds)
		expect(retiredProviderNames).toEqual(expectedRetiredProviderIds)
		expect(getSelectableProviderDefinitions().map(({ id }) => id)).toEqual(expectedSelectableProviderIds)
		expect(providerNames.filter((id) => id === "deepseek")).toHaveLength(2)
	})

	it("keeps featured provider placement in portable metadata", () => {
		const featuredDefinitions = getSelectableProviderDefinitions().filter(
			(definition) => "featured" in definition && definition.featured,
		)

		expect(featuredDefinitions).toEqual([
			expect.objectContaining({ id: "openrouter", lifecycle: "active", featured: true }),
		])
	})

	it("keeps public list element types aligned with public provider types", () => {
		expectTypeOf<(typeof providerNames)[number]>().toEqualTypeOf<ProviderName>()
		expectTypeOf<(typeof providerNamesWithRetired)[number]>().toEqualTypeOf<ProviderNameWithRetired>()
	})

	it("models lifecycle and selectability without overlap", () => {
		const activeDefinitions = getActiveProviderDefinitions()
		const selectableDefinitions = getSelectableProviderDefinitions()
		const retiredDefinitions = getRetiredProviderDefinitions()
		const retiredIds = new Set<string>(retiredDefinitions.map(({ id }) => id))

		expect(activeDefinitions.every(({ lifecycle }) => lifecycle === "active" || lifecycle === "hidden")).toBe(true)
		expect(selectableDefinitions.every(({ lifecycle }) => lifecycle === "active")).toBe(true)
		expect(activeDefinitions.filter(({ lifecycle }) => lifecycle === "hidden").map(({ id }) => id)).toEqual([
			"fake-ai",
			"gemini-cli",
		])
		expect(activeDefinitions.some(({ id }) => retiredIds.has(id))).toBe(false)
	})

	it("looks up known definitions and returns undefined for unknown IDs", () => {
		expect(getProviderDefinition("anthropic")).toMatchObject({
			id: "anthropic",
			lifecycle: "active",
			label: "Anthropic",
		})
		expect(getProviderDefinition("not-a-provider")).toBeUndefined()
	})

	it("classifies known, retired, hidden, and unknown provider IDs", () => {
		expect(classifyProvider("anthropic")).toBe("known-active")
		expect(classifyProvider("fake-ai")).toBe("known-hidden")
		expect(classifyProvider("groq")).toBe("retired")
		expect(classifyProvider("future-provider")).toBe("unknown")
		expect(classifyProvider(undefined)).toBe("unknown")
	})

	it("keeps provider IDs independent from catalog source IDs", () => {
		expect(providerRegistry.find(({ id }) => id === "openai")).toMatchObject({ modelSource: "openai-compatible" })
		expect(providerRegistry.find(({ id }) => id === "anthropic")).not.toHaveProperty("modelSource")
	})

	it("has a discriminated settings schema for every active provider", () => {
		for (const providerName of providerNames) {
			expect(providerSettingsSchemaDiscriminated.safeParse({ apiProvider: providerName }).success).toBe(true)
		}
	})
})
