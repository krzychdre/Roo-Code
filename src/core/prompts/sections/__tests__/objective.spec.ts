import askFollowupQuestion from "../../tools/native-tools/ask_followup_question"
import { getObjectiveSection } from "../objective"

describe("getObjectiveSection", () => {
	it("should include proper numbered structure", () => {
		const objective = getObjectiveSection()

		// Check that all numbered items are present
		expect(objective).toContain("1. Analyze the user's task")
		expect(objective).toContain("2. Work through these goals sequentially")
		expect(objective).toContain("3. Remember, you have extensive capabilities")
		expect(objective).toContain("4. Once you've completed the user's task")
		expect(objective).toContain("5. DO NOT continue in pointless back and forth conversations")
	})

	it("should include analysis guidance", () => {
		const objective = getObjectiveSection()

		expect(objective).toContain("Before calling a tool, do some analysis")
		expect(objective).toContain("analyze the file structure provided in environment_details")
		expect(objective).toContain("think about which of the provided tools is the most relevant")
	})

	it("should include parameter inference guidance", () => {
		const objective = getObjectiveSection()

		expect(objective).toContain("Go through each of the required parameters")
		expect(objective).toContain(
			"determine if the user has directly provided or given enough information to infer a value",
		)
		expect(objective).toContain("DO NOT invoke the tool (not even with fillers for the missing params)")
		expect(objective).toContain("ask_followup_question tool")
	})

	it("should include guidance about not engaging in back and forth conversations", () => {
		const objective = getObjectiveSection()

		expect(objective).toContain("DO NOT continue in pointless back and forth conversations")
		expect(objective).toContain("don't end your responses with questions or offers for further assistance")
	})

	it("should include the OBJECTIVE header", () => {
		const objective = getObjectiveSection()

		expect(objective).toContain("OBJECTIVE")
		expect(objective).toContain("You accomplish a given task iteratively")
	})

	describe("single-tool guidance lives next to the tool", () => {
		const description = askFollowupQuestion.function.description ?? ""

		it("no longer repeats the optional-parameter rule that ask_followup_question owns", () => {
			const objective = getObjectiveSection()

			expect(objective).not.toContain("DO NOT ask for more information on optional parameters")
			expect(description).toContain("never ask about a tool's optional parameters")
		})

		it("no longer repeats the attempt_completion feedback loop", () => {
			const objective = getObjectiveSection()

			// Covered verbatim by the attempt_completion tool description.
			expect(objective).not.toContain("The user may provide feedback, which you can use to make improvements")
		})
	})
})
