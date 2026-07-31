// npx vitest src/components/settings/__tests__/MemorySettings.spec.tsx

import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"
import { MemorySettings } from "../MemorySettings"

// Mock the translation hook — return the key so assertions can match on it.
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, onChange, children, "data-testid": dataTestId }: any) => (
		<label data-testid={dataTestId}>
			<input
				type="checkbox"
				checked={checked || false}
				onChange={(e: any) => onChange?.({ target: { checked: e.target.checked } })}
			/>
			{children}
		</label>
	),
	VSCodeTextField: ({ value, onInput, placeholder, "data-testid": dataTestId }: any) => (
		<input
			type="text"
			data-testid={dataTestId ?? "memory-directory-input"}
			value={value ?? ""}
			placeholder={placeholder}
			onInput={(e: any) => onInput?.({ target: { value: e.target.value } })}
		/>
	),
	VSCodeLink: ({ children, href }: any) => (
		<a href={href} data-testid="vscode-link">
			{children}
		</a>
	),
}))

// Mock the UI components used by MemorySettings. SelectValue renders nothing —
// the real Radix SelectValue is a display slot, not an option.
vi.mock("@/components/ui", () => ({
	Slider: ({ defaultValue, onValueChange, "data-testid": dataTestId, min, max }: any) => (
		<input
			type="range"
			data-testid={dataTestId}
			min={min}
			max={max}
			defaultValue={defaultValue?.[0] ?? 0}
			onChange={(e) => onValueChange?.([parseFloat(e.target.value)])}
			role="slider"
		/>
	),
	Select: ({ value, onValueChange, children, "data-testid": dataTestId }: any) => (
		<select data-testid={dataTestId} value={value ?? ""} onChange={(e: any) => onValueChange?.(e.target.value)}>
			{children}
		</select>
	),
	SelectTrigger: ({ children }: any) => <>{children}</>,
	SelectValue: () => null,
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
}))

const defaultProps = {
	autoMemoryEnabled: true,
	memoryRecallEnabled: true,
	autoDreamEnabled: true,
	autoDreamMinHours: 24,
	autoDreamMinSessions: 5,
	memoryWriterApiConfigId: undefined,
	listApiConfigMeta: [
		{ id: "profile-1", name: "Cheap Local" },
		{ id: "profile-2", name: "Fast Cloud" },
	],
	setCachedStateField: vi.fn(),
}

