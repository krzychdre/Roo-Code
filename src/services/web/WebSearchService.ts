import { WEB_TOOLS_DEFAULTS, type ResolvedWebToolsConfig } from "@roo-code/types"

/**
 * A single search hit, normalized across backends.
 */
export interface WebSearchResult {
	title: string
	url: string
	snippet: string
}

/**
 * Results for one of the queries in a `web_search` call.
 */
export interface WebSearchQueryBlock {
	query: string
	results: WebSearchResult[]
	/** Set when this query alone failed; the other queries still return results. */
	error?: string
}

/**
 * Raised when the whole search is unusable (no backend URL, backend
 * unreachable, non-2xx, invalid JSON). The message is already phrased as
 * corrective text for the model, so callers push it as a tool error verbatim.
 */
export class WebSearchError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "WebSearchError"
	}
}

/**
 * The subset of the search backend the service depends on. Keeping it as an
 * interface is the seam the plan asks for: a Tavily/Brave/Google CSE backend
 * drops in here without touching the tool schema or the tool class.
 */
export interface WebSearchBackendClient {
	/** Human-readable endpoint, used in error text so the user can fix the config. */
	readonly endpoint: string
	search(query: string, maxResults: number, signal: AbortSignal): Promise<WebSearchResult[]>
}

/**
 * Hard cap on the JSON body accepted from the search backend. SearXNG replies
 * for a single query are a few dozen kilobytes; anything near 2 MB means a
 * misconfigured or hostile endpoint.
 */
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024

/**
 * Hard cap on the formatted text `web_search` hands back to the model. The
 * per-query result cap already bounds the usual case; this protects against a
 * backend returning a handful of enormous snippets.
 */
export const MAX_SEARCH_RESULT_TEXT_BYTES = 30 * 1024

/** Shape of the entries SearXNG returns in its JSON API. */
interface SearxngResult {
	title?: unknown
	url?: unknown
	content?: unknown
}

const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

/**
 * Normalizes a URL for dedup purposes. Trailing slashes and fragments are the
 * common way the same page shows up twice across engines.
 */
function dedupKey(url: string): string {
	try {
		const parsed = new URL(url)
		parsed.hash = ""
		const normalizedPath = parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname
		return `${parsed.protocol}//${parsed.host}${normalizedPath}${parsed.search}`
	} catch {
		return url.trim().replace(/\/+$/, "")
	}
}

/**
 * SearXNG JSON API client: `GET <base>/search?q=<query>&format=json`.
 */
export class SearxngBackend implements WebSearchBackendClient {
	readonly endpoint: string

	constructor(baseUrl: string) {
		this.endpoint = baseUrl.replace(/\/+$/, "")
	}

	async search(query: string, maxResults: number, signal: AbortSignal): Promise<WebSearchResult[]> {
		const url = `${this.endpoint}/search?q=${encodeURIComponent(query)}&format=json`

		let response: Response
		try {
			response = await fetch(url, { signal, headers: { Accept: "application/json" } })
		} catch (error) {
			throw new WebSearchError(unreachableMessage(this.endpoint, error))
		}

		if (!response.ok) {
			throw new WebSearchError(
				`web_search backend returned HTTP ${response.status} at ${this.endpoint}; tell the user or continue without web data`,
			)
		}

		const rawBody = await this.readBoundedBody(response)

		let payload: unknown
		try {
			payload = JSON.parse(rawBody)
		} catch {
			throw new WebSearchError(
				`web_search backend at ${this.endpoint} returned a non-JSON reply; check that the SearXNG instance allows the JSON format, then tell the user or continue without web data`,
			)
		}

		const rawResults = (payload as { results?: unknown })?.results
		if (!Array.isArray(rawResults)) {
			throw new WebSearchError(
				`web_search backend at ${this.endpoint} returned an unexpected JSON shape (no "results" array); tell the user or continue without web data`,
			)
		}

		const results: WebSearchResult[] = []
		for (const entry of rawResults as SearxngResult[]) {
			const resultUrl = asText(entry?.url)
			if (!resultUrl) {
				continue
			}
			results.push({
				title: asText(entry?.title) || resultUrl,
				url: resultUrl,
				snippet: asText(entry?.content),
			})
			if (results.length >= maxResults) {
				break
			}
		}

		return results
	}

