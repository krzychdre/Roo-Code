import type OpenAI from "openai"

/**
 * Native tool definition for web_fetch.
 *
 * Fetches one URL server-side, converts the HTML to readable markdown and
 * returns the text. Binary and non-text responses are rejected; oversized
 * pages are truncated with a notice.
 */

const WEB_FETCH_DESCRIPTION = `Fetch one web page and return it as readable markdown. Use it after web_search to read a promising result, or directly when you already have the URL.

Parameters:
- url: (required) Absolute http(s) URL.

Example:
{ "url": "https://example.com/docs/getting-started" }`

const URL_PARAMETER_DESCRIPTION = `Absolute http(s) URL of the page to read.`

export default {
	type: "function",
	function: {
		name: "web_fetch",
		description: WEB_FETCH_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: URL_PARAMETER_DESCRIPTION,
				},
			},
			required: ["url"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