describe("MemorySettings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the section header and the enable checkbox", () => {
		render(<MemorySettings {...defaultProps} />)
		expect(screen.getByText("settings:sections.memory")).toBeInTheDocument()
		expect(screen.getByText("settings:memory.enable.label")).toBeInTheDocument()
	})

	it("calls setCachedStateField('autoMemoryEnabled', false) when the enable checkbox is toggled off", async () => {
		const setCachedStateField = vi.fn()
		render(<MemorySettings {...defaultProps} setCachedStateField={setCachedStateField} />)
		const checkbox = screen.getAllByRole("checkbox")[0]
		fireEvent.click(checkbox)
		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("autoMemoryEnabled", false)
		})
	})

	it("binds the directory input to cachedState (typing calls setCachedStateField)", async () => {
		const setCachedStateField = vi.fn()
		render(<MemorySettings {...defaultProps} setCachedStateField={setCachedStateField} autoMemoryDirectory="" />)
		const input = screen.getByTestId("memory-directory-input")
		fireEvent.input(input, { target: { value: "/custom/mem" } })
		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("autoMemoryDirectory", "/custom/mem")
		})
	})

	it("clears the directory (undefined) when the input is emptied", async () => {
		const setCachedStateField = vi.fn()
		render(<MemorySettings {...defaultProps} setCachedStateField={setCachedStateField} autoMemoryDirectory="/x" />)
		const input = screen.getByTestId("memory-directory-input")
		fireEvent.input(input, { target: { value: "" } })
		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("autoMemoryDirectory", undefined)
		})
	})

	it("calls setCachedStateField when the recall checkbox is toggled", async () => {
		const setCachedStateField = vi.fn()
		render(<MemorySettings {...defaultProps} setCachedStateField={setCachedStateField} />)
		// The recall checkbox is the second one rendered.
		const checkboxes = screen.getAllByRole("checkbox")
		const recallCheckbox = checkboxes[1]
		fireEvent.click(recallCheckbox)
		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("memoryRecallEnabled", false)
		})
	})

	it("renders the dream hours + sessions sliders when dream is enabled", () => {
		render(<MemorySettings {...defaultProps} />)
		expect(screen.getByTestId("memory-dream-hours-slider")).toBeInTheDocument()
		expect(screen.getByTestId("memory-dream-sessions-slider")).toBeInTheDocument()
	})

	it("calls setCachedStateField when the dream-hours slider changes", async () => {
		const setCachedStateField = vi.fn()
		render(<MemorySettings {...defaultProps} setCachedStateField={setCachedStateField} />)
		const slider = screen.getByTestId("memory-dream-hours-slider") as HTMLInputElement
		fireEvent.change(slider, { target: { value: "48" } })
		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("autoDreamMinHours", 48)
		})
	})

	it("hides the recall/directory/dream controls when memory is disabled", () => {
		render(<MemorySettings {...defaultProps} autoMemoryEnabled={false} />)
		// Only the enable checkbox should be present; no directory input or sliders.
		expect(screen.queryByTestId("memory-directory-input")).not.toBeInTheDocument()
		expect(screen.queryByTestId("memory-dream-hours-slider")).not.toBeInTheDocument()
	})

	it("renders the writer-profile dropdown with profiles from listApiConfigMeta", () => {
		render(<MemorySettings {...defaultProps} />)
		const select = screen.getByTestId("memory-writer-profile-select") as HTMLSelectElement
		expect(select).toBeInTheDocument()
		// The dropdown includes the "Use current profile" option plus one per profile.
		expect(screen.getByText("settings:memory.writerProfile.useCurrent")).toBeInTheDocument()
		expect(screen.getByText("Cheap Local")).toBeInTheDocument()
		expect(screen.getByText("Fast Cloud")).toBeInTheDocument()
	})

	it("never renders a SelectItem with an empty-string value (Radix rejects it at runtime)", () => {
		render(<MemorySettings {...defaultProps} />)
		const select = screen.getByTestId("memory-writer-profile-select") as HTMLSelectElement
		const optionValues = Array.from(select.querySelectorAll("option")).map((o) => o.getAttribute("value"))
		expect(optionValues.length).toBeGreaterThan(0)
		expect(optionValues).not.toContain("")
	})

	it("selecting a profile calls setCachedStateField with the profile id", async () => {
		const setCachedStateField = vi.fn()
		render(<MemorySettings {...defaultProps} setCachedStateField={setCachedStateField} />)
		const select = screen.getByTestId("memory-writer-profile-select") as HTMLSelectElement
		fireEvent.change(select, { target: { value: "profile-1" } })
		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("memoryWriterApiConfigId", "profile-1")
		})
	})

	it("selecting the 'use current profile' sentinel calls setCachedStateField with undefined", async () => {
		const setCachedStateField = vi.fn()
		render(
			<MemorySettings
				{...defaultProps}
				memoryWriterApiConfigId="profile-1"
				setCachedStateField={setCachedStateField}
			/>,
		)
		const select = screen.getByTestId("memory-writer-profile-select") as HTMLSelectElement
		fireEvent.change(select, { target: { value: "-" } })
		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("memoryWriterApiConfigId", undefined)
		})
	})
	it("toggles sharing the memory directory with Claude Code", async () => {
		const setCachedStateField = vi.fn()
		render(<MemorySettings {...defaultProps} setCachedStateField={setCachedStateField} />)

		fireEvent.click(screen.getByTestId("memory-share-claude-code-checkbox").querySelector("input")!)

		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("autoMemoryShareWithClaudeCode", true)
		})
	})

	it("explains that a custom directory overrides sharing", () => {
		const { rerender } = render(<MemorySettings {...defaultProps} />)
		expect(screen.getByText("settings:memory.shareWithClaudeCode.description")).toBeInTheDocument()

		rerender(<MemorySettings {...defaultProps} autoMemoryDirectory="/srv/memories" />)
		expect(screen.getByText("settings:memory.shareWithClaudeCode.overridden")).toBeInTheDocument()
	})
})
