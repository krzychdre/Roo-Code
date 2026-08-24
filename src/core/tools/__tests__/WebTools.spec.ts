// npx vitest run core/tools/__tests__/WebTools.spec.ts

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

import type { Task } from "../../task/Task"
import { WebFetchTool } from "../WebFetchTool"
import { WebSearchTool } from "../WebSearchTool"

/** Minimal Task stand-in: the web tools only touch state, say/ask and counters. */
function makeTask(state: Record<string, unknown>) {
	return {
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue(undefined),
		sayAndCreateMissingParamError: vi.fn(async (tool: string, param: string) => `Missing "${param}" for ${tool}`),
		recordToolError: vi.fn(),
		providerRef: { deref: () => ({ getState: async () => state }) },
	} as unknown as Task & { say: ReturnType<typeof vi.fn> }
}

function makeCallbacks(approve = true) {
	return {
		askApproval: vi.fn().mockResolvedValue(approve),
		handleError: vi.fn().mockResolvedValue(undefined),
		pushToolResult: vi.fn(),
		toolCallId: "call-1",
	}
}

const enabledState = {
	webToolsEnabled: true,
	searxngBaseUrl: "https://searx.test",
	webSearchMaxResults: 3,
}

/**
 * Response-like object carrying a real body, because both services read the
 * body with a byte cap rather than calling `response.json()` / `response.text()`.
 */
function bodyResponse(text: string, contentType = "application/json") {
	const bytes = Buffer.from(text, "utf8")
	let sent = false

	return {
		ok: true,
		status: 200,
		url: "",
		headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
		text: async () => text,
		body: {
			getReader: () => ({
				read: async () => {
					if (sent) {
						return { done: true, value: undefined }
					}
					sent = true
					return { done: false, value: new Uint8Array(bytes) }
				},
				cancel: async () => undefined,
			}),
		},
	} as unknown as Response
}

/** The text pushed as the tool result, whether a plain string or a block array. */
const resultText = (callbacks: ReturnType<typeof makeCallbacks>): string => {
	const arg = callbacks.pushToolResult.mock.calls[0]?.[0]
	return typeof arg === "string" ? arg : JSON.stringify(arg)
}

describe("WebSearchTool", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	beforeEach(() => {
		vi.stubGlobal("fetch", async (input: string) => {
			const query = decodeURIComponent(new URL(input).searchParams.get("q") ?? "")
			return bodyResponse(
				JSON.stringify({
					results: [{ title: `T ${query}`, url: `https://example.com/${query}`, content: `S ${query}` }],
				}),
			)
		})
	})

	it("returns formatted results when enabled and configured", async () => {
		const task = makeTask(enabledState)
		const callbacks = makeCallbacks()

		await new WebSearchTool().execute({ queries: ["zod"] }, task, callbacks)

		expect(resultText(callbacks)).toContain("https://example.com/zod")
		expect(task.consecutiveMistakeCount).toBe(0)
	})

	it("reports a missing queries parameter as a tool error, not a throw", async () => {
		const task = makeTask(enabledState)
		const callbacks = makeCallbacks()

		await expect(new WebSearchTool().execute({ queries: [] }, task, callbacks)).resolves.toBeUndefined()

		expect(resultText(callbacks)).toContain('Missing "queries" for web_search')
		expect(callbacks.askApproval).not.toHaveBeenCalled()
	})

	it("returns a tool error when web tools are disabled", async () => {
		const task = makeTask({ webToolsEnabled: false })
		const callbacks = makeCallbacks()

		await new WebSearchTool().execute({ queries: ["zod"] }, task, callbacks)

		expect(resultText(callbacks)).toContain("web_search is disabled")
	})

	it("returns corrective text when no backend URL is configured", async () => {
		const task = makeTask({ webToolsEnabled: true, searxngBaseUrl: "" })
		const callbacks = makeCallbacks()

		await new WebSearchTool().execute({ queries: ["zod"] }, task, callbacks)

		expect(resultText(callbacks)).toContain("no backend URL configured")
	})

	it("returns corrective text instead of throwing when the backend is unreachable", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("ECONNREFUSED")
		})

		const task = makeTask(enabledState)
		const callbacks = makeCallbacks()

		await expect(new WebSearchTool().execute({ queries: ["zod"] }, task, callbacks)).resolves.toBeUndefined()

		expect(resultText(callbacks)).toContain("web_search backend unreachable")
		expect(resultText(callbacks)).toContain("tell the user or continue without web data")
	})

	it("pushes a denial result when the user rejects approval", async () => {
		const task = makeTask(enabledState)
		const callbacks = makeCallbacks(false)

		await new WebSearchTool().execute({ queries: ["zod"] }, task, callbacks)

		expect(resultText(callbacks)).toContain("denied")
	})

	it("never asks for approval when the tool is disabled", async () => {
		const task = makeTask({ webToolsEnabled: false })
		const callbacks = makeCallbacks()

		await new WebSearchTool().execute({ queries: ["zod"] }, task, callbacks)

		expect(callbacks.askApproval).not.toHaveBeenCalled()
	})

	it("never asks for approval when the backend URL is missing", async () => {
		const task = makeTask({ webToolsEnabled: true, searxngBaseUrl: "" })
		const callbacks = makeCallbacks()

		await new WebSearchTool().execute({ queries: ["zod"] }, task, callbacks)

		expect(callbacks.askApproval).not.toHaveBeenCalled()
	})

	it("emits no extra tool card after approval", async () => {
		const task = makeTask(enabledState)
		const callbacks = makeCallbacks()

		await new WebSearchTool().execute({ queries: ["zod"] }, task, callbacks)

		// The approval ask already rendered the card; a second say("tool")
		// would duplicate it in the transcript.
		const toolSays = task.say.mock.calls.filter((call: unknown[]) => call[0] === "tool")
		expect(toolSays).toHaveLength(0)
	})
})

