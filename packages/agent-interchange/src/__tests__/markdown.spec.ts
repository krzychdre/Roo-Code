import { renderSessionList } from "../briefing.js"
import { renderHandoffList, type Handoff, type HandoffStatus } from "../handoffs.js"
import { escapeMarkdownTableCell } from "../markdown.js"
import { renderPlanList, type PlanDoc, type PlanSource } from "../plans.js"
import type { AgentKind, SessionSummary } from "../types.js"

describe("escapeMarkdownTableCell", () => {
	it("escapes a pipe", () => {
		expect(escapeMarkdownTableCell("a|b")).toBe("a\\|b")
	})

	it("escapes backslash before pipe so no ambiguous \\| remains", () => {
		// Input a\|b → backslash doubled to a\\|b → pipe escaped to a\\\|b.
		expect(escapeMarkdownTableCell("a\\|b")).toBe("a\\\\\\|b")
	})

	it("collapses \\n to a space", () => {
		expect(escapeMarkdownTableCell("a\nb")).toBe("a b")
	})

	it("collapses \\r\\n to a space", () => {
		expect(escapeMarkdownTableCell("a\r\nb")).toBe("a b")
	})

	it("doubles a lone backslash", () => {
		expect(escapeMarkdownTableCell("a\\b")).toBe("a\\\\b")
	})

	it("leaves plain text untouched", () => {
		expect(escapeMarkdownTableCell("hello world")).toBe("hello world")
	})
})

/**
 * Split a markdown table row on UNESCAPED pipes only. An escaped pipe (`\|`)
 * stays inside its cell, so a well-formed row splits into exactly
 * `cells + 2` parts (one per cell plus the two empty border strings).
 */
function splitRow(row: string): string[] {
	return row.split(/(?<!\\)\|/)
}

const HOSTILE = "field|with\\pipe\nandnewline"

describe("renderSessionList cell escaping", () => {
	it("keeps a hostile agent/id/title each in their own cell", () => {
		const summary: SessionSummary = {
			agent: "tumble-code",
			id: `id-${HOSTILE}`,
			title: `title-${HOSTILE}`,
			cwd: "/tmp/proj",
			createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
			updatedAt: Date.parse("2026-01-01T00:00:00.000Z"),
			path: "/tmp/session",
		}

		const table = renderSessionList([summary])
		const rows = table.split("\n")
		const dataRow = rows[2]!

		expect(dataRow.startsWith("|")).toBe(true)
		expect(dataRow.endsWith("|")).toBe(true)
		expect(dataRow.includes("\n")).toBe(false)

		// Header: | agent | id | updated | title | → 4 cells → 6 parts.
		expect(splitRow(dataRow)).toHaveLength(6)
	})
})

describe("renderHandoffList cell escaping", () => {
	it("keeps hostile id/from/to/status/title each in their own cell", () => {
		const hostile: Handoff = {
			id: `id-${HOSTILE}`,
			title: `title-${HOSTILE}`,
			from: `from-${HOSTILE}` as AgentKind,
			to: `to-${HOSTILE}` as AgentKind,
			sourceSessionId: "src",
			cwd: "/tmp/proj",
			gitBranch: "feat/x",
			status: `open-${HOSTILE}` as HandoffStatus,
			created: "2026-01-01T00:00:00.000Z",
			updated: "2026-01-01T00:00:00.000Z",
			path: "/tmp/handoff.md",
			markdown: "",
			body: "",
		}

		const table = renderHandoffList([hostile])
		const rows = table.split("\n")
		const dataRow = rows[2]!

		expect(dataRow.startsWith("|")).toBe(true)
		expect(dataRow.endsWith("|")).toBe(true)
		expect(dataRow.includes("\n")).toBe(false)

		// Header: | id | from → to | status | updated | title | → 5 cells → 7 parts.
		expect(splitRow(dataRow)).toHaveLength(7)
	})
})

describe("renderPlanList cell escaping", () => {
	it("keeps hostile source/title/path each in their own cell", () => {
		const hostile: PlanDoc = {
			source: `workspace-${HOSTILE}` as PlanSource,
			title: `title-${HOSTILE}`,
			path: `path-${HOSTILE}`,
			updatedAt: Date.parse("2026-01-01T00:00:00.000Z"),
			sizeBytes: 42,
		}

		const table = renderPlanList([hostile])
		const rows = table.split("\n")
		const dataRow = rows[2]!

		expect(dataRow.startsWith("|")).toBe(true)
		expect(dataRow.endsWith("|")).toBe(true)
		expect(dataRow.includes("\n")).toBe(false)

		// Header: | source | updated | title | path | → 4 cells → 6 parts.
		expect(splitRow(dataRow)).toHaveLength(6)
	})
})
