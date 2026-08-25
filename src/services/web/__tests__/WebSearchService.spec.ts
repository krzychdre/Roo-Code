// npx vitest run services/web/__tests__/WebSearchService.spec.ts

import { resolveWebToolsConfig, WEB_TOOLS_DEFAULTS } from "@roo-code/types"

import {
	createSearchBackend,
	formatSearchResults,
	MAX_SEARCH_RESULT_TEXT_BYTES,
	SearxngBackend,
	WebSearchError,
	WebSearchService,
} from "../WebSearchService"

const config = (overrides: Partial<Parameters<typeof resolveWebToolsConfig>[0]> = {}) =>
	resolveWebToolsConfig({
		webToolsEnabled: true,
		searxngBaseUrl: "https://searx.test",
		...overrides,
	})

/**
 * Builds a Response-like object carrying `text` as the body. The backend reads
 * the body with a byte cap rather than calling `response.json()`, so the mock
 * has to supply real bytes.
 */
function textResponse(text: string, init: { status?: number; contentLength?: string } = {}) {
	const bytes = Buffer.from(text, "utf8")
	const status = init.status ?? 200
	const headers = new Map<string, string>()

	if (init.contentLength !== undefined) {
		headers.set("content-length", init.contentLength)
	}

	let sent = false

	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
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

/** Builds a fetch mock that answers with the given JSON body per query. */
function jsonFetch(byQuery: Record<string, unknown>) {
	return vi.fn(async (input: string) => {
		const query = decodeURIComponent(new URL(input).searchParams.get("q") ?? "")
		return textResponse(JSON.stringify(byQuery[query] ?? { results: [] }))
	})
}

const hit = (n: number, host = "example.com") => ({
	title: `Title ${n}`,
	url: `https://${host}/${n}`,
	content: `Snippet ${n}`,
})

describe("SearxngBackend", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("calls the JSON API on the configured base URL and strips trailing slashes", async () => {
		const fetchMock = jsonFetch({ zod: { results: [hit(1)] } })
		vi.stubGlobal("fetch", fetchMock)

		const backend = new SearxngBackend("https://searx.test/")
		const results = await backend.search("zod", 5, new AbortController().signal)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock.mock.calls[0][0]).toBe("https://searx.test/search?q=zod&format=json")
		expect(results).toEqual([{ title: "Title 1", url: "https://example.com/1", snippet: "Snippet 1" }])
	})

	it("skips entries without a URL and falls back to the URL when the title is missing", async () => {
		vi.stubGlobal(
			"fetch",
			jsonFetch({
				q: { results: [{ title: "no url" }, { url: "https://example.com/x", content: "c" }] },
			}),
		)

		const results = await new SearxngBackend("https://searx.test").search("q", 5, new AbortController().signal)

		expect(results).toEqual([{ title: "https://example.com/x", url: "https://example.com/x", snippet: "c" }])
	})
})

describe("createSearchBackend", () => {
	it("rejects an empty base URL with corrective text", () => {
		expect(() => createSearchBackend(config({ searxngBaseUrl: "" }))).toThrow(WebSearchError)
		expect(() => createSearchBackend(config({ searxngBaseUrl: "" }))).toThrow(
			/no backend URL configured.*Settings > Web tools/,
		)
	})

	it("rejects a non-http base URL", () => {
		expect(() => createSearchBackend(config({ searxngBaseUrl: "searx.test" }))).toThrow(/not an http\(s\) URL/)
	})
})