	/**
	 * Reads the JSON body with a hard byte cap. A misconfigured or hostile
	 * endpoint that streams megabytes would otherwise be parsed in full and
	 * blow up memory before any of the result caps apply.
	 */
	private async readBoundedBody(response: Response): Promise<string> {
		const declaredLength = Number(response.headers.get("content-length") ?? "")

		if (Number.isFinite(declaredLength) && declaredLength > MAX_SEARCH_RESPONSE_BYTES) {
			throw new WebSearchError(
				`web_search backend at ${this.endpoint} returned ${declaredLength} bytes, over the ${MAX_SEARCH_RESPONSE_BYTES} byte limit; ask the user to check the SearXNG configuration, or continue without web data`,
			)
		}

		const body = response.body

		if (!body || typeof body.getReader !== "function") {
			const text = await response.text()
			if (Buffer.byteLength(text, "utf8") > MAX_SEARCH_RESPONSE_BYTES) {
				throw new WebSearchError(
					`web_search backend at ${this.endpoint} returned more than ${MAX_SEARCH_RESPONSE_BYTES} bytes; ask the user to check the SearXNG configuration, or continue without web data`,
				)
			}
			return text
		}

		const reader = body.getReader()
		const chunks: Uint8Array[] = []
		let received = 0

		try {
			for (;;) {
				const { done, value } = await reader.read()

				if (done) {
					break
				}

				if (value) {
					chunks.push(value)
					received += value.byteLength
				}

				if (received > MAX_SEARCH_RESPONSE_BYTES) {
					// Truncated JSON cannot be parsed, so this is a hard error
					// rather than a partial result.
					throw new WebSearchError(
						`web_search backend at ${this.endpoint} returned more than ${MAX_SEARCH_RESPONSE_BYTES} bytes; ask the user to check the SearXNG configuration, or continue without web data`,
					)
				}
			}
		} finally {
			try {
				await reader.cancel()
			} catch {
				// Ignore - the body is discarded either way.
			}
		}

		return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
	}
}

/** Builds the corrective text used for every transport-level failure. */
function unreachableMessage(endpoint: string, error: unknown): string {
	const isTimeout = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
	const reason = isTimeout
		? `timed out after ${WEB_TOOLS_DEFAULTS.REQUEST_TIMEOUT_MS / 1000} s`
		: `unreachable (${error instanceof Error ? error.message : String(error)})`
	return `web_search backend ${reason} at ${endpoint}; tell the user or continue without web data`
}

/**
 * Creates the backend client for the resolved config, or throws a
 * `WebSearchError` carrying corrective text when it cannot be built.
 */
export function createSearchBackend(config: ResolvedWebToolsConfig): WebSearchBackendClient {
	if (!config.searxngBaseUrl) {
		throw new WebSearchError(
			"web_search has no backend URL configured; ask the user to set the SearXNG base URL in Settings > Web tools, or continue without web data",
		)
	}
	if (!/^https?:\/\//i.test(config.searxngBaseUrl)) {
		throw new WebSearchError(
			`web_search backend URL "${config.searxngBaseUrl}" is not an http(s) URL; ask the user to fix it in Settings > Web tools, or continue without web data`,
		)
	}
	return new SearxngBackend(config.searxngBaseUrl)
}

/**
 * Runs 1-4 queries against the configured backend, dedups by URL across the
 * whole call, caps each query's block at `maxResults`, and formats the output.
 *
 * A query that fails on its own is reported inside its block; the call only
 * throws when the backend itself is unusable for every query.
 */
