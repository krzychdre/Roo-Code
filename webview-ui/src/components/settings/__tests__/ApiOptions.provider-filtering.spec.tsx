import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import {
	getSelectableProviderDefinitions,
	providerRegistry,
	type ProviderSettings,
	type OrganizationAllowList,
} from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"

import ApiOptions from "../ApiOptions"
import { MODELS_BY_PROVIDER } from "../constants"

// Mock the extension state context
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(() => ({
		organizationAllowList: undefined,
		cloudIsAuthenticated: false,
	})),
}))

// Mock the translation hook
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Mock vscode
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock the router models hook
vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: () => ({
		data: null,
		refetch: vi.fn(),
	}),
}))

// Mock the selected model hook
vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: vi.fn(() => ({
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		info: null,
	})),
}))

// Mock the OpenRouter model providers hook
vi.mock("@src/components/ui/hooks/useOpenRouterModelProviders", () => ({
	useOpenRouterModelProviders: () => ({
		data: null,
	}),
	OPENROUTER_DEFAULT_PROVIDER_NAME: "Auto",
}))

// Mock the SearchableSelect component to capture the options passed to it
vi.mock("@src/components/ui", () => ({
	SearchableSelect: ({ options, ...props }: any) => {
		// Store the options in a data attribute for testing
		return (
			<div data-testid="searchable-select" data-options={JSON.stringify(options)} {...props}>
				{options.map((opt: any) => (
					<div key={opt.value} data-testid={`option-${opt.value}`}>
						{opt.label}
					</div>
				))}
			</div>
		)
	},
	Select: ({ children }: any) => <div>{children}</div>,
	SelectTrigger: ({ children }: any) => <div>{children}</div>,
	SelectValue: ({ placeholder }: any) => <div>{placeholder}</div>,
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value }: any) => <div data-value={value}>{children}</div>,
	Collapsible: ({ children }: any) => <div>{children}</div>,
	CollapsibleTrigger: ({ children }: any) => <div>{children}</div>,
	CollapsibleContent: ({ children }: any) => <div>{children}</div>,
	Slider: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
	// Add Popover components for ModelPicker
	Popover: ({ children }: any) => <div>{children}</div>,
	PopoverTrigger: ({ children }: any) => <div>{children}</div>,
	PopoverContent: ({ children }: any) => <div>{children}</div>,
	// Add Command components for ModelPicker
	Command: ({ children }: any) => <div>{children}</div>,
	CommandInput: ({ ...props }: any) => <input {...props} />,
	CommandList: ({ children }: any) => <div>{children}</div>,
	CommandEmpty: ({ children }: any) => <div>{children}</div>,
	CommandGroup: ({ children }: any) => <div>{children}</div>,
	CommandItem: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}))