describe("WebFetchTool", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	const htmlResponse = (body: string, contentType = "text/html") => bodyResponse(body, contentType)

	it("returns the page as markdown", async () => {
		vi.stubGlobal("fetch", async () => htmlResponse("<h1>Docs</h1>"))

		const task = makeTask(enabledState)
		const callbacks = makeCallbacks()

		await new WebFetchTool().execute({ url: "https://example.com/page" }, task, callbacks)

		expect(resultText(callbacks)).toContain("# Docs")
	})

	it("reports a missing url parameter as a tool error", async () => {
		const task = makeTask(enabledState)
		const callbacks = makeCallbacks()

		await new WebFetchTool().execute({ url: "" }, task, callbacks)

		expect(resultText(callbacks)).toContain('Missing "url" for web_fetch')
	})

	it("returns a tool error when web tools are disabled", async () => {
		const task = makeTask({ webToolsEnabled: false })
		const callbacks = makeCallbacks()

		await new WebFetchTool().execute({ url: "https://example.com" }, task, callbacks)

		expect(resultText(callbacks)).toContain("web_fetch is disabled")
	})

	it("rejects a binary content type without throwing", async () => {
		vi.stubGlobal("fetch", async () => htmlResponse("%PDF", "application/pdf"))

		const task = makeTask(enabledState)
		const callbacks = makeCallbacks()

		await expect(
			new WebFetchTool().execute({ url: "https://example.com/a.pdf" }, task, callbacks),
		).resolves.toBeUndefined()

		expect(resultText(callbacks)).toContain("only HTML and text responses are supported")
	})

	it("truncates an oversized page with a notice", async () => {
		vi.stubGlobal("fetch", async () => htmlResponse(`<p>${"x".repeat(50_000)}</p>`))

		const task = makeTask({ ...enabledState, webFetchMaxBytes: 4096 })
		const callbacks = makeCallbacks()

		await new WebFetchTool().execute({ url: "https://example.com/big" }, task, callbacks)

		expect(resultText(callbacks)).toContain("[Truncated: showing the first 4096 of")
	})

	it("never asks for approval when the tool is disabled", async () => {
		const task = makeTask({ webToolsEnabled: false })
		const callbacks = makeCallbacks()

		await new WebFetchTool().execute({ url: "https://example.com" }, task, callbacks)

		expect(callbacks.askApproval).not.toHaveBeenCalled()
	})

	it("emits no extra tool card after approval", async () => {
		vi.stubGlobal("fetch", async () => htmlResponse("<h1>Docs</h1>"))

		const task = makeTask(enabledState)
		const callbacks = makeCallbacks()

		await new WebFetchTool().execute({ url: "https://example.com/page" }, task, callbacks)

		const toolSays = task.say.mock.calls.filter((call: unknown[]) => call[0] === "tool")
		expect(toolSays).toHaveLength(0)
	})

	it("refuses a private address as a tool error after approval", async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal("fetch", fetchMock)

		const task = makeTask(enabledState)
		const callbacks = makeCallbacks()

		await expect(
			new WebFetchTool().execute({ url: "http://169.254.169.254/latest/meta-data/" }, task, callbacks),
		).resolves.toBeUndefined()

		expect(resultText(callbacks)).toContain("only reaches public internet addresses")
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
