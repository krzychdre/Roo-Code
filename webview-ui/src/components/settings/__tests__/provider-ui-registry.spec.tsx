import { providerNames, type ProviderName } from "@roo-code/types"

import { providerValidationRegistry } from "@src/provider-validation-registry"

import {
	getProviderUiDefinition,
	providerUiRegistry,
	renderProviderForm,
	type ProviderFormDefinition,
	type ProviderFormRenderContext,
} from "../provider-ui-registry"

const expectedFormIds = {
	openrouter: "openrouter",
	litellm: "litellm",
	deepseek: "deepseek",
	ollama: "ollama",
	lmstudio: "lmstudio",
	"vscode-lm": "vscode-lm",
	openai: "openai-compatible",
	anthropic: "anthropic",
	bedrock: "bedrock",
	gemini: "gemini",
	mistral: "mistral",
	moonshot: "moonshot",
	minimax: "minimax",
	"openai-codex": "openai-codex",
	"openai-native": "openai-native",
	"qwen-code": "qwen-code",
	vertex: "vertex",
	xai: "xai",
	zai: "zai",
} as const satisfies Partial<Record<ProviderName, string>>

describe("providerUiRegistry", () => {
	it("is complete for every portable provider and references the shared validation contract", () => {
		expect(Object.keys(providerUiRegistry).sort()).toEqual([...new Set(providerNames)].sort())

		for (const provider of providerNames) {
			expect(providerUiRegistry[provider].validation).toBe(providerValidationRegistry[provider])
		}
	})

	it.each(Object.entries(expectedFormIds) as [ProviderName, string][])(
		"routes %s to the %s form adapter",
		(provider, formId) => {
			expect(getProviderUiDefinition(provider)).toMatchObject({ status: "form", formId })
		},
	)

	it("documents providers that intentionally have no form", () => {
		expect(getProviderUiDefinition("fake-ai")).toEqual({
			status: "no-form",
			reason: "hidden-test-provider",
			validation: providerValidationRegistry["fake-ai"],
		})
		expect(getProviderUiDefinition("gemini-cli")).toEqual({
			status: "no-form",
			reason: "headless-provider",
			validation: providerValidationRegistry["gemini-cli"],
		})
	})

	it("keeps the OpenAI alias routing explicit", () => {
		expect(getProviderUiDefinition("openai")).toMatchObject({ status: "form", formId: "openai-compatible" })
		expect(getProviderUiDefinition("openai-native")).toMatchObject({ status: "form", formId: "openai-native" })
		expect(getProviderUiDefinition("openai-codex")).toMatchObject({ status: "form", formId: "openai-codex" })
	})

	it("dispatches rendering through the selected adapter and keeps explicit exceptions empty", () => {
		const anthropic = getProviderUiDefinition("anthropic") as ProviderFormDefinition
		const render = vi.spyOn(anthropic, "render").mockReturnValue(<div data-testid="anthropic-adapter" />)
		const context = {} as ProviderFormRenderContext

		expect(renderProviderForm("anthropic", context)).toMatchObject({
			type: "div",
			props: { "data-testid": "anthropic-adapter" },
		})
		expect(render).toHaveBeenCalledWith(context)
		expect(renderProviderForm("gemini-cli", context)).toBeNull()

		render.mockRestore()
	})
})
