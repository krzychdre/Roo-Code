import type OpenAI from "openai"

/**
 * Native tool definition for web_search.
 *
 * Searches the web through the configured backend (SearXNG in v1) and returns
 * `title / url / snippet` blocks per query. Up to 4 queries run in one call so
 * a small model gets breadth in a single turn instead of four round trips.
 */

const WEB_SEARCH_DESCRIPTION = `Search the web and get result titles, URLs and snippets. Pass 1-4 related queries in one call to cover a topic in a single turn. Follow up with web_fetch on the URLs worth reading in full.

When unsure about an API, a version, or an error message, verify against current documentation with web_search / web_fetch before coding from memory.

Parameters:
- queries: (required) 1 to 4 search queries.

Example: One query
{ "queries": ["zod 4 migration guide"] }

Example: Several angles at once
{ "queries": ["vitest mock fetch", "vitest vi.stubGlobal fetch example"] }`

const QUERIES_PARAMETER_DESCRIPTION = `1 to 4 search queries. Keep each one short and specific.`

export default {
	type: "function",
	function: {
		name: "web_search",
		description: WEB_SEARCH_DESCRIPTION,
		// Note: strict mode is intentionally disabled, matching the other
		// tools with array parameters. Strict mode forces every property into
		// `required`, which produces verbose calls from weak models.
		parameters: {
			type: "object",
			properties: {
				queries: {
					type: "array",
					items: { type: "string" },
					minItems: 1,
					maxItems: 4,
					description: QUERIES_PARAMETER_DESCRIPTION,
				},
			},
			required: ["queries"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
