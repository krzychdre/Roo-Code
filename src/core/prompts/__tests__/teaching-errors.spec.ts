// npx vitest run core/prompts/__tests__/teaching-errors.spec.ts

import { formatResponse } from "../responses"
import { TOOL_MINIMAL_EXAMPLES } from "../tools/native-tools/examples"

describe("teaching errors carry a minimal valid example", () => {
	describe("toolError", () => {
		it("attaches the example as a nested object, not an escaped string", () => {
			const parsed = JSON.parse(formatResponse.toolError("boom", "read_file"))

			expect(parsed.status).toBe("error")
			expect(parsed.error).toBe("boom")
			expect(parsed.failed_tool).toBe("read_file")
			// Deep-equal against the object proves it is NOT a stringified blob: a model can
			// copy `minimal_valid_example` straight into the tool call arguments.
			expect(parsed.minimal_valid_example).toEqual(TOOL_MINIMAL_EXAMPLES.read_file)
			expect(typeof parsed.minimal_valid_example).toBe("object")
		})

		it("never double-encodes the example", () => {
			const raw = formatResponse.toolError("boom", "list_files")

			// The example appears once, at one level of escaping only.
			expect(raw).toContain(`"minimal_valid_example":{"path":"src","recursive":false}`)
			expect(raw).not.toContain("\\\\")
			expect(raw.split("minimal_valid_example")).toHaveLength(2)
		})

		it("omits the field for unknown, dynamic and absent tool names", () => {
			expect(JSON.parse(formatResponse.toolError("boom"))).not.toHaveProperty("minimal_valid_example")
			expect(JSON.parse(formatResponse.toolError("boom", "custom_tool"))).not.toHaveProperty(
				"minimal_valid_example",
			)
			expect(JSON.parse(formatResponse.toolError("boom", "use_mcp_tool"))).not.toHaveProperty(
				"minimal_valid_example",
			)
		})
	})

	describe("missingToolParameterError", () => {
		it("stays plain text so the wrapper can attach the example structurally", () => {
			const text = formatResponse.missingToolParameterError("path")

			expect(text).toContain("Missing value for required parameter 'path'")
			expect(text).not.toContain("minimal_valid_example")
		})

		it("reaches the model as clean single-level JSON once wrapped", () => {
			const parsed = JSON.parse(
				formatResponse.toolError(formatResponse.missingToolParameterError("diff"), "apply_diff"),
			)

			expect(parsed.error).toContain("Missing value for required parameter 'diff'")
			expect(parsed.failed_tool).toBe("apply_diff")
			expect(parsed.minimal_valid_example).toEqual(TOOL_MINIMAL_EXAMPLES.apply_diff)
		})
	})

	describe("tooManyMistakes", () => {
		it("attaches the failing tool and its minimal example", () => {
			const parsed = JSON.parse(formatResponse.tooManyMistakes("try harder", "search_files"))

			expect(parsed.status).toBe("guidance")
			expect(parsed.feedback).toBe("try harder")
			expect(parsed.failed_tool).toBe("search_files")
			expect(parsed.minimal_valid_example).toEqual(TOOL_MINIMAL_EXAMPLES.search_files)
		})

		it("omits the example when the mistakes were not tool-call failures", () => {
			const parsed = JSON.parse(formatResponse.tooManyMistakes("try harder", undefined))

			expect(parsed).not.toHaveProperty("failed_tool")
			expect(parsed).not.toHaveProperty("minimal_valid_example")
		})
	})
})
