// cd src && npx vitest run core/condense/__tests__/factValidation.spec.ts

import type { ContextLedger, LedgerFact } from "../../context-management/ledger/types"
import {
	validateSummaryFacts,
	buildFactAddendum,
	factProbeTokens,
	FACT_COVERAGE_THRESHOLD,
	MAX_ADDENDUM_FACTS,
} from "../factValidation"

let nextIndex = 0

function fact(partial: Partial<LedgerFact> & Pick<LedgerFact, "class" | "text">): LedgerFact {
	return { index: nextIndex++, ...partial }
}

/** Minimal ledger carrying exactly the facts under test. */
function ledgerOf(...facts: LedgerFact[]): ContextLedger {
	return {
		goal: facts.find((f) => f.class === "goal"),
		userInstructions: facts.filter((f) => f.class === "user_instruction"),
		decisions: facts.filter((f) => f.class === "decision"),
		fileChanges: facts.filter((f) => f.class === "file_change"),
		openErrors: facts.filter((f) => f.class === "open_error"),
		validations: facts.filter((f) => f.class === "validation"),
		artifacts: facts.filter((f) => f.class === "artifact"),
		facts,
		criticalToolUseIds: new Set<string>(),
	}
}

beforeEach(() => {
	nextIndex = 0
})

describe("factProbeTokens", () => {
	it("reduces a file change to its file name", () => {
		// The directory prefix is noise a summary is entitled to drop.
		const tokens = factProbeTokens(
			fact({
				class: "file_change",
				text: "src/core/context-management/microcompact.ts (apply_diff)",
				subject: "src/core/context-management/microcompact.ts",
			}),
		)
		expect(tokens).toEqual(["microcompact"])
	})

	it("keeps the failure text alongside the file name for an open error", () => {
		const tokens = factProbeTokens(
			fact({
				class: "open_error",
				text: "apply_diff failed on src/api/providers/openrouter.ts: no sufficiently similar match found",
				subject: "src/api/providers/openrouter.ts",
			}),
		)
		expect(tokens).toContain("openrouter")
		expect(tokens).toContain("similar")
		// The directory segments must not pad the probe.
		expect(tokens).not.toContain("providers")
	})

	it("drops stopwords and short tokens", () => {
		const tokens = factProbeTokens(fact({ class: "goal", text: "Fix the bug in the retry loop for this user" }))
		expect(tokens).toEqual(["retry", "loop"])
	})

	it("is capped so one enormous fact cannot dominate", () => {
		const words = Array.from({ length: 40 }, (_, i) => `distinctword${i}`).join(" ")
		expect(factProbeTokens(fact({ class: "goal", text: words })).length).toBeLessThanOrEqual(12)
	})
})

