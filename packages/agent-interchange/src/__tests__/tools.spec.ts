import { extractActions } from "../tools.js"
import type { InterchangeMessage } from "../types.js"

/**
 * Regression coverage for CodeQL alert #16 (polynomial ReDoS in
 * `packages/agent-interchange/src/tools.ts` — the dynamic
 * `new RegExp(\`<${tool}>([\\s\\S]*?)</${tool}>\`, "g")` built from
 * `XML_TOOL_NAMES`).
 *
 * The dynamic regex was replaced with `extractTagContents`, a monotonic
 * `indexOf` scanner. These tests guard (a) byte-for-byte equivalence with the
 * original behavior on a representative corpus, and (b) that the orphan-open
 * adversarial input that was catastrophically quadratic now completes in linear
 * time within a generous bound.
 */

/** Build a single assistant message whose text block carries `text`. */
function assistantWithText(text: string): InterchangeMessage[] {
	return [{ role: "assistant", blocks: [{ type: "text", text }] }]
}

describe("extractActions — XML tool-call parsing (alert #16 regression)", () => {
	it("returns no actions when the text has no closing tag", () => {
		expect(extractActions(assistantWithText("just prose, no xml here"))).toEqual([])
	})

	it("extracts a single well-formed read_file call with a path", () => {
		const text = `<read_file><path>src/index.ts</path></read_file>`
		const actions = extractActions(assistantWithText(text))
		expect(actions).toHaveLength(1)
		expect(actions[0]).toMatchObject({
			tool: "read_file",
			kind: "read",
			paths: ["src/index.ts"],
		})
	})

	it("extracts a command from execute_command XML", () => {
		const text = `<execute_command><command>npm test</command></execute_command>`
		const actions = extractActions(assistantWithText(text))
		expect(actions).toHaveLength(1)
		expect(actions[0]).toMatchObject({ tool: "execute_command", kind: "command", command: "npm test" })
	})

	it("extracts result text from attempt_completion", () => {
		const text = `<attempt_completion><result>all done</result></attempt_completion>`
		const actions = extractActions(assistantWithText(text))
		expect(actions).toHaveLength(1)
		expect(actions[0]).toMatchObject({ tool: "attempt_completion", kind: "complete", text: "all done" })
	})

	it("extracts multiple distinct tool calls from one text block", () => {
		const text =
			`<read_file><path>a.ts</path></read_file>` +
			`<execute_command><command>ls</command></execute_command>` +
			`<read_file><path>b.ts</path></read_file>`
		const actions = extractActions(assistantWithText(text))
		// fromXml sorts by tool name with localeCompare: 'execute_command' < 'read_file'.
		// The sort is stable, so the two read_file entries keep their source order.
		expect(actions.map((a) => a.tool)).toEqual(["execute_command", "read_file", "read_file"])
		expect(actions[0]?.command).toBe("ls")
		expect(actions[1]?.paths).toEqual(["a.ts"])
		expect(actions[2]?.paths).toEqual(["b.ts"])
	})

	it("drops empty and whitespace-only captured content (lazy *? + trim filter)", () => {
		const text = `<read_file></read_file><read_file>   </read_file><read_file><path>real.ts</path></read_file>`
		const actions = extractActions(assistantWithText(text))
		// matchAll/extractTagContents trim+filter drops empty and whitespace-only
		// bodies BEFORE an action is constructed, so only the real pair survives.
		// This matches the original regex+matchAll behavior (equivalence-proven).
		expect(actions).toHaveLength(1)
		expect(actions[0]?.tool).toBe("read_file")
		expect(actions[0]?.paths).toEqual(["real.ts"])
	})

	it("matches nested same-tool content lazily (first close wins, no second match)", () => {
		// `<read_file><read_file>inner</read_file></read_file>` — lazy *? stops
		// at the FIRST </read_file>, so the body is `<read_file>inner`. With the
		// global flag, the next match search starts AFTER that first close; the
		// remaining lone </read_file> has no opening tag, so there is exactly ONE
		// match (not two). The captured body has no <path>/<command>/<result>, so
		// the action carries only kind+tool+messageIndex.
		const text = `<read_file><read_file>inner</read_file></read_file>`
		const actions = extractActions(assistantWithText(text))
		expect(actions).toHaveLength(1)
		expect(actions[0]?.tool).toBe("read_file")
		expect(actions[0]?.paths).toBeUndefined()
		expect(actions[0]?.text).toBeUndefined()
	})

	it("ignores a closing tag that appears before any opening tag", () => {
		const text = `nope </read_file> then <read_file><path>real.ts</path></read_file>`
		const actions = extractActions(assistantWithText(text))
		expect(actions).toHaveLength(1)
		expect(actions[0]?.paths).toEqual(["real.ts"])
	})

	it("treats the tool tag name as a literal, not regex syntax", () => {
		// XML_TOOL_NAMES are plain [a-z_]+ identifiers; there is no
		// regex-special char among them. This test documents that contract: a
		// tool name containing regex metacharacters is never constructed, and
		// the scanner matches the literal tag strings. We assert the existing
		// `attempt_completion` name (which contains no metachars) is matched
		// literally — if a future tool name ever introduced a `.` or `+`, the
		// string-based scanner would still match it literally, unlike the old
		// `new RegExp` which would have interpreted it as regex.
		const text = `<attempt_completion><result>literal underscore name</result></attempt_completion>`
		const actions = extractActions(assistantWithText(text))
		expect(actions).toHaveLength(1)
		expect(actions[0]?.tool).toBe("attempt_completion")
		expect(actions[0]?.text).toBe("literal underscore name")
	})

	it("completes within a generous bound on orphan-open adversarial input (no catastrophic backtracking)", () => {
		// The input that was catastrophically quadratic under the old regex:
		//   "SENTINEL" + "<read_file>".repeat(10000)   — no closing tags.
		// Old regex: ~457 ms at n=10000, ~1830 ms at n=20000 (x4.01, quadratic).
		// New scanner must stay linear and well under the bound.
		const tool = "read_file"
		const n = 10000
		const text = "SENTINEL" + `<${tool}>`.repeat(n)

		const start = Date.now()
		const actions = extractActions(assistantWithText(text))
		const elapsed = Date.now() - start

		// No closing tags => no complete pairs => zero actions.
		expect(actions).toEqual([])
		// Generous bound: the scanner runs in well under 10 ms locally; allow
		// 100 ms to absorb slow CI runners while still catching a quadratic
		// regression (quadratic at n=10000 was ~457 ms).
		expect(elapsed).toBeLessThan(100)
	})
})
