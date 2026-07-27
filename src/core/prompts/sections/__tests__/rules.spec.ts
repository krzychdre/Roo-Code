vi.mock("../../../../utils/shell", () => ({
	getShell: vi.fn(() => "/bin/bash"),
}))

import { getRulesSection } from "../rules"

describe("getRulesSection", () => {
	const cwd = "/test/workspace"

	describe("tool call sequencing", () => {
		it("should not tell the model to wait for a response after every tool use", () => {
			const rules = getRulesSection(cwd)

			// This instruction predates native tool calling and directly contradicts
			// the batching guidance in the tool use guidelines section.
			expect(rules).not.toContain("wait for the user's response after each tool use")
			expect(rules).not.toContain("create a file, wait for the user's response")
		})

		it("should keep the genuine constraint on dependent tool calls", () => {
			const rules = getRulesSection(cwd)

			expect(rules).toContain("Never assume the outcome of a tool use")
			expect(rules).toContain("depends on another tool's result, wait for that result")
		})

		it("should tell the model to batch independent calls into one message", () => {
			const rules = getRulesSection(cwd)

			expect(rules).toContain("issue those calls together in the SAME message")
		})

		it("should limit the one-at-a-time MCP rule to state-changing operations", () => {
			const rules = getRulesSection(cwd)

			expect(rules).toContain("MCP operations that change state should be used one at a time")
			expect(rules).not.toContain("MCP operations should be used one at a time")
		})
	})

	describe("vendor confidentiality", () => {
		it("should be omitted by default", () => {
			expect(getRulesSection(cwd)).not.toContain("VENDOR CONFIDENTIALITY")
		})

		it("should be included for stealth models", () => {
			expect(getRulesSection(cwd, { isStealthModel: true } as any)).toContain("VENDOR CONFIDENTIALITY")
		})
	})
})