describe("WebSearchService", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("merges several queries into one block per query, in call order", async () => {
		vi.stubGlobal(
			"fetch",
			jsonFetch({
				first: { results: [hit(1)] },
				second: { results: [hit(2)] },
			}),
		)

		const service = new WebSearchService(new SearxngBackend("https://searx.test"), config())
		const blocks = await service.search(["first", "second"])

		expect(blocks.map((b) => b.query)).toEqual(["first", "second"])
		expect(blocks[0].results.map((r) => r.url)).toEqual(["https://example.com/1"])
		expect(blocks[1].results.map((r) => r.url)).toEqual(["https://example.com/2"])
	})

	it("dedups by URL across queries, keeping the first occurrence", async () => {
		vi.stubGlobal(
			"fetch",
			jsonFetch({
				a: { results: [hit(1), hit(2)] },
				// Same page, differing only by trailing slash and fragment.
				b: { results: [{ ...hit(1), url: "https://example.com/1/#top" }, hit(3)] },
			}),
		)

		const service = new WebSearchService(new SearxngBackend("https://searx.test"), config())
		const blocks = await service.search(["a", "b"])

		expect(blocks[0].results.map((r) => r.url)).toEqual(["https://example.com/1", "https://example.com/2"])
		expect(blocks[1].results.map((r) => r.url)).toEqual(["https://example.com/3"])
	})

	it("caps each query at webSearchMaxResults", async () => {
		vi.stubGlobal("fetch", jsonFetch({ a: { results: [hit(1), hit(2), hit(3), hit(4)] } }))

		const service = new WebSearchService(
			new SearxngBackend("https://searx.test"),
			config({ webSearchMaxResults: 2 }),
		)
		const blocks = await service.search(["a"])

		expect(blocks[0].results).toHaveLength(2)
	})

	it("ignores queries beyond the 4-query cap", async () => {
		const fetchMock = jsonFetch({})
		vi.stubGlobal("fetch", fetchMock)

		const service = new WebSearchService(new SearxngBackend("https://searx.test"), config())
		const blocks = await service.search(["a", "b", "c", "d", "e"])

		expect(blocks).toHaveLength(WEB_TOOLS_DEFAULTS.MAX_QUERIES_PER_CALL)
		expect(fetchMock).toHaveBeenCalledTimes(WEB_TOOLS_DEFAULTS.MAX_QUERIES_PER_CALL)
	})

	it("throws corrective text when the reply is not JSON", async () => {
		vi.stubGlobal("fetch", async () => textResponse("<html>not json at all</html>"))

		const service = new WebSearchService(new SearxngBackend("https://searx.test"), config())

		await expect(service.search(["a"])).rejects.toThrow(/non-JSON reply/)
	})

	it("rejects a JSON body over the size cap declared in content-length", async () => {
		vi.stubGlobal("fetch", async () => textResponse('{"results":[]}', { contentLength: String(3 * 1024 * 1024) }))

		const service = new WebSearchService(new SearxngBackend("https://searx.test"), config())

		await expect(service.search(["a"])).rejects.toThrow(/over the 2097152 byte limit/)
	})

	it("rejects a JSON body that streams past the size cap", async () => {
		// No content-length header, so only the streaming guard can catch it.
		vi.stubGlobal("fetch", async () => textResponse(`{"results":[],"pad":"${"x".repeat(3 * 1024 * 1024)}"}`))

		const service = new WebSearchService(new SearxngBackend("https://searx.test"), config())

		await expect(service.search(["a"])).rejects.toThrow(/more than 2097152 bytes/)
	})

	it("throws corrective text on a non-2xx reply", async () => {
		vi.stubGlobal("fetch", async () => textResponse("", { status: 503 }))

		const service = new WebSearchService(new SearxngBackend("https://searx.test"), config())

		await expect(service.search(["a"])).rejects.toThrow(
			"web_search backend returned HTTP 503 at https://searx.test; tell the user or continue without web data",
		)
	})

	it("throws corrective text when the request times out", async () => {
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			const error = new Error("The operation was aborted")
			error.name = "AbortError"
			void init
			throw error
		})

		const service = new WebSearchService(new SearxngBackend("https://searx.test"), config())

		await expect(service.search(["a"])).rejects.toThrow(/timed out after 10 s at https:\/\/searx.test/)
	})

	it("reports a single failing query inside its own block when others succeed", async () => {
		vi.stubGlobal("fetch", async (input: string) => {
			const query = decodeURIComponent(new URL(input).searchParams.get("q") ?? "")
			if (query === "bad") {
				return textResponse("", { status: 500 })
			}
			return textResponse(JSON.stringify({ results: [hit(1)] }))
		})

		const service = new WebSearchService(new SearxngBackend("https://searx.test"), config())
		const blocks = await service.search(["good", "bad"])

		expect(blocks[0].results).toHaveLength(1)
		expect(blocks[1].error).toMatch(/HTTP 500/)
	})

	it("rejects an all-blank query list", async () => {
		const service = new WebSearchService(new SearxngBackend("https://searx.test"), config())

		await expect(service.search(["  ", ""])).rejects.toThrow(/at least one non-empty query/)
	})
})

describe("formatSearchResults", () => {
	it("renders title, url and snippet per result under a per-query header", () => {
		const output = formatSearchResults([
			{
				query: "zod",
				results: [{ title: "Zod docs", url: "https://zod.dev", snippet: "TypeScript schemas" }],
			},
		])

		expect(output).toBe('Search results for "zod":\n\nZod docs\nhttps://zod.dev\nTypeScript schemas')
	})

	it("caps the total result text and explains the cut", () => {
		const output = formatSearchResults([
			{
				query: "big",
				results: [
					{ title: "T", url: "https://example.com/1", snippet: "s".repeat(40 * 1024) },
					{ title: "T2", url: "https://example.com/2", snippet: "s".repeat(40 * 1024) },
				],
			},
		])

		expect(Buffer.byteLength(output, "utf8")).toBeLessThan(MAX_SEARCH_RESULT_TEXT_BYTES + 300)
		expect(output).toContain(`over the ${MAX_SEARCH_RESULT_TEXT_BYTES} byte limit`)
		expect(output).toContain("Narrow the queries or use web_fetch")
	})

	it("leaves normal-sized result text untouched", () => {
		const output = formatSearchResults([
			{ query: "small", results: [{ title: "T", url: "https://example.com/1", snippet: "short" }] },
		])

		expect(output).not.toContain("[Truncated")
	})

	it("renders an explicit no-results line and per-query errors", () => {
		const output = formatSearchResults([
			{ query: "a", results: [] },
			{ query: "b", results: [], error: "boom" },
		])

		expect(output).toContain('Search results for "a":\nNo results.')
		expect(output).toContain('Search results for "b":\nboom')
	})
})
