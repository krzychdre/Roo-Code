import { render, screen, fireEvent } from "@testing-library/react"

import { SlimToolsetControl } from "../SlimToolsetControl"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"settings:advanced.slimToolset.label": "Slim toolset (small models)",
				"settings:advanced.slimToolset.description": "Offer this profile one obvious tool per job.",
				"settings:advanced.slimToolset.hideMcp.label": "Also hide MCP tools",
				"settings:advanced.slimToolset.hideMcp.description":
					"MCP tool schemas are usually the biggest part of the tool prompt.",
			}
			return translations[key] || key
		},
	}),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, onChange, checked, ...props }: any) => (
		<label>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange({ target: { checked: e.target.checked } })}
				{...props}
			/>
			{children}
		</label>
	),
}))

describe("SlimToolsetControl", () => {
	it("is off by default and hides the MCP sub-control", () => {
		render(<SlimToolsetControl onChange={vi.fn()} />)

		const checkboxes = screen.getAllByRole("checkbox")
		expect(checkboxes).toHaveLength(1)
		expect(checkboxes[0]).not.toBeChecked()
		expect(screen.queryByText("Also hide MCP tools")).not.toBeInTheDocument()
	})

	it("turns the slim toolset on", () => {
		const onChange = vi.fn()
		render(<SlimToolsetControl onChange={onChange} />)

		fireEvent.click(screen.getByRole("checkbox"))

		expect(onChange).toHaveBeenCalledWith("slimToolset", true)
	})

	it("reveals the MCP sub-control, checked, when an undefined slimHidesMcp means hide", () => {
		render(<SlimToolsetControl slimToolset={true} onChange={vi.fn()} />)

		const [slim, hideMcp] = screen.getAllByRole("checkbox")
		expect(slim).toBeChecked()
		expect(hideMcp).toBeChecked()
	})

	it("shows the MCP sub-control unchecked only when it is explicitly false", () => {
		const onChange = vi.fn()
		render(<SlimToolsetControl slimToolset={true} slimHidesMcp={false} onChange={onChange} />)

		const [, hideMcp] = screen.getAllByRole("checkbox")
		expect(hideMcp).not.toBeChecked()

		fireEvent.click(hideMcp)
		expect(onChange).toHaveBeenCalledWith("slimHidesMcp", true)
	})

	it("writes an explicit false when the user unchecks the MCP sub-control", () => {
		const onChange = vi.fn()
		render(<SlimToolsetControl slimToolset={true} onChange={onChange} />)

		fireEvent.click(screen.getAllByRole("checkbox")[1])

		expect(onChange).toHaveBeenCalledWith("slimHidesMcp", false)
	})
})
