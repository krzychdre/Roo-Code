import { DEFAULT_MODES } from "../mode.js"

/**
 * The orchestrator's delegation count is the dominant cost of a large run: every
 * delegation is a separate conversation with its own full system prompt. These
 * assertions pin the parts of its instructions that exist purely to keep that
 * count down, so they are not lost to an unrelated reword.
 */
describe("orchestrator delegation economics", () => {
	const orchestrator = DEFAULT_MODES.find((mode) => mode.slug === "orchestrator")
	const customInstructions = orchestrator?.customInstructions ?? ""

	it("should define an orchestrator mode with custom instructions", () => {
		expect(orchestrator).toBeDefined()
		expect(customInstructions.length).toBeGreaterThan(0)
	})

	it("should prefer few large subtasks over many small ones", () => {
		expect(customInstructions).toContain("prefer FEW, LARGER subtasks over many small ones")
	})

	it("should forbid pairing a review with every implementation subtask", () => {
		expect(customInstructions).toContain("Do NOT pair a review with every implementation subtask")
		expect(customInstructions).toContain("one review subtask per batch of related slices")
	})

	it("should keep an escape hatch for changes that are risky in isolation", () => {
		expect(customInstructions).toContain("genuinely risky in isolation")
	})

	it("should number its instruction list contiguously", () => {
		const numbers = [...customInstructions.matchAll(/(?:^|\n)(\d+)\. /g)].map((match) => Number(match[1]))
		expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => index + 1))
	})
})
