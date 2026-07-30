// cd src && npx vitest run core/condense/__tests__/condense-fact-validation.spec.ts

import type { Anthropic } from "@anthropic-ai/sdk"

import { ApiHandler } from "../../../api"
import { ApiMessage } from "../../task-persistence/apiMessages"
import { buildContextLedger } from "../../context-management/ledger"
import { summarizeConversation } from "../index"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		// Condensing now reports what the call cost (services/model_attribution
		// on the backend groups it under completionKind "condense"), so the mock
		// has to answer `hasInstance` as well.
		hasInstance: vi.fn().mockReturnValue(true),
		instance: {
			captureContextCondensed: vi.fn(),
			captureLlmCompletion: vi.fn(),
		},
	},
}))

const taskId = "fact-validation-task"

/** Handler whose condense call yields exactly `summary`. */
function handlerReturning(summary: string): ApiHandler {
	return {
		createMessage: vi.fn().mockReturnValue(
			(async function* () {
				yield { type: "text" as const, text: summary }
				yield { type: "usage" as const, totalCost: 0.01, outputTokens: 50 }
			})(),
		),
		countTokens: vi.fn().mockResolvedValue(100),
		getModel: vi.fn().mockReturnValue({
			id: "test-model",
			info: { contextWindow: 8000, maxTokens: 4000, supportsImages: false, supportsPromptCache: false },
		}),
	} as unknown as ApiHandler
}

/**
 * A history whose critical facts all sit well before the retained tail: the request, one
 * completed edit, and one still-failing test run. Padding keeps the last six messages (the
 * tail `computeCondenseKeepBoundary` preserves) free of those facts, so anything that shows
 * up in the addendum was genuinely recovered rather than merely retained.
 */
function historyWithCriticalFacts(): ApiMessage[] {
	const messages: ApiMessage[] = [
		{ role: "user", content: "<task>Add exponential backoff to the openrouter provider</task>", ts: 1 },
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "use-edit",
					name: "write_to_file",
					input: { path: "src/api/providers/openrouter.ts" },
				},
			] as Anthropic.Messages.ContentBlockParam[],
			ts: 2,
		},
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "use-edit", content: "The content was successfully saved." },
			] as Anthropic.Messages.ContentBlockParam[],
			ts: 3,
		},
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "use-test", name: "execute_command", input: { command: "pnpm test" } },
			] as Anthropic.Messages.ContentBlockParam[],
			ts: 4,
		},
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "use-test",
					content: "Error: 3 assertions failed in backoff.spec.ts",
				},
			] as Anthropic.Messages.ContentBlockParam[],
			ts: 5,
		},
	]

	// Padding: unrelated chatter, long enough to push the facts above out of the kept tail.
	for (let i = 0; i < 10; i++) {
		messages.push({ role: "assistant", content: `Thinking about step ${i}.`, ts: 6 + i * 2 })
		messages.push({ role: "user", content: `Continue with step ${i}.`, ts: 7 + i * 2 })
	}

	return messages
}

/** The text blocks of the summary message the condense produced. */
function summaryTexts(messages: ApiMessage[]): string[] {
	const summaryMessage = messages.find((message) => message.isSummary)
	expect(summaryMessage).toBeDefined()
	const content = summaryMessage!.content
	expect(Array.isArray(content)).toBe(true)
	return (content as Anthropic.Messages.ContentBlockParam[])
		.filter((block) => block.type === "text")
		.map((block) => (block as Anthropic.Messages.TextBlockParam).text)
}

describe("summarizeConversation + critical-fact validation", () => {
	beforeEach(() => vi.clearAllMocks())

	it("appends the facts a weak summary dropped", async () => {
		const messages = historyWithCriticalFacts()
		const ledger = buildContextLedger(messages)

		// The kind of summary a small background model produces: fluent, and missing everything
		// that cannot be re-derived.
		const result = await summarizeConversation({
			messages,
			apiHandler: handlerReturning("The user and the assistant discussed several steps of the work."),
			systemPrompt: "sys",
			taskId,
			ledger,
		})

		expect(result.error).toBeUndefined()
		expect(result.factsChecked).toBe(3)
		expect(result.factsRecovered).toBe(3)

		const texts = summaryTexts(result.messages)
		const addendum = texts.find((text) => text.includes("Facts Carried Over From The Condensed History"))
		expect(addendum).toBeDefined()
		expect(addendum).toContain("GOAL: Add exponential backoff to the openrouter provider")
		expect(addendum).toContain("ALREADY CHANGED: src/api/providers/openrouter.ts (write_to_file)")
		expect(addendum).toContain("STILL BROKEN: execute_command failed on pnpm test")

		// The model's own summary is still there — the addendum is added, never a replacement.
		expect(texts.some((text) => text.includes("discussed several steps"))).toBe(true)
	})

	it("adds nothing when the summary already carried the facts", async () => {
		const messages = historyWithCriticalFacts()
		const ledger = buildContextLedger(messages)

		const result = await summarizeConversation({
			messages,
			apiHandler: handlerReturning(
				`Goal: add exponential backoff to the openrouter provider.
				 Changes: openrouter.ts was rewritten with the backoff loop.
				 Status: pnpm test still fails, 3 assertions in backoff.spec.ts are red.`,
			),
			systemPrompt: "sys",
			taskId,
			ledger,
		})

		expect(result.factsChecked).toBe(3)
		expect(result.factsRecovered).toBe(0)
		expect(summaryTexts(result.messages).some((t) => t.includes("Facts Carried Over"))).toBe(false)
	})

	it("is inert for callers that pass no ledger", async () => {
		const messages = historyWithCriticalFacts()

		const result = await summarizeConversation({
			messages,
			apiHandler: handlerReturning("A summary that mentions nothing in particular."),
			systemPrompt: "sys",
			taskId,
		})

		expect(result.factsChecked).toBe(0)
		expect(result.factsRecovered).toBe(0)
		expect(summaryTexts(result.messages).some((t) => t.includes("Facts Carried Over"))).toBe(false)
	})

	it("does not re-state facts the retained tail still carries verbatim", async () => {
		// Same facts, but now the failing test run is inside the kept tail, so the post-condense
		// model can read it directly. Restating it would spend tokens on nothing.
		const messages = historyWithCriticalFacts()
		messages.push(
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "use-test-2", name: "execute_command", input: { command: "pnpm lint" } },
				] as Anthropic.Messages.ContentBlockParam[],
				ts: 100,
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "use-test-2",
						content: "Error: unused import in openrouter.ts",
					},
				] as Anthropic.Messages.ContentBlockParam[],
				ts: 101,
			},
		)
		const ledger = buildContextLedger(messages)

		// Guard against a vacuous assertion below: the lint failure IS a critical fact, it is
		// simply one the tail already carries.
		expect(ledger.openErrors.map((fact) => fact.subject)).toEqual(
			expect.arrayContaining(["pnpm test", "pnpm lint"]),
		)

		const result = await summarizeConversation({
			messages,
			apiHandler: handlerReturning("Some work happened."),
			systemPrompt: "sys",
			taskId,
			ledger,
		})

		expect(result.factsChecked).toBe(4)
		expect(result.factsRecovered).toBe(3)

		const addendum = summaryTexts(result.messages).find((t) => t.includes("Facts Carried Over")) ?? ""
		expect(addendum).toContain("pnpm test")
		expect(addendum).not.toContain("pnpm lint")
	})
})
