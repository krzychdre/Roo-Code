import TurndownService from "turndown"

import { WEB_TOOLS_DEFAULTS, type ResolvedWebToolsConfig } from "@roo-code/types"

import { assertPublicHttpUrl } from "./addressGuard"

/**
 * Raised when the fetch cannot produce readable text (bad URL, blocked target,
 * unreachable host, non-2xx, binary payload). The message is already phrased as
 * corrective text for the model, so callers push it as a tool error verbatim.
 */
export class WebFetchError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "WebFetchError"
	}
}

/** Result of a successful fetch. */
export interface WebFetchResult {
	/** Final URL after redirects. */
	url: string
	/** Converted markdown, already capped at the configured byte budget. */
	markdown: string
	/** Whether anything was cut: either the body read or the markdown, or both. */
	truncated: boolean
	/** Size of the converted markdown before truncation, in bytes. */
	totalBytes: number
}

/** Maximum redirect hops followed manually before giving up. */
const MAX_REDIRECT_HOPS = 5

/** HTTP status codes that carry a `Location` header. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Content types that can be turned into readable text. Anything else (PDF,
 * images, archives, octet-stream) is rejected with a clear error rather than
 * dumped into the conversation as mojibake.
 */
const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "application/xhtml"]

const isHtmlContentType = (contentType: string): boolean =>
	HTML_CONTENT_TYPES.some((type) => contentType.startsWith(type))

const isTextContentType = (contentType: string): boolean =>
	contentType.startsWith("text/") ||
	contentType.startsWith("application/json") ||
	contentType.startsWith("application/xml")

/**
 * Cheap sniff for a response that arrived without a `content-type` header.
 * A leading `<!doctype html`, `<html` or `<?xml` means markup; anything with
 * NUL bytes in the first kilobyte is binary and gets rejected like a declared
 * binary type would be.
 */
export function sniffBodyKind(body: string): "html" | "text" | "binary" {
	const head = body.slice(0, 1024)

	if (head.includes("\u0000") || head.includes("\uFFFD")) {
		return "binary"
	}

	if (/^\s*(<!doctype\s+html|<html[\s>]|<\?xml[\s?]|<svg[\s>])/i.test(head)) {
		return "html"
	}

	// A document that opens with any tag at all is close enough to markup that
	// running it through turndown is safer than dumping raw angle brackets.
	return /^\s*</.test(head) ? "html" : "text"
}

/**
 * Shared HTML-to-markdown converter. `turndown` is already a dependency of the
 * extension (it backed the removed @url mention path), so no new dependency is
 * introduced. One instance is enough: turndown is stateless per `turndown()`
 * call.
 */
const STRIPPED_TAGS = new Set(["script", "style", "noscript", "iframe", "svg", "form", "nav", "footer"])

let turndown: TurndownService | undefined

function getTurndown(): TurndownService {
	if (!turndown) {
		turndown = new TurndownService({
			headingStyle: "atx",
			codeBlockStyle: "fenced",
			bulletListMarker: "-",
		})
		// Chrome, styling and page furniture carry no information for the model
		// and cost a lot of tokens. A function filter is used because turndown's
		// tag-name filter type only covers HTML tags, and `svg` is not one.
		turndown.remove((node) => STRIPPED_TAGS.has(node.nodeName.toLowerCase()))
	}
	return turndown
}

/**
 * Converts an HTML document to markdown, collapsing the runs of blank lines
 * that page markup usually produces.
 */
