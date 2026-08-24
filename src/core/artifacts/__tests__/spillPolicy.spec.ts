import { describe, it, expect, vi } from "vitest"

import { ARTIFACT_SPILL_DEFAULTS, resolveMaxInlineToolResultBytes } from "@roo-code/types"

import { PROTOCOL_TOOL_NAMES } from "../../../shared/tools"
import { COMPACTABLE_TOOL_NAMES } from "../../context-management/microcompact"

import type { ArtifactStore } from "../ArtifactStore"
import {
	applyToolResultSpill,
	buildSpillPreview,
	extractSpillNotice,
	SPILL_BYPASS_TOOLS,
	type ToolResultSpillContext,
} from "../spillPolicy"

/** Store double that records what it was asked to persist. */
function createStore(overrides: Partial<ArtifactStore> = {}) {
	const saved: Array<{ kind: string; text: string }> = []
	const store = {
		save: vi.fn((kind: string, text: string) => {
			saved.push({ kind, text })
			return { id: "tool-1706119234567.txt", bytes: Buffer.byteLength(text, "utf8"), path: "/tmp/x.txt" }
		}),
		...overrides,
	} as unknown as ArtifactStore

	return { store, saved }
}

function makeContext(store: ArtifactStore, maxInlineBytes = 1024): ToolResultSpillContext {
	return { store, maxInlineBytes, now: () => 1706119234567 }
}

/** Builds `count` numbered lines, each padded so the text is comfortably large. */
function makeLines(count: number, padTo = 100): string {
	return Array.from({ length: count }, (_, index) => `line-${index + 1}`.padEnd(padTo, "x")).join("\n")
}

describe("applyToolResultSpill", () => {
	it("passes a result under the limit through untouched", () => {
		const { store } = createStore()
		const text = "small result\nsecond line"

		const outcome = applyToolResultSpill(text, "search_files", makeContext(store))

		expect(outcome.text).toBe(text)
		expect(outcome.artifactId).toBeUndefined()
		expect(store.save).not.toHaveBeenCalled()
	})

	it("passes a result exactly at the limit through untouched", () => {
		const { store } = createStore()
		const text = "x".repeat(1024)

		const outcome = applyToolResultSpill(text, "search_files", makeContext(store, 1024))

		expect(outcome.text).toBe(text)
		expect(store.save).not.toHaveBeenCalled()
	})

	it("spills an oversized result, saving the FULL text as a tool artifact", () => {
		const { store, saved } = createStore()
		const text = makeLines(400)

		const outcome = applyToolResultSpill(text, "search_files", makeContext(store, 1024))

		expect(outcome.artifactId).toBe("tool-1706119234567.txt")
		expect(saved).toHaveLength(1)
		expect(saved[0].kind).toBe("tool")
		expect(saved[0].text).toBe(text)
		expect(store.save).toHaveBeenCalledWith("tool", text, 1706119234567)
	})

	it("keeps the head and the tail of the result and cites the artifact id", () => {
		const { store } = createStore()
		const text = makeLines(400, 10)
		const bytes = Buffer.byteLength(text, "utf8")

		const outcome = applyToolResultSpill(text, "search_files", makeContext(store, 4096))
		const [notice, ...body] = outcome.text.split("\n")

		expect(notice).toBe(
			`[Tool result: ${Math.round(bytes / 1024)} KB, showing first 60 and last 60 lines. ` +
				`Full output saved as artifact "tool-1706119234567.txt". ` +
				`Use read_artifact (search/offset/limit) to inspect the rest.]`,
		)
		expect(body.slice(0, 60)).toEqual(text.split("\n").slice(0, 60))
		expect(body[60]).toBe("...")
		expect(body.slice(61)).toEqual(text.split("\n").slice(-60))
		expect(outcome.originalBytes).toBe(bytes)
	})

	it("produces a preview that is smaller than the original", () => {
		const { store } = createStore()
		const text = makeLines(5000)

		const outcome = applyToolResultSpill(text, "search_files", makeContext(store, 4096))

		expect(Buffer.byteLength(outcome.text, "utf8")).toBeLessThan(Buffer.byteLength(text, "utf8"))
	})

	it("still shrinks a result that is one enormous line", () => {
		const { store } = createStore()
		const text = "y".repeat(200_000)

		const outcome = applyToolResultSpill(text, "search_files", makeContext(store, 4096))

		expect(outcome.artifactId).toBe("tool-1706119234567.txt")
		expect(Buffer.byteLength(outcome.text, "utf8")).toBeLessThan(6000)
		expect(outcome.text).toContain("\n...\n")
	})

	it("keeps the full result inline when the artifact write fails", () => {
		const { store } = createStore({
			save: vi.fn(() => {
				throw new Error("EACCES")
			}) as unknown as ArtifactStore["save"],
		})
		const text = makeLines(400)
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		const outcome = applyToolResultSpill(text, "search_files", makeContext(store, 1024))

		expect(outcome.text).toBe(text)
		expect(outcome.artifactId).toBeUndefined()
		warn.mockRestore()
	})

	it("keeps the result inline when no spill context is available", () => {
		const text = makeLines(400)
		expect(applyToolResultSpill(text, "search_files", undefined).text).toBe(text)
	})

	it.each([...SPILL_BYPASS_TOOLS])("never spills %s results", (toolName) => {
		const { store } = createStore()
		const text = makeLines(400)

		const outcome = applyToolResultSpill(text, toolName, makeContext(store, 1024))

		expect(outcome.text).toBe(text)
		expect(outcome.artifactId).toBeUndefined()
		expect(store.save).not.toHaveBeenCalled()
	})

	it("spills results of tools that are not on the bypass list, including MCP", () => {
		for (const toolName of ["search_files", "execute_command", "use_mcp_tool", "web_fetch", "list_files"]) {
			const { store } = createStore()
			const outcome = applyToolResultSpill(makeLines(400), toolName, makeContext(store, 1024))
			expect(outcome.artifactId).toBe("tool-1706119234567.txt")
			expect(store.save).toHaveBeenCalledTimes(1)
		}
	})

	it("never spills read_file: its schema promises whole files and it self-caps", () => {
		const { store } = createStore()
		const text = makeLines(400)

		const outcome = applyToolResultSpill(text, "read_file", makeContext(store, 1024))

		expect(outcome.text).toBe(text)
		expect(store.save).not.toHaveBeenCalled()
	})

	describe("profitability floor", () => {
		it("does not spill when the preview would not save at least half the bytes", () => {
			const { store } = createStore()
			// A few very long lines: the preview can only be clamped by bytes, so
			// it would come back nearly as large as the original.
			const text = Array.from({ length: 4 }, () => "z".repeat(6_500)).join("\n")
			const bytes = Buffer.byteLength(text, "utf8")

			expect(bytes).toBeGreaterThan(24 * 1024)

			const outcome = applyToolResultSpill(text, "search_files", makeContext(store, 24 * 1024))

			expect(outcome.text).toBe(text)
			expect(outcome.artifactId).toBeUndefined()
			expect(store.save).not.toHaveBeenCalled()
		})

		it("spills once the preview is genuinely smaller", () => {
			const { store } = createStore()
			const text = "z".repeat(200_000)

			const outcome = applyToolResultSpill(text, "search_files", makeContext(store, 24 * 1024))

			expect(outcome.artifactId).toBe("tool-1706119234567.txt")
			expect(Buffer.byteLength(outcome.text, "utf8") * 2).toBeLessThanOrEqual(Buffer.byteLength(text, "utf8"))
		})
	})

	it("spills results whose tool name is unknown (defensive default)", () => {
		const { store } = createStore()
		const outcome = applyToolResultSpill(makeLines(400), undefined, makeContext(store, 1024))
		expect(outcome.artifactId).toBe("tool-1706119234567.txt")
	})
})

