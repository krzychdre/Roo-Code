// npx vitest run packages/types/src/__tests__/mode-roleDefinition.spec.ts
//
// `roleDefinition` is the only required free-text field of a mode, and the
// system prompt's constant opener promises that "the MODE section states your
// role". That promise can only hold if a validated mode always has a role
// definition with visible characters in it: the prompt assembly trims the role
// definition and drops the whole MODE section when nothing is left
// (`getModeSection` in src/core/prompts/system.ts).
//
// A plain `min(1)` would let " " through, so these tests pin the trim-aware
// behavior rather than the length check.

import { modeConfigSchema } from "../mode.js"

describe("modeConfigSchema roleDefinition", () => {
	const baseModeConfig = {
		slug: "test-mode",
		name: "Test Mode",
		roleDefinition: "You are a test mode.",
		groups: ["read" as const],
	}

	it("accepts a normal role definition", () => {
		const result = modeConfigSchema.safeParse(baseModeConfig)

		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.roleDefinition).toBe("You are a test mode.")
		}
	})

	it("rejects an empty role definition", () => {
		const result = modeConfigSchema.safeParse({ ...baseModeConfig, roleDefinition: "" })

		expect(result.success).toBe(false)
	})

	it.each([
		["a single space", " "],
		["several spaces", "   "],
		["a tab", "\t"],
		["a newline", "\n"],
		["mixed whitespace", " \t\n \r\n "],
	])("rejects a whitespace-only role definition (%s)", (_label, roleDefinition) => {
		const result = modeConfigSchema.safeParse({ ...baseModeConfig, roleDefinition })

		expect(result.success).toBe(false)
	})

	it("reports the same helpful message for whitespace-only as for empty", () => {
		// The message is what the settings UI and the .roomodes JSON schema show
		// the user, so a trim-aware rejection must not degrade into a generic
		// "String must contain at least 1 character(s)".
		const empty = modeConfigSchema.safeParse({ ...baseModeConfig, roleDefinition: "" })
		const blank = modeConfigSchema.safeParse({ ...baseModeConfig, roleDefinition: "   " })

		expect(empty.success).toBe(false)
		expect(blank.success).toBe(false)
		if (!empty.success && !blank.success) {
			const blankIssue = blank.error.issues[0]
			const emptyIssue = empty.error.issues[0]

			expect(blankIssue).toBeDefined()
			expect(emptyIssue).toBeDefined()
			expect(blankIssue?.message).toBe("Role definition is required")
			expect(blankIssue?.message).toBe(emptyIssue?.message)
			expect(blankIssue?.path).toEqual(["roleDefinition"])
		}
	})

	it("normalizes surrounding whitespace on an otherwise valid role definition", () => {
		// `.trim()` is a zod string check, so the parsed value comes back
		// trimmed. Harmless (every consumer trims before use) but worth pinning:
		// it is what makes the length check see the real content.
		const result = modeConfigSchema.safeParse({
			...baseModeConfig,
			roleDefinition: "  You are a test mode.  ",
		})

		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.roleDefinition).toBe("You are a test mode.")
		}
	})

	it("keeps roleDefinition typed as a plain string", () => {
		// Guards the idiom, not the value: `.trim()` on a ZodString stays a
		// ZodString, whereas a `.transform()` would wrap the object in
		// ZodEffects and break `zodResolver` inference in the webview forms
		// (the same reason groupEntryArraySchema carries its type assertion).
		const result = modeConfigSchema.safeParse(baseModeConfig)

		expect(result.success).toBe(true)
		if (result.success) {
			const roleDefinition: string = result.data.roleDefinition
			expect(typeof roleDefinition).toBe("string")
		}
	})

	it("still rejects a missing role definition", () => {
		const { roleDefinition: _omitted, ...withoutRole } = baseModeConfig
		const result = modeConfigSchema.safeParse(withoutRole)

		expect(result.success).toBe(false)
	})
})