export function htmlToMarkdown(html: string): string {
	const markdown = getTurndown().turndown(html)
	return markdown.replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * Truncates text to a byte budget on a UTF-8 boundary and appends a notice so
 * the model knows the tail is missing rather than absent.
 *
 * `forceNotice` marks output that fits the budget but is still incomplete
 * because the body read stopped early. Without it a 900 KB page whose visible
 * text happens to compress to 3 KB of markdown would look complete.
 */
export function truncateToBytes(
	text: string,
	maxBytes: number,
	forceNotice = false,
): { text: string; truncated: boolean; bytes: number } {
	const buffer = Buffer.from(text, "utf8")

	if (buffer.byteLength <= maxBytes) {
		if (!forceNotice) {
			return { text, truncated: false, bytes: buffer.byteLength }
		}

		const notice = `\n\n[Truncated: the page was larger than web_fetch reads, so this is only the beginning of it. Fetch a more specific URL if you need the rest.]`
		return { text: `${text}${notice}`, truncated: true, bytes: buffer.byteLength }
	}

	// `toString` on a slice that ends mid-codepoint yields a replacement
	// character; dropping the trailing partial sequence avoids that.
	const sliced = buffer.subarray(0, maxBytes).toString("utf8").replace(/�$/, "")

	const notice = `\n\n[Truncated: showing the first ${maxBytes} of ${buffer.byteLength} bytes. Fetch a more specific URL if you need the rest.]`

	return { text: `${sliced}${notice}`, truncated: true, bytes: buffer.byteLength }
}

/** What `readBody` managed to read, and whether it gave up early. */
interface BodyReadResult {
	text: string
	/** True when the read budget was hit before the server said "done". */
	stoppedEarly: boolean
}

/**
 * Fetches a single URL and converts it to markdown.
 *
 * Guards, in order: URL must be absolute http(s) pointing at a public address;
 * every redirect hop is re-validated; one abort signal covers the request AND
 * the body read, so a slow-drip server cannot hang the tool; the content type
 * must be text-like (sniffed when the header is missing); the body read stops
 * at twice the markdown budget; the markdown is capped at the configured
 * budget with a truncation notice.
 */
export class WebFetchService {
	constructor(private readonly config: ResolvedWebToolsConfig) {}

	async fetch(rawUrl: string): Promise<WebFetchResult> {
		const url = this.parseUrl(rawUrl)

		// ONE controller and ONE timer for the whole operation. The timer is
		// cleared only after the body has been read, so a server that sends
		// headers instantly and then drips the body still hits the deadline.
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), WEB_TOOLS_DEFAULTS.REQUEST_TIMEOUT_MS)

		try {
			const { response, finalUrl } = await this.requestFollowingRedirects(url, controller.signal)

			if (!response.ok) {
				throw new WebFetchError(
					`web_fetch got HTTP ${response.status} for ${finalUrl}; check the URL or continue without the page contents`,
				)
			}

			const contentType = (response.headers.get("content-type") ?? "").toLowerCase().split(";")[0].trim()

			if (contentType && !isHtmlContentType(contentType) && !isTextContentType(contentType)) {
				throw new WebFetchError(
					`web_fetch cannot read "${contentType}" content at ${finalUrl}: only HTML and text responses are supported. Find an HTML version of this resource or continue without it.`,
				)
			}

			const { text: body, stoppedEarly } = await this.readBody(response, finalUrl)

			// A missing content-type is not a free pass: sniff the payload and
			// reject it exactly like a declared binary type would be.
			let treatAsHtml = isHtmlContentType(contentType)

			if (!contentType) {
				const kind = sniffBodyKind(body)
				if (kind === "binary") {
					throw new WebFetchError(
						`web_fetch got binary data with no content-type at ${finalUrl}: only HTML and text responses are supported. Find an HTML version of this resource or continue without it.`,
					)
				}
				treatAsHtml = kind === "html"
			}

			const markdown = treatAsHtml ? htmlToMarkdown(body) : body.trim()

			const { text, truncated, bytes } = truncateToBytes(markdown, this.config.maxFetchBytes, stoppedEarly)

			return { url: finalUrl, markdown: text, truncated, totalBytes: bytes }
		} catch (error) {
			throw this.asToolError(error, url)
		} finally {
			clearTimeout(timer)
		}
	}

	/**
	 * Normalizes anything thrown during the fetch into a `WebFetchError` whose
	 * message is corrective text. Aborts become the timeout message regardless
	 * of whether they happened during the request or the body read.
	 */
	private asToolError(error: unknown, url: string): WebFetchError {
		if (error instanceof WebFetchError) {
			return error
		}

		const isTimeout = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")

		const reason = isTimeout
			? `timed out after ${WEB_TOOLS_DEFAULTS.REQUEST_TIMEOUT_MS / 1000} s`
			: `failed (${error instanceof Error ? error.message : String(error)})`

		return new WebFetchError(`web_fetch ${reason} for ${url}; tell the user or continue without the page contents`)
	}

	/** Validates and normalizes the model-supplied URL. */
	private parseUrl(rawUrl: string): string {
		const trimmed = rawUrl.trim()

		let parsed: URL
		try {
			parsed = new URL(trimmed)
		} catch {
			throw new WebFetchError(
				`web_fetch needs an absolute http(s) URL; "${trimmed}" is not one. Retry with a full URL such as https://example.com/page.`,
			)
		}

		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new WebFetchError(
				`web_fetch only supports http and https; "${trimmed}" uses "${parsed.protocol}". Retry with an http(s) URL.`,
			)
		}

		this.assertAllowedTarget(parsed)

		return parsed.toString()
	}

	/**
	 * Rejects targets on the local machine or a private network. Rethrows the
	 * guard's reason as a `WebFetchError` so the model gets corrective text.
	 */
	private assertAllowedTarget(parsed: URL): void {
		const blocked = assertPublicHttpUrl(parsed)

		if (blocked) {
			throw new WebFetchError(
				`web_fetch refused "${parsed.toString()}": ${blocked}. web_fetch only reaches public internet addresses. Ask the user to fetch this themselves, or continue without it.`,
			)
		}
	}

	/**
	 * Performs the request with `redirect: "manual"` so every hop is visible
	 * and can be re-validated. Following redirects inside `fetch` would let a
	 * public URL bounce to `169.254.169.254` without the guard ever seeing it.
	 */
	private async requestFollowingRedirects(
		startUrl: string,
		signal: AbortSignal,
	): Promise<{ response: Response; finalUrl: string }> {
		let currentUrl = startUrl

		for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
			const response = await fetch(currentUrl, {
				signal,
				redirect: "manual",
				headers: {
					Accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5",
				},
			})

			const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null

			if (!location) {
				// `response.url` is empty under `redirect: "manual"` in some
				// runtimes, so the URL we actually requested is the truth.
				return { response, finalUrl: currentUrl }
			}

			let next: URL
			try {
				next = new URL(location, currentUrl)
			} catch {
				throw new WebFetchError(
					`web_fetch got an unusable redirect target "${location}" from ${currentUrl}; check the URL or continue without the page contents`,
				)
			}

			if (next.protocol !== "http:" && next.protocol !== "https:") {
				throw new WebFetchError(
					`web_fetch refused a redirect from ${currentUrl} to "${next.toString()}": only http and https are supported. Continue without the page contents.`,
				)
			}

			this.assertAllowedTarget(next)

			currentUrl = next.toString()
		}

		throw new WebFetchError(
			`web_fetch gave up after ${MAX_REDIRECT_HOPS} redirects starting at ${startUrl}; the URL probably loops. Try a direct link or continue without it.`,
		)
	}

	/**
	 * Reads the response body, stopping once the raw bytes exceed the read
	 * budget and reporting whether it stopped early. Falls back to
	 * `response.text()` when the body is not a readable stream (some fetch
	 * mocks and polyfills).
	 */
	private async readBody(response: Response, url: string): Promise<BodyReadResult> {
		const readBudget = this.config.maxFetchBytes * 2
		const declaredLength = Number(response.headers.get("content-length") ?? "")

		if (Number.isFinite(declaredLength) && declaredLength > readBudget * 4) {
			throw new WebFetchError(
				`web_fetch refused ${url}: the page is ${declaredLength} bytes, far beyond the ${this.config.maxFetchBytes} byte budget. Fetch a more specific URL or continue without it.`,
			)
		}

		const body = response.body

		if (!body || typeof body.getReader !== "function") {
			const text = await response.text()
			const buffer = Buffer.from(text, "utf8")

			if (buffer.byteLength <= readBudget) {
				return { text, stoppedEarly: false }
			}

			return {
				text: buffer.subarray(0, readBudget).toString("utf8").replace(/�$/, ""),
				stoppedEarly: true,
			}
		}

		const reader = body.getReader()
		const chunks: Uint8Array[] = []
		let received = 0
		let stoppedEarly = false

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

				if (received >= readBudget) {
					// The server still had more to send; record that so the
					// caller can add a truncation notice even if the converted
					// markdown ends up smaller than the budget.
					stoppedEarly = true
					break
				}
			}
		} finally {
			// Best-effort: an already-closed reader throws on cancel.
			try {
				await reader.cancel()
			} catch {
				// Ignore - the body is discarded either way.
			}
		}

		return {
			text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
			stoppedEarly,
		}
	}
}