export class WebSearchService {
	constructor(
		private readonly backend: WebSearchBackendClient,
		private readonly config: ResolvedWebToolsConfig,
	) {}

	/**
	 * Executes the queries and returns one block per query, in call order.
	 *
	 * @throws WebSearchError when every query failed for the same backend-level reason.
	 */
	async search(queries: string[]): Promise<WebSearchQueryBlock[]> {
		const trimmed = queries.map((query) => query.trim()).filter((query) => query.length > 0)

		if (trimmed.length === 0) {
			throw new WebSearchError("web_search needs at least one non-empty query; retry with a query string")
		}

		const effectiveQueries = trimmed.slice(0, WEB_TOOLS_DEFAULTS.MAX_QUERIES_PER_CALL)

		const blocks = await Promise.all(
			effectiveQueries.map(async (query): Promise<WebSearchQueryBlock> => {
				try {
					const results = await this.runOne(query)
					return { query, results }
				} catch (error) {
					return {
						query,
						results: [],
						error: error instanceof WebSearchError ? error.message : String(error),
					}
				}
			}),
		)

		// Every query failed the same way: that is a backend problem, not a
		// query problem, so surface it as one tool error instead of N blocks.
		const firstError = blocks[0]?.error
		if (firstError && blocks.every((block) => block.error === firstError)) {
			throw new WebSearchError(firstError)
		}

		// Dedup across queries: a URL is kept in the first block that mentions
		// it, so the model does not fetch the same page twice.
		const seen = new Set<string>()
		for (const block of blocks) {
			const kept: WebSearchResult[] = []
			for (const result of block.results) {
				const key = dedupKey(result.url)
				if (seen.has(key)) {
					continue
				}
				seen.add(key)
				kept.push(result)
			}
			block.results = kept
		}

		return blocks
	}

	/** Runs one query with the shared per-request timeout. */
	private async runOne(query: string): Promise<WebSearchResult[]> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), WEB_TOOLS_DEFAULTS.REQUEST_TIMEOUT_MS)

		try {
			return await this.backend.search(query, this.config.maxResults, controller.signal)
		} catch (error) {
			if (error instanceof WebSearchError) {
				throw error
			}
			throw new WebSearchError(unreachableMessage(this.backend.endpoint, error))
		} finally {
			clearTimeout(timer)
		}
	}
}

/**
 * Renders search blocks as the plain text the model reads: one section per
 * query, each result a `title / url / snippet` triple.
 *
 * The output is capped at {@link MAX_SEARCH_RESULT_TEXT_BYTES}: the per-query
 * result cap bounds the count, but not the size of any one snippet, so a
 * backend returning very long snippets could otherwise flood the context.
 */
export function formatSearchResults(blocks: WebSearchQueryBlock[]): string {
	const text = blocks
		.map((block) => {
			const header = `Search results for "${block.query}":`

			if (block.error) {
				return `${header}\n${block.error}`
			}

			if (block.results.length === 0) {
				return `${header}\nNo results.`
			}

			const body = block.results
				.map((result) => [result.title, result.url, result.snippet].filter(Boolean).join("\n"))
				.join("\n\n")

			return `${header}\n\n${body}`
		})
		.join("\n\n---\n\n")

	const buffer = Buffer.from(text, "utf8")

	if (buffer.byteLength <= MAX_SEARCH_RESULT_TEXT_BYTES) {
		return text
	}

	// `toString` on a slice that ends mid-codepoint yields a replacement
	// character; dropping the trailing partial sequence avoids that.
	const sliced = buffer.subarray(0, MAX_SEARCH_RESULT_TEXT_BYTES).toString("utf8").replace(/�$/, "")

	return `${sliced}\n\n[Truncated: the results were ${buffer.byteLength} bytes, over the ${MAX_SEARCH_RESULT_TEXT_BYTES} byte limit. Narrow the queries or use web_fetch on one of the URLs above.]`
}
