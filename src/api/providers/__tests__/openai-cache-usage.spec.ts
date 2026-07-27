// npx vitest run api/providers/__tests__/openai-cache-usage.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"

import { ApiHandlerOptions } from "../../../shared/api"
import { OpenAiHandler } from "../openai"

const mockCreate = vitest.fn()

vitest.mock("openai", () => {
	return {
		__esModule: true,
		default: vitest.fn().mockImplementation(() => ({
			chat: {
				completions: {
					create: mockCreate,
				},
			},
		})),
	}
})

/**
 * Builds a streaming response whose final chunk carries the given usage object.
 */
const streamWithUsage = (usage: unknown) => ({
	[Symbol.asyncIterator]: async function* () {
		yield { choices: [{ delta: { content: "hi" }, index: 0 }], usage: null }
		yield { choices: [{ delta: {}, index: 0 }], usage }
	},
})

describe("OpenAiHandler cache usage reporting", () => {
	let handler: OpenAiHandler

	const systemPrompt = "You are a helpful assistant."
	const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello!" }]

	const collectUsage = async () => {
		const chunks: any[] = []
		for await (const chunk of handler.createMessage(systemPrompt, messages)) {
			chunks.push(chunk)
		}
		return chunks.filter((chunk) => chunk.type === "usage")
	}

	beforeEach(() => {
		const options: ApiHandlerOptions = {
			openAiApiKey: "test-api-key",
			openAiModelId: "glm-5.2",
			openAiBaseUrl: "http://localhost:8000/v1",
		}
		handler = new OpenAiHandler(options)
		mockCreate.mockReset()
		delete process.env.ROO_LOG_RAW_USAGE
	})

	it("reads OpenAI-standard cached tokens from prompt_tokens_details", async () => {
		// This is the shape a self-hosted vLLM / SGLang server reports prefix-cache
		// hits with. Before this was parsed, every local run showed a 0% hit rate.
		mockCreate.mockResolvedValue(
			streamWithUsage({
				prompt_tokens: 95_000,
				completion_tokens: 500,
				prompt_tokens_details: { cached_tokens: 90_000 },
			}),
		)

		const usageChunks = await collectUsage()

		expect(usageChunks).toHaveLength(1)
		expect(usageChunks[0].inputTokens).toBe(95_000)
		expect(usageChunks[0].outputTokens).toBe(500)
		expect(usageChunks[0].cacheReadTokens).toBe(90_000)
	})

	it("reads cache writes from prompt_tokens_details.cache_write_tokens", async () => {
		mockCreate.mockResolvedValue(
			streamWithUsage({
				prompt_tokens: 1000,
				completion_tokens: 10,
				prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 800 },
			}),
		)

		const usageChunks = await collectUsage()

		expect(usageChunks[0].cacheWriteTokens).toBe(800)
		expect(usageChunks[0].cacheReadTokens).toBe(200)
	})

	it("still reads Anthropic-style top-level cache fields", async () => {
		mockCreate.mockResolvedValue(
			streamWithUsage({
				prompt_tokens: 1000,
				completion_tokens: 10,
				cache_creation_input_tokens: 400,
				cache_read_input_tokens: 600,
			}),
		)

		const usageChunks = await collectUsage()

		expect(usageChunks[0].cacheWriteTokens).toBe(400)
		expect(usageChunks[0].cacheReadTokens).toBe(600)
	})

	it("prefers prompt_tokens_details when both conventions are present", async () => {
		mockCreate.mockResolvedValue(
			streamWithUsage({
				prompt_tokens: 1000,
				completion_tokens: 10,
				cache_read_input_tokens: 111,
				prompt_tokens_details: { cached_tokens: 222 },
			}),
		)

		const usageChunks = await collectUsage()

		expect(usageChunks[0].cacheReadTokens).toBe(222)
	})

	it("leaves cache fields undefined when the endpoint reports no caching", async () => {
		mockCreate.mockResolvedValue(streamWithUsage({ prompt_tokens: 1000, completion_tokens: 10 }))

		const usageChunks = await collectUsage()

		expect(usageChunks[0].cacheReadTokens).toBeUndefined()
		expect(usageChunks[0].cacheWriteTokens).toBeUndefined()
	})

	it("dumps the raw usage object when ROO_LOG_RAW_USAGE=1", async () => {
		process.env.ROO_LOG_RAW_USAGE = "1"
		const logSpy = vitest.spyOn(console, "log").mockImplementation(() => {})

		mockCreate.mockResolvedValue(
			streamWithUsage({
				prompt_tokens: 1000,
				completion_tokens: 10,
				prompt_tokens_details: { cached_tokens: 900 },
			}),
		)

		await collectUsage()

		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("raw usage"))
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("cached_tokens"))
		logSpy.mockRestore()
	})

	it("does not log raw usage by default", async () => {
		const logSpy = vitest.spyOn(console, "log").mockImplementation(() => {})

		mockCreate.mockResolvedValue(streamWithUsage({ prompt_tokens: 1000, completion_tokens: 10 }))

		await collectUsage()

		expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("raw usage"))
		logSpy.mockRestore()
	})
})
