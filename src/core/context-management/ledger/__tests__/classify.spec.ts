// cd src && npx vitest run core/context-management/ledger/__tests__/classify.spec.ts

import { formatResponse } from "../../../prompts/responses"

import {
	MAX_TEXTUAL_ERROR_CHARS,
	classifyToolResultOutcome,
	extractEnvelopeFeedback,
	extractToolSubject,
	extractUserInstructions,
	isValidationCommand,
	toBoundedText,
	toSingleLine,
} from "../classify"

describe("classifyToolResultOutcome", () => {
	it("recognises the structured envelopes Roo actually emits", () => {
		// These are the exact shapes found in the on-disk task store, and the reason the
		// classifier cannot rely on the `is_error` flag alone.
		expect(classifyToolResultOutcome(formatResponse.toolError("boom"))).toBe("error")
		expect(classifyToolResultOutcome(formatResponse.toolDenied())).toBe("denied")
		expect(classifyToolResultOutcome(formatResponse.toolDeniedWithFeedback("do it differently"))).toBe("denied")
		expect(classifyToolResultOutcome(formatResponse.rooIgnoreError("secrets.env"))).toBe("error")
		expect(classifyToolResultOutcome(formatResponse.toolApprovedWithFeedback("looks good"))).toBe("ok")
	})

	it("recognises plain-text error markers at any size", () => {
		expect(classifyToolResultOutcome("Error: anchor_line must be a 1-indexed line number (got 0).")).toBe("error")
		expect(classifyToolResultOutcome("[ERROR] you did not use a tool")).toBe("error")
		expect(classifyToolResultOutcome(`<error_details>${"x".repeat(50_000)}</error_details>`)).toBe("error")
		expect(classifyToolResultOutcome("The tool execution failed")).toBe("error")
	})

	it("honours the is_error flag when the text carries no marker", () => {
		expect(classifyToolResultOutcome("something went sideways", true)).toBe("error")
		expect(classifyToolResultOutcome("something went sideways", false)).toBe("ok")
	})

	it("detects an embedded error line in a small result", () => {
		// Emitted by multi-file reads when one path fails.
		expect(classifyToolResultOutcome("File: tests/conftest.py Error: ENOENT: no such file")).toBe("error")
	})

	it("does NOT treat a large result containing the word Error as a failure", () => {
		// A grep over source that mentions `Error:` must stay `ok`, otherwise every large search
		// result would be protected from compaction — the misclassification risk raised in review.
		const bigSearchDump = `${"const x = 1\n".repeat(500)}throw new Error: nope\n${"y\n".repeat(500)}`
		expect(bigSearchDump.length).toBeGreaterThan(MAX_TEXTUAL_ERROR_CHARS)
		expect(classifyToolResultOutcome(bigSearchDump)).toBe("ok")
	})

	it("treats ordinary output as ok", () => {
		expect(classifyToolResultOutcome("")).toBe("ok")
		expect(classifyToolResultOutcome("3 files changed, 12 insertions(+)")).toBe("ok")
		expect(classifyToolResultOutcome('{"status":"success","files":3}')).toBe("ok")
	})

	it("falls back to textual rules when the envelope is not valid JSON", () => {
		expect(classifyToolResultOutcome('{"status":"error", truncated…')).toBe("ok")
		expect(classifyToolResultOutcome('{"status": "error"}')).toBe("error")
	})
})

describe("isValidationCommand", () => {
	it.each([
		"npm test",
		"pnpm run build",
		"yarn lint",
		"npx vitest run core/foo.spec.ts",
		"pytest -q tests/",
		"python -m pytest",
		"cargo clippy --all",
		"go test ./...",
		"./gradlew check",
		"dotnet test",
		"make lint",
		"tsc --noEmit",
		"ruff check .",
		"prettier --check .",
	])("recognises %s", (command) => {
		expect(isValidationCommand(command)).toBe(true)
	})

	it.each(["ls -la", "git status", "cat package.json", "echo hello", "", "mkdir build"])(
		"does not flag %s",
		(command) => {
			expect(isValidationCommand(command)).toBe(false)
		},
	)
})

describe("extractToolSubject", () => {
	it("reads the native path parameter", () => {
		expect(extractToolSubject("read_file", { path: "src/app.ts" })).toBe("src/app.ts")
		expect(extractToolSubject("apply_diff", { path: " src/a.ts ", diff: "..." })).toBe("src/a.ts")
	})

	it("reads the legacy XML args shape", () => {
		expect(extractToolSubject("read_file", { args: "<file><path>src/legacy.ts</path></file>" })).toBe(
			"src/legacy.ts",
		)
	})

	it("uses the command for command tools", () => {
		expect(extractToolSubject("execute_command", { command: " npm test " })).toBe("npm test")
		// A command tool must not fall back to `path`, which is its cwd, not its subject.
		expect(extractToolSubject("execute_command", { path: "/tmp" })).toBeUndefined()
	})

	it("uses the query for semantic search", () => {
		expect(extractToolSubject("codebase_search", { query: "where is auth" })).toBe("where is auth")
	})

	it("returns undefined for unusable input", () => {
		expect(extractToolSubject("read_file", undefined)).toBeUndefined()
		expect(extractToolSubject("read_file", {})).toBeUndefined()
		expect(extractToolSubject("read_file", "nonsense")).toBeUndefined()
	})
})

