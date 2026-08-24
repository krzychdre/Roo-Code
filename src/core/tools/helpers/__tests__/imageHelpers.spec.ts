// npx vitest run core/tools/helpers/__tests__/imageHelpers.spec.ts

import { describe, it, expect } from "vitest"

import { validateImageForProcessing } from "../imageHelpers"

describe("validateImageForProcessing", () => {
	describe("when the model does not support images", () => {
		// A nonexistent path proves the unsupported-model check runs before any
		// filesystem access: fs.stat would reject if it were reached.
		const NONEXISTENT_PATH = "/nonexistent/screenshot.png"

		it("rejects the image without touching the filesystem", async () => {
			const result = await validateImageForProcessing(NONEXISTENT_PATH, false, 5, 20, 0)

			expect(result.isValid).toBe(false)
			expect(result.reason).toBe("unsupported_model")
		})

		it("tells the model how to delegate the image to a vision-capable mode", async () => {
			const result = await validateImageForProcessing(NONEXISTENT_PATH, false, 5, 20, 0)

			// The notice is model-facing guidance: it must name the hand-off
			// tool so weak models can act on it at the moment of failure.
			expect(result.notice).toContain("new_task")
			expect(result.notice).toContain("vision-capable mode")
		})
	})
})