describe("policy agreement with microcompact", () => {
	it("bypasses every protocol tool the microcompact pass also refuses to clear", () => {
		for (const toolName of PROTOCOL_TOOL_NAMES) {
			expect(SPILL_BYPASS_TOOLS.has(toolName)).toBe(true)
			expect(COMPACTABLE_TOOL_NAMES.has(toolName)).toBe(false)
		}
	})
})

describe("extractSpillNotice", () => {
	it("returns the notice line of a spilled result", () => {
		const { store } = createStore()
		const outcome = applyToolResultSpill(makeLines(400), "search_files", makeContext(store, 1024))

		const notice = extractSpillNotice(outcome.text)

		expect(notice).toBe(outcome.text.split("\n")[0])
		expect(notice).toContain('artifact "tool-1706119234567.txt"')
	})

	it("returns undefined for anything else", () => {
		expect(extractSpillNotice("plain output")).toBeUndefined()
		expect(extractSpillNotice("[Tool result: 12 KB, but no artifact here]")).toBeUndefined()
	})
})

describe("buildSpillPreview", () => {
	it("reports the number of lines it actually kept", () => {
		const preview = buildSpillPreview(makeLines(200, 10), 60, 60, 64 * 1024)
		expect(preview.headLines).toBe(60)
		expect(preview.tailLines).toBe(60)
	})

	it("clamps a short-but-huge text by bytes instead of lines", () => {
		const preview = buildSpillPreview("z".repeat(50_000), 60, 60, 4096)
		expect(Buffer.byteLength(preview.body, "utf8")).toBeLessThanOrEqual(4096 + "\n...\n".length)
	})
})

describe("resolveMaxInlineToolResultBytes", () => {
	it("defaults to 24 KB", () => {
		expect(resolveMaxInlineToolResultBytes(undefined)).toBe(24 * 1024)
		expect(resolveMaxInlineToolResultBytes({})).toBe(ARTIFACT_SPILL_DEFAULTS.DEFAULT_INLINE_TOOL_RESULT_BYTES)
	})

	it("honors a configured value and clamps nonsense", () => {
		expect(resolveMaxInlineToolResultBytes({ maxInlineToolResultBytes: 8192 })).toBe(8192)
		expect(resolveMaxInlineToolResultBytes({ maxInlineToolResultBytes: 1 })).toBe(
			ARTIFACT_SPILL_DEFAULTS.MIN_INLINE_TOOL_RESULT_BYTES,
		)
		expect(resolveMaxInlineToolResultBytes({ maxInlineToolResultBytes: Number.MAX_SAFE_INTEGER })).toBe(
			ARTIFACT_SPILL_DEFAULTS.MAX_INLINE_TOOL_RESULT_BYTES,
		)
		expect(resolveMaxInlineToolResultBytes({ maxInlineToolResultBytes: Number.NaN })).toBe(
			ARTIFACT_SPILL_DEFAULTS.DEFAULT_INLINE_TOOL_RESULT_BYTES,
		)
	})
})
