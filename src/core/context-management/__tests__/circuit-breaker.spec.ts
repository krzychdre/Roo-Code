// cd src && npx vitest run core/context-management/__tests__/circuit-breaker.spec.ts

import type { ModelInfo } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { BaseProvider } from "../../../api/providers/base-provider"
import { ApiMessage } from "../../task-persistence/apiMessages"

import { manageContext } from "../index"
import { MICROCOMPACT_MIN_KEEP } from "../microcompact"

let counter = 0

/** An assistant `tool_use` + user `tool_result` pair (so microcompaction has something to clear). */
function toolPair(toolName: string, resultContent: string, id?: string): [ApiMessage, ApiMessage] {
	counter += 1
	const useId = id ?? `tool-${counter}`
	return [
		{ role: "assistant", content: [{ type: "tool_use", id: useId, name: toolName, input: {} }], ts: counter },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: useId, content: resultContent }], ts: counter },
	]
}

/** A plain (no tool blocks) conversation so microcompaction is a guaranteed no-op. */
function plainMessages(n: number): ApiMessage[] {
	const out: ApiMessage[] = [{ role: "user", content: "Initial task", ts: 0 }]
	for (let i = 1; i < n; i++) {
		out.push({ role: i % 2 === 1 ? "assistant" : "user", content: `msg ${i}`, ts: i })
	}
	// manageContext assumes the final message is a user message.
	if (out[out.length - 1].role !== "user") {
		out.push({ role: "user", content: "final", ts: n })
	}
	return out
}

class MockApiHandler extends BaseProvider {
	createMessage(): any {
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "text", text: "Mock summary content" }
				yield { type: "usage", inputTokens: 100, outputTokens: 50, totalCost: 0.01 }
			},
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "test-model",
			info: {
				contextWindow: 30000,
				maxTokens: 1000,
				supportsPromptCache: true,
				supportsImages: false,
				inputPrice: 0,
				outputPrice: 0,
				description: "Test model",
			},
		}
	}
}

// contextWindow 30000, maxTokens 1000 -> allowedTokens = 30000*0.9 - 1000 = 26000.
// autoCondenseContextPercent 50 -> condense threshold at 15000 tokens.
const baseOptions = {
	contextWindow: 30000,
	maxTokens: 1000,
	autoCondenseContext: true,
	autoCondenseContextPercent: 50,
	systemPrompt: "sys",
	taskId: "circuit-breaker-task",
	profileThresholds: {},
	currentProfileId: "default",
}

describe("manageContext auto-condense circuit breaker", () => {
	const apiHandler = new MockApiHandler()
	let createSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		counter = 0
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
		// createMessage is called ONLY by summarizeConversation, so it is a clean
		// proxy for "a condense was attempted".
		createSpy = vi.spyOn(apiHandler, "createMessage")
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("attempts condense when the breaker is CLOSED (over threshold, under hard limit)", async () => {
		const messages = plainMessages(10)

		const result = await manageContext({
			...baseOptions,
			messages,
			totalTokens: 16000, // ~53% -> over the 50% condense threshold, under allowedTokens (26000)
			apiHandler,
			// condenseCircuitOpen omitted -> closed
		})

		expect(createSpy).toHaveBeenCalled()
		expect(result.summary).toBe("Mock summary content")
		expect(result.truncationId).toBeUndefined()
	})

	it("SKIPS condense when the breaker is OPEN and does not truncate while under the hard limit", async () => {
		const messages = plainMessages(10)

		const result = await manageContext({
			...baseOptions,
			messages,
			totalTokens: 16000, // same as above: over condense threshold, under allowedTokens
			apiHandler,
			condenseCircuitOpen: true,
		})

		// No LLM summary attempt at all.
		expect(createSpy).not.toHaveBeenCalled()
		expect(result.summary).toBe("")
		// Under the hard limit, so truncation does not fire either -> a true no-op.
		expect(result.truncationId).toBeUndefined()
		expect(result.messages).toBe(messages)
	})

	it("when OPEN and over the hard limit, skips condense but STILL truncates", async () => {
		const messages = plainMessages(20)

		const result = await manageContext({
			...baseOptions,
			messages,
			totalTokens: 29000, // ~97% -> over allowedTokens (26000)
			apiHandler,
			condenseCircuitOpen: true,
		})

		expect(createSpy).not.toHaveBeenCalled()
		expect(result.summary).toBe("")
		expect(result.truncationId).toBeDefined()
	})

	it("when OPEN, microcompaction still runs (condense skipped, truncation handles the rest)", async () => {
		// 10 large read results: microcompaction clears every eligible one (all but the
		// newest MICROCOMPACT_MIN_KEEP); still over the hard limit (totalTokens 29000),
		// so truncation runs. Condense never attempted.
		const big: ApiMessage[] = [{ role: "user", content: "Initial task", ts: 0 }]
		for (let i = 0; i < 10; i++) {
			big.push(...toolPair("read_file", "x".repeat(6000), `big-${i}`))
		}

		const result = await manageContext({
			...baseOptions,
			messages: big,
			totalTokens: 29000,
			apiHandler,
			condenseCircuitOpen: true,
		})

		expect(result.microcompacted).toBe(true)
		expect(result.microcompactClearedCount).toBe(10 - MICROCOMPACT_MIN_KEEP)
		expect(createSpy).not.toHaveBeenCalled()
		expect(result.summary).toBe("")
		expect(result.truncationId).toBeDefined()
	})
})
