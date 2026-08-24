import { z } from "zod"

/**
 * Web Tools Constants
 *
 * Bounds and defaults for the native `web_search` / `web_fetch` tools. The
 * backend is a seam (currently only SearXNG), so these knobs describe the
 * tools' behavior rather than any one provider.
 */
export const WEB_TOOLS_DEFAULTS = {
	/** Results kept per query after dedup. */
	MIN_SEARCH_RESULTS: 1,
	MAX_SEARCH_RESULTS: 20,
	DEFAULT_SEARCH_RESULTS: 5,
	/** Bytes of converted markdown `web_fetch` returns before truncating. */
	MIN_FETCH_BYTES: 4096,
	MAX_FETCH_BYTES: 512 * 1024,
	DEFAULT_FETCH_BYTES: 50 * 1024,
	/** Per-request HTTP timeout for both tools. */
	REQUEST_TIMEOUT_MS: 10_000,
	/** Upper bound on how many queries a single `web_search` call may carry. */
	MAX_QUERIES_PER_CALL: 4,
} as const

/**
 * WebSearchBackend
 *
 * Only SearXNG is implemented. The enum exists so a Tavily/Brave/Google CSE
 * backend can be added later without changing the tool schemas.
 */
export const webSearchBackends = ["searxng"] as const

export const webSearchBackendSchema = z.enum(webSearchBackends)

export type WebSearchBackend = z.infer<typeof webSearchBackendSchema>

/**
 * WebToolsSettings
 *
 * Global (not per-profile) settings merged into `globalSettingsSchema`.
 * `webToolsEnabled` is the master switch: when off, the `web` tool group
 * resolves to no tools at all, so the prompt and the tools array are byte
 * identical to a build without this feature.
 */
export const webToolsSettingsSchema = z.object({
	/**
	 * Master switch for the native `web_search` / `web_fetch` tools.
	 * @default false
	 */
	webToolsEnabled: z.boolean().optional(),
	/**
	 * Which search backend serves `web_search`.
	 * @default "searxng"
	 */
	webSearchBackend: webSearchBackendSchema.optional(),
	/**
	 * Base URL of the SearXNG instance, e.g. `https://searx.example.org`.
	 * Ships empty: the instance is machine-specific and must be configured.
	 */
	searxngBaseUrl: z.string().optional(),
	/**
	 * Maximum results returned per query.
	 * @default 5
	 */
	webSearchMaxResults: z
		.number()
		.min(WEB_TOOLS_DEFAULTS.MIN_SEARCH_RESULTS)
		.max(WEB_TOOLS_DEFAULTS.MAX_SEARCH_RESULTS)
		.optional(),
	/**
	 * Maximum bytes of markdown `web_fetch` returns before truncating.
	 * @default 51200
	 */
	webFetchMaxBytes: z
		.number()
		.min(WEB_TOOLS_DEFAULTS.MIN_FETCH_BYTES)
		.max(WEB_TOOLS_DEFAULTS.MAX_FETCH_BYTES)
		.optional(),
})

export type WebToolsSettings = z.infer<typeof webToolsSettingsSchema>

/**
 * Runtime view of the web-tool settings with every default resolved, so the
 * services never repeat the `?? DEFAULT` dance.
 */
export interface ResolvedWebToolsConfig {
	enabled: boolean
	backend: WebSearchBackend
	searxngBaseUrl: string
	maxResults: number
	maxFetchBytes: number
}

/**
 * Resolves raw settings into a config with defaults applied.
 */
export const resolveWebToolsConfig = (settings: WebToolsSettings | undefined): ResolvedWebToolsConfig => ({
	enabled: settings?.webToolsEnabled === true,
	backend: settings?.webSearchBackend ?? "searxng",
	searxngBaseUrl: (settings?.searxngBaseUrl ?? "").trim(),
	maxResults: settings?.webSearchMaxResults ?? WEB_TOOLS_DEFAULTS.DEFAULT_SEARCH_RESULTS,
	maxFetchBytes: settings?.webFetchMaxBytes ?? WEB_TOOLS_DEFAULTS.DEFAULT_FETCH_BYTES,
})