describe("toSingleLine", () => {
	it("collapses whitespace and truncates with an ellipsis", () => {
		expect(toSingleLine("a\n\n  b\tc")).toBe("a b c")
		expect(toSingleLine("abcdef", 4)).toBe("abc…")
		expect(toSingleLine("abcd", 4)).toBe("abcd")
	})
})

describe("toBoundedText", () => {
	it("returns text that fits unchanged, whitespace collapsed", () => {
		expect(toBoundedText("a\n\n  b\tc", 100)).toBe("a b c")
	})

	it("keeps both ends when the text does not fit", () => {
		const text = `START ${"x".repeat(2000)} END`
		const bounded = toBoundedText(text, 500)

		expect(bounded.startsWith("START ")).toBe(true)
		expect(bounded.endsWith(" END")).toBe(true)
		expect(bounded).toContain("chars omitted")
	})

	it("never exceeds the budget", () => {
		// The marker is sized for the worst case, so substituting the real (smaller) omitted count
		// must not be able to push the result over.
		for (const length of [201, 500, 1234, 100_000]) {
			for (const max of [200, 201, 400, 2000]) {
				expect(toBoundedText("y".repeat(length), max).length).toBeLessThanOrEqual(max)
			}
		}
	})

	it("reports the exact number of omitted characters", () => {
		const bounded = toBoundedText("z".repeat(5000), 1000)
		const omitted = Number(/\[…(\d+) chars omitted…\]/.exec(bounded)?.[1])

		expect(omitted).toBe(5000 - (bounded.length - `[…${omitted} chars omitted…]`.length - 2))
	})

	it("falls back to head truncation when the budget is too small to split", () => {
		expect(toBoundedText("q".repeat(400), 40)).toBe(`${"q".repeat(39)}…`)
	})
})

describe("extractUserInstructions", () => {
	it("returns nothing for a payload with no user prose", () => {
		expect(extractUserInstructions("")).toEqual([])
		expect(extractUserInstructions("The content was successfully saved.")).toEqual([])
	})

	it("pulls out every message, in order", () => {
		const text =
			"<user_message>\nuse pnpm, not npm\n</user_message>\nnoise\n<user_message>and skip the e2e run</user_message>"
		expect(extractUserInstructions(text)).toEqual(["use pnpm, not npm", "and skip the e2e run"])
	})

	it("strips the resumption preamble and the standing context blocks", () => {
		// The exact shape `TaskResumption` emits: a preamble, then what the user actually typed.
		const text = [
			"[TASK RESUMPTION] This task was interrupted 3 minutes ago. The user has sent a message:",
			"<user_message>",
			"drop the retry, it made it worse",
			"<environment_details># VSCode Visible Files\nsrc/a.ts</environment_details>",
			"</user_message>",
		].join("\n")
		expect(extractUserInstructions(text)).toEqual(["drop the retry, it made it worse"])
	})

	it("drops replies that only acknowledge", () => {
		// These are real user messages, but a snapshot line saying "the user said: continue" is a
		// line spent on nothing.
		for (const reply of ["continue", "OK!", " yes ", "Dalej", "thanks"]) {
			expect(extractUserInstructions(`<user_message>${reply}</user_message>`)).toEqual([])
		}
	})

	it("keeps an instruction that merely starts with an acknowledgement", () => {
		expect(extractUserInstructions("<user_message>no, use pnpm</user_message>")).toEqual(["no, use pnpm"])
		expect(extractUserInstructions("<user_message>continue with the migration</user_message>")).toEqual([
			"continue with the migration",
		])
	})
})

describe("extractEnvelopeFeedback", () => {
	it("reads the note attached to a denial or an approval", () => {
		expect(extractEnvelopeFeedback(formatResponse.toolDeniedWithFeedback("no system-wide python packages"))).toBe(
			"no system-wide python packages",
		)
		expect(extractEnvelopeFeedback(formatResponse.toolApprovedWithFeedback("do not take 1024 as a default"))).toBe(
			"do not take 1024 as a default",
		)
	})

	it("ignores envelopes that carry no note, and bare acknowledgements", () => {
		expect(extractEnvelopeFeedback(formatResponse.toolDenied())).toBeUndefined()
		expect(extractEnvelopeFeedback(formatResponse.toolError("boom"))).toBeUndefined()
		expect(extractEnvelopeFeedback(formatResponse.toolApprovedWithFeedback("continue"))).toBeUndefined()
	})

	it("ignores anything that is not an envelope", () => {
		expect(extractEnvelopeFeedback("plain output mentioning feedback")).toBeUndefined()
		expect(extractEnvelopeFeedback('{"status":"denied","feedback":"trunc')).toBeUndefined()
	})
})
