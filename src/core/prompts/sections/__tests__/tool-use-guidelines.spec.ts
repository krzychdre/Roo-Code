import { getToolUseGuidelinesSection } from "../tool-use-guidelines"

describe("getToolUseGuidelinesSection", () => {
	it("should include proper numbered guidelines", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).toContain("1. Assess what information")
		expect(guidelines).toContain("2. Choose the most appropriate tool")
		expect(guidelines).toContain("3. Batch by default")
		expect(guidelines).toContain("4. Use a separate message only when")
	})

	it("should make batching the default rather than an option", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).toContain("call every tool whose input you already know")
		expect(guidelines).not.toContain("use one tool at a time per message")
		// "may" reads as "need not" to a weak model, and an absolute "each step must be
		// informed by the previous step's result" forbids the batching the next line asks
		// for. Both are why tools/msg sat at 1.30 in code mode.
		expect(guidelines).not.toContain("you may use multiple tools in a single message")
		expect(guidelines).not.toContain("Each step must be informed by the previous step's result")
	})

	it("should keep the genuine dependency constraint", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).toContain("literally depends on another tool's output")
		expect(guidelines).toContain("Do not assume the outcome of any tool use")
	})

	it("should use simplified footer without step-by-step language", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).toContain("carefully considering the user's response after tool executions")
		expect(guidelines).not.toContain("It is crucial to proceed step-by-step")
		expect(guidelines).not.toContain("ALWAYS wait for user confirmation after each tool use")
	})

	it("should include common guidance", () => {
		const guidelines = getToolUseGuidelinesSection()
		expect(guidelines).toContain("Assess what information you already have")
		expect(guidelines).toContain("Choose the most appropriate tool")
		expect(guidelines).not.toContain("<actual_tool_name>")
	})

	it("should not include per-tool confirmation guidelines", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).not.toContain("After each tool use, the user will respond with the result")
	})
})
