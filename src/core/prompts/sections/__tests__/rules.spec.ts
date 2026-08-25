vi.mock("../../../../utils/shell", () => ({
	getShell: vi.fn(() => "/bin/bash"),
}))

import askFollowupQuestion from "../../tools/native-tools/ask_followup_question"
import attemptCompletion from "../../tools/native-tools/attempt_completion"
import executeCommand from "../../tools/native-tools/execute_command"
import { createReadFileTool } from "../../tools/native-tools/read_file"
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

	describe("single-tool guidance lives next to the tool (WS-D audit)", () => {
		const executeCommandDescription = executeCommand.function.description ?? ""
		const askFollowupDescription = askFollowupQuestion.function.description ?? ""
		const attemptCompletionDescription = attemptCompletion.function.description ?? ""
		const readFileTool = createReadFileTool()
		const readFileDescription = ("function" in readFileTool ? readFileTool.function.description : "") ?? ""

		it("moves the execute_command paragraphs into the execute_command description", () => {
			const rules = getRulesSection(cwd)

			expect(rules).not.toContain("Before using the execute_command tool")
			expect(rules).not.toContain("Actively Running Terminals")
			expect(rules).not.toContain("respect working directory specified by the response to execute_command")
			expect(rules).not.toContain("assume the terminal executed the command successfully")

			expect(executeCommandDescription).toContain(
				"Check the exit code on every result; investigate failures before moving on.",
			)
			expect(executeCommandDescription).toContain("Read the SYSTEM INFORMATION section first")
			expect(executeCommandDescription).toContain("Actively Running Terminals")
			expect(executeCommandDescription).toContain("respect the working directory reported in the result")
			expect(executeCommandDescription).toContain(
				"assume the terminal failed to stream output, not that the command failed",
			)
		})

		it("keeps only the shell-dependent chaining line in rules", () => {
			const rules = getRulesSection(cwd)

			// The chaining operator and the PowerShell/cmd.exe utility note depend on the
			// user's shell at prompt-build time, and the tool schema is a static object,
			// so this single line stays in rules.
			expect(rules).toContain("Chain shell commands with")
			expect(rules).toContain("cd (path to project) && (command)")
		})

		it("moves the ask_followup_question paragraph into the ask_followup_question description", () => {
			const rules = getRulesSection(cwd)

			expect(rules).not.toContain("You are only allowed to ask the user questions using")
			expect(rules).not.toContain("Do not ask for more information than necessary")

			expect(askFollowupDescription).toContain("This is the ONLY way to ask the user anything")
			expect(askFollowupDescription).toContain("Do not ask for more information than you need")
			expect(askFollowupDescription).toContain("Order the suggested answers by priority or logical sequence")
		})

		it("drops the attempt_completion rules the tool description already covers", () => {
			const rules = getRulesSection(cwd)

			expect(rules).not.toContain("NEVER end attempt_completion result with a question")
			expect(rules).not.toContain("you must use the attempt_completion tool to present the result")

			expect(attemptCompletionDescription).toContain(
				"Formulate this result in a way that is final and does not require further input from the user",
			)
			expect(attemptCompletionDescription).toContain(
				"Don't end your result with questions or offers for further assistance",
			)
			expect(attemptCompletionDescription).toContain(
				"The user may respond with feedback if they are not satisfied with the result",
			)
		})

		it("drops the read_file re-read rule the tool description already covers", () => {
			const rules = getRulesSection(cwd)

			expect(rules).not.toContain("you shouldn't use the read_file tool to get the file contents again")
			expect(readFileDescription).toContain(
				"Never re-read a file, or a part of a file, that is already in this conversation",
			)
		})

		it("keeps the multi-tool and general rules", () => {
			const rules = getRulesSection(cwd)

			expect(rules).toContain("The project base directory is:")
			expect(rules).toContain("All file paths must be relative to this directory")
			expect(rules).toContain("Do not use the ~ character or $HOME")
			expect(rules).toContain("FileRestrictionError")
			expect(rules).toContain("You are STRICTLY FORBIDDEN from starting your messages")
			expect(rules).toContain("you will automatically receive environment_details")
			expect(rules).toContain("utilize your vision capabilities")
		})

		it("shrinks the rules section well below its pre-WS-D size", () => {
			// Baseline on this shell mock (bash, so no shell note) was 6531 bytes.
			expect(Buffer.byteLength(getRulesSection(cwd))).toBeLessThan(4000)
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