describe("ApiOptions Provider Filtering", () => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
		},
	})

	const defaultProps = {
		uriScheme: "vscode",
		apiConfiguration: {
			apiProvider: "anthropic",
			apiKey: "test-key",
		} as ProviderSettings,
		setApiConfigurationField: vi.fn(),
		fromWelcomeView: false,
		errorMessage: undefined,
		setErrorMessage: vi.fn(),
	}

	const expectedProviderOptions = [
		{ value: "openrouter", label: "OpenRouter" },
		{ value: "bedrock", label: "Amazon Bedrock" },
		{ value: "anthropic", label: "Anthropic" },
		{ value: "deepseek", label: "DeepSeek" },
		{ value: "vertex", label: "GCP Vertex AI" },
		{ value: "gemini", label: "Google Gemini" },
		{ value: "litellm", label: "LiteLLM" },
		{ value: "lmstudio", label: "LM Studio" },
		{ value: "minimax", label: "MiniMax" },
		{ value: "mistral", label: "Mistral" },
		{ value: "moonshot", label: "Moonshot" },
		{ value: "ollama", label: "Ollama" },
		{ value: "openai-codex", label: "OpenAI - ChatGPT Plus/Pro" },
		{ value: "openai-native", label: "OpenAI" },
		{ value: "openai", label: "OpenAI Compatible" },
		{ value: "qwen-code", label: "Qwen Code" },
		{ value: "vscode-lm", label: "VS Code LM API" },
		{ value: "xai", label: "xAI (Grok)" },
		{ value: "zai", label: "Z.ai" },
	]

	const renderWithProviders = (props = defaultProps) => {
		return render(
			<QueryClientProvider client={queryClient}>
				<ApiOptions {...props} />
			</QueryClientProvider>,
		)
	}

	const getProviderOptions = () => {
		const selectElement = screen.getByTestId("provider-select")
		return JSON.parse(selectElement.getAttribute("data-options") || "[]") as Array<{
			value: string
			label: string
		}>
	}

	it("should derive selectable provider order and labels from the portable registry", () => {
		renderWithProviders()

		const registryOptions = getSelectableProviderDefinitions().map(({ id, label }) => ({ value: id, label }))

		expect(registryOptions).toEqual(expectedProviderOptions)
		expect(getProviderOptions()).toEqual(expectedProviderOptions)
	})

	it("should exclude hidden and retired registry providers from standard selection", () => {
		renderWithProviders()

		const providerValues = getProviderOptions().map(({ value }) => value)
		const nonSelectableProviderIds = providerRegistry
			.filter(({ lifecycle }) => lifecycle !== "active")
			.map(({ id }) => id)

		expect(providerValues).not.toEqual(expect.arrayContaining(nonSelectableProviderIds))
	})

	it("should show all providers when no organization allow list is provided", () => {
		renderWithProviders()

		const options = getProviderOptions()

		// Should include both static and dynamic providers
		const providerValues = options.map((opt: any) => opt.value)
		expect(providerValues).toContain("anthropic") // static provider
		expect(providerValues).toContain("openrouter") // dynamic provider
		expect(providerValues).toContain("ollama") // dynamic provider
	})

	it("should hide static registry providers with empty models", () => {
		const originalModels = MODELS_BY_PROVIDER.gemini
		MODELS_BY_PROVIDER.gemini = {}
		renderWithProviders()

		const providerValues = getProviderOptions().map(({ value }) => value)

		// Should NOT include the empty static provider
		expect(providerValues).not.toContain("gemini")

		MODELS_BY_PROVIDER.gemini = originalModels
	})

	it("should always show dynamic providers even if they have no models yet", () => {
		renderWithProviders()

		const providerValues = getProviderOptions().map(({ value }) => value)

		// Dynamic providers (not in MODELS_BY_PROVIDER) should always be shown
		expect(providerValues).toContain("openrouter")
		expect(providerValues).toContain("ollama")
		expect(providerValues).toContain("lmstudio")
		expect(providerValues).toContain("litellm")
		expect(providerValues).toContain("deepseek")
	})

	it("should filter static providers based on organization allow list", () => {
		// Create a mock organization allow list that only allows certain models
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: {
				anthropic: {
					allowAll: false,
					models: ["claude-3-5-sonnet-20241022"], // Only allow one model
				},
				gemini: {
					allowAll: false,
					models: [], // No models allowed
				},
				openrouter: {
					allowAll: true, // Dynamic provider with all models allowed
				},
			},
		}

		// Mock the extension state with the allow list
		vi.mocked(useExtensionState).mockReturnValue({
			organizationAllowList: allowList,
			cloudIsAuthenticated: false,
		} as any)

		renderWithProviders()

		const providerValues = getProviderOptions().map(({ value }) => value)

		// Should include anthropic (has allowed models)
		expect(providerValues).toContain("anthropic")

		// Should NOT include gemini (no allowed models)
		expect(providerValues).not.toContain("gemini")

		// Should include openrouter (dynamic provider)
		expect(providerValues).toContain("openrouter")

		// Should NOT include providers not in the allow list
		expect(providerValues).not.toContain("openai-native")
		expect(providerValues).not.toContain("mistral")
	})

	it("should show static provider when allowAll is true for that provider", () => {
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: {
				anthropic: {
					allowAll: true, // Allow all models for this provider
				},
			},
		}

		vi.mocked(useExtensionState).mockReturnValue({
			organizationAllowList: allowList,
			cloudIsAuthenticated: false,
		} as any)

		renderWithProviders()

		const providerValues = getProviderOptions().map(({ value }) => value)

		// Should include anthropic since allowAll is true
		expect(providerValues).toContain("anthropic")
	})

	it("should always show currently selected registry provider even if it has no models", () => {
		const originalModels = MODELS_BY_PROVIDER.anthropic
		MODELS_BY_PROVIDER.anthropic = {}
		// Create a mock organization allow list that allows the provider but no models
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: {
				anthropic: {
					allowAll: true, // Allow the provider itself, but it has no models in MODELS_BY_PROVIDER
				},
				openrouter: {
					allowAll: true,
				},
			},
		}

		vi.mocked(useExtensionState).mockReturnValue({
			organizationAllowList: allowList,
			cloudIsAuthenticated: false,
		} as any)

		// Mock the selected model hook to return anthropic as the selected provider
		;(useSelectedModel as any).mockReturnValue({
			provider: "anthropic",
			id: undefined,
			info: null,
		})

		// Render with anthropic as the selected provider
		const props = {
			...defaultProps,
			apiConfiguration: {
				...defaultProps.apiConfiguration,
				apiProvider: "anthropic",
			} as ProviderSettings,
		}

		renderWithProviders(props)

		const providerValues = getProviderOptions().map(({ value }) => value)

		expect(providerValues).toContain("anthropic")
		expect(providerValues).toContain("openrouter")

		MODELS_BY_PROVIDER.anthropic = originalModels
	})
})