describe("validateSummaryFacts", () => {
	it("does nothing without a ledger", () => {
		// Callers that never built one must be completely unaffected.
		const result = validateSummaryFacts("anything", undefined)
		expect(result).toEqual({ checked: 0, missing: [], addendum: "" })
	})

	it("passes a summary that carried every critical fact", () => {
		const ledger = ledgerOf(
			fact({ class: "goal", text: "Migrate the sliding window truncation to a token budget" }),
			fact({
				class: "file_change",
				text: "src/core/sliding-window/index.ts (apply_diff)",
				subject: "src/core/sliding-window/index.ts",
			}),
		)

		const summary = `The task is to migrate sliding window truncation onto a token budget.
			So far index.ts under sliding-window was rewritten to compute the budget.`

		const result = validateSummaryFacts(summary, ledger)
		expect(result.checked).toBe(2)
		expect(result.missing).toEqual([])
		expect(result.addendum).toBe("")
	})

	it("flags a critical fact the summary dropped", () => {
		const ledger = ledgerOf(
			fact({ class: "goal", text: "Migrate the sliding window truncation to a token budget" }),
			fact({
				class: "file_change",
				text: "src/core/sliding-window/index.ts (apply_diff)",
				subject: "src/core/sliding-window/index.ts",
			}),
		)

		const summary = "The task is to migrate sliding window truncation onto a token budget."

		const result = validateSummaryFacts(summary, ledger)
		expect(result.missing).toHaveLength(1)
		expect(result.missing[0].fact.class).toBe("file_change")
		expect(result.addendum).toContain("ALREADY CHANGED")
		expect(result.addendum).toContain("sliding-window/index.ts")
	})

	it("rejects a summary that name-drops the file but drops the failure", () => {
		// This is the case a subject-only check would wave through: the model mentions the file
		// while losing the fact that something about it is still broken.
		const ledger = ledgerOf(
			fact({
				class: "open_error",
				text: "execute_command failed on pnpm test: 3 assertions failed in providers.spec.ts",
				subject: "pnpm test",
			}),
		)

		const result = validateSummaryFacts("Ran pnpm test after the change.", ledger)
		expect(result.missing).toHaveLength(1)
		expect(result.missing[0].coverage).toBeLessThan(FACT_COVERAGE_THRESHOLD)
		expect(result.addendum).toContain("STILL BROKEN")
	})

	it("accepts a summary that describes the failure in its own words", () => {
		// Coverage, not exact phrasing: paraphrase must not be punished or the addendum becomes
		// unconditional and stops being a validation.
		const ledger = ledgerOf(
			fact({
				class: "open_error",
				text: "execute_command failed on pnpm test: 3 assertions failed in providers.spec.ts",
				subject: "pnpm test",
			}),
		)

		const summary = "pnpm test still fails: three assertions in providers.spec.ts are red."
		expect(validateSummaryFacts(summary, ledger).missing).toEqual([])
	})

	it("does not flag a fact whose own tool result survives in the retained tail", () => {
		const ledger = ledgerOf(
			fact({
				class: "file_change",
				text: "packages/types/src/telemetry.ts (write_to_file)",
				subject: "packages/types/src/telemetry.ts",
				toolUseId: "use-1",
			}),
		)

		const summary = "Working on the provider plumbing."

		expect(validateSummaryFacts(summary, ledger, { toolUseIds: new Set(["use-1"]) }).missing).toEqual([])
		// ...but it IS flagged when the tail does not carry it.
		expect(validateSummaryFacts(summary, ledger).missing).toHaveLength(1)
	})

	it("does not let unrelated tail text vouch for a tool-derived fact", () => {
		// A one-token probe against a big raw tail is too weak to be evidence: the tail below
		// mentions the file only to report a different problem, and says nothing about the edit
		// that already landed. Suppressing the fact here is exactly how finished work gets redone.
		const ledger = ledgerOf(
			fact({
				class: "file_change",
				text: "src/api/providers/openrouter.ts (apply_diff)",
				subject: "src/api/providers/openrouter.ts",
				toolUseId: "use-edit",
			}),
		)

		const result = validateSummaryFacts("Some work happened.", ledger, {
			text: "Error: unused import in openrouter.ts",
			toolUseIds: new Set(["use-lint"]),
		})
		expect(result.missing).toHaveLength(1)
	})

	it("still reads the retained tail for facts that have no tool result of their own", () => {
		// The goal is derived from a user message, so there is no id to match on.
		const ledger = ledgerOf(fact({ class: "goal", text: "Rebuild the charlie pipeline end to end" }))

		expect(validateSummaryFacts("A summary.", ledger).missing).toHaveLength(1)
		expect(
			validateSummaryFacts("A summary.", ledger, { text: "reminder: rebuild the charlie pipeline" }).missing,
		).toEqual([])
	})

	it("only checks critical classes", () => {
		const ledger = ledgerOf(
			fact({
				class: "artifact",
				text: "src/some/unmentioned/reader.ts",
				subject: "src/some/unmentioned/reader.ts",
			}),
			fact({ class: "validation", text: "pnpm lint → passed", subject: "pnpm lint" }),
			fact({ class: "decision", text: "[pending] wire the telemetry event" }),
		)

		// A re-readable file and a re-runnable command are not worth addendum tokens.
		const result = validateSummaryFacts("unrelated summary", ledger)
		expect(result.checked).toBe(0)
		expect(result.addendum).toBe("")
	})

	it("skips facts with no distinctive tokens rather than guessing", () => {
		const ledger = ledgerOf(fact({ class: "goal", text: "do it now" }))
		const result = validateSummaryFacts("unrelated summary", ledger)
		expect(result.checked).toBe(1)
		expect(result.missing).toEqual([])
	})

	it("orders the addendum by cost of loss", () => {
		const ledger = ledgerOf(
			fact({ class: "file_change", text: "src/alpha.ts (write_to_file)", subject: "src/alpha.ts" }),
			fact({
				class: "open_error",
				text: "apply_diff failed on src/bravo.ts: anchor mismatch",
				subject: "src/bravo.ts",
			}),
			fact({ class: "goal", text: "Rebuild the charlie pipeline end to end" }),
			fact({ class: "user_instruction", text: "leave the delta migrations alone" }),
		)

		const classes = validateSummaryFacts("nothing relevant here", ledger).missing.map((m) => m.fact.class)
		expect(classes).toEqual(["goal", "user_instruction", "open_error", "file_change"])
	})

	it("restores a mid-task instruction the summary dropped", () => {
		// The class exists because a summary that keeps the goal and loses the correction to it is
		// worse than one that loses both: the agent proceeds confidently on the superseded plan.
		const ledger = ledgerOf(
			fact({ class: "goal", text: "Migrate the cluster to k3s" }),
			fact({ class: "user_instruction", text: "actually target RKE2, not k3s" }),
		)

		const result = validateSummaryFacts("The user asked to migrate the cluster to k3s.", ledger)
		expect(result.missing.map((m) => m.fact.class)).toEqual(["user_instruction"])
		expect(result.addendum).toContain("- USER ALSO SAID: actually target RKE2, not k3s")
	})
})

describe("buildFactAddendum", () => {
	it("is empty when nothing is missing", () => {
		expect(buildFactAddendum([])).toBe("")
	})

	it("emits one labelled line per fact inside a reminder block", () => {
		const addendum = buildFactAddendum([
			{ fact: fact({ class: "goal", text: "Ship the resume snapshot" }), coverage: 0 },
			{ fact: fact({ class: "open_error", text: "tsc failed on src/x.ts" }), coverage: 0.2 },
		])

		expect(addendum.startsWith("<system-reminder>")).toBe(true)
		expect(addendum.endsWith("</system-reminder>")).toBe(true)
		expect(addendum).toContain("- GOAL: Ship the resume snapshot")
		expect(addendum).toContain("- STILL BROKEN: tsc failed on src/x.ts")
	})

	it("reports the overflow instead of truncating silently", () => {
		const many = Array.from({ length: MAX_ADDENDUM_FACTS + 3 }, (_, i) => ({
			fact: fact({ class: "file_change" as const, text: `src/file${i}.ts (write_to_file)` }),
			coverage: 0,
		}))

		const addendum = buildFactAddendum(many)
		expect(addendum).toContain("(3 further facts omitted for length)")
		expect(addendum.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(MAX_ADDENDUM_FACTS + 1)
	})

	it("uses the singular for a single overflow entry", () => {
		const many = Array.from({ length: MAX_ADDENDUM_FACTS + 1 }, (_, i) => ({
			fact: fact({ class: "file_change" as const, text: `src/file${i}.ts (write_to_file)` }),
			coverage: 0,
		}))

		expect(buildFactAddendum(many)).toContain("(1 further fact omitted for length)")
	})
})
