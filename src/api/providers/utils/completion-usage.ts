import type { CompletionUsage } from "../../index"

/**
 * Read a provider's usage block into the shared {@link CompletionUsage}.
 *
 * One-shot completions (`completePromptWithUsage`) go through here so that every
 * provider reports the same shape, and so the "the provider said nothing" case
 * is decided in one place: an absent or empty usage block returns `undefined`
 * rather than a row of zeros, because a zero would land in a usage total as if
 * the call had been free.
 */

type OpenAiShapedUsage =
	| {
			prompt_tokens?: number | null
			completion_tokens?: number | null
			total_tokens?: number | null
			prompt_tokens_details?: {
				cached_tokens?: number | null
				cache_creation_tokens?: number | null
			} | null
			cache_creation_input_tokens?: number | null
			cache_read_input_tokens?: number | null
			cost?: number | null
	  }
	| null
	| undefined

const numberOrUndefined = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined

/**
 * Map an OpenAI-shaped `usage` block (`prompt_tokens` / `completion_tokens`).
 *
 * Per the OpenAI protocol `prompt_tokens` already includes any cached prefix,
 * so `cacheReadTokens` is reported alongside it as a subset, exactly as the
 * streaming path does — see `calculateApiCostOpenAI`.
 */
export function openAiCompletionUsage(usage: OpenAiShapedUsage): CompletionUsage | undefined {
	if (!usage) {
		return undefined
	}

	const inputTokens = numberOrUndefined(usage.prompt_tokens)
	const outputTokens = numberOrUndefined(usage.completion_tokens)

	if (inputTokens === undefined && outputTokens === undefined) {
		return undefined
	}

	const cacheReadTokens =
		numberOrUndefined(usage.prompt_tokens_details?.cached_tokens) ??
		numberOrUndefined(usage.cache_read_input_tokens)
	const cacheWriteTokens =
		numberOrUndefined(usage.prompt_tokens_details?.cache_creation_tokens) ??
		numberOrUndefined(usage.cache_creation_input_tokens)

	return {
		inputTokens: inputTokens ?? 0,
		outputTokens: outputTokens ?? 0,
		...(cacheReadTokens !== undefined && { cacheReadTokens }),
		...(cacheWriteTokens !== undefined && { cacheWriteTokens }),
		...(numberOrUndefined(usage.cost) !== undefined && { totalCost: usage.cost as number }),
	}
}

type AnthropicShapedUsage =
	| {
			input_tokens?: number | null
			output_tokens?: number | null
			cache_creation_input_tokens?: number | null
			cache_read_input_tokens?: number | null
	  }
	| null
	| undefined

/**
 * Map an Anthropic-shaped `usage` block.
 *
 * Here `input_tokens` excludes the cached portions, which is why the cache
 * figures are reported separately and summed by `calculateApiCostAnthropic`
 * rather than treated as a subset.
 */
export function anthropicCompletionUsage(usage: AnthropicShapedUsage): CompletionUsage | undefined {
	if (!usage) {
		return undefined
	}

	const inputTokens = numberOrUndefined(usage.input_tokens)
	const outputTokens = numberOrUndefined(usage.output_tokens)

	if (inputTokens === undefined && outputTokens === undefined) {
		return undefined
	}

	const cacheWriteTokens = numberOrUndefined(usage.cache_creation_input_tokens)
	const cacheReadTokens = numberOrUndefined(usage.cache_read_input_tokens)

	return {
		inputTokens: inputTokens ?? 0,
		outputTokens: outputTokens ?? 0,
		...(cacheReadTokens !== undefined && { cacheReadTokens }),
		...(cacheWriteTokens !== undefined && { cacheWriteTokens }),
	}
}

/**
 * Map the Responses API's usage block, which names its fields
 * `input_tokens`/`output_tokens` rather than the Chat Completions
 * `prompt_tokens`/`completion_tokens`. As in the rest of the OpenAI protocol
 * the cached prefix is already inside `input_tokens`.
 */
export function responsesApiCompletionUsage(
	usage:
		| {
				input_tokens?: number | null
				output_tokens?: number | null
				input_tokens_details?: { cached_tokens?: number | null } | null
		  }
		| null
		| undefined,
): CompletionUsage | undefined {
	if (!usage) {
		return undefined
	}

	const inputTokens = numberOrUndefined(usage.input_tokens)
	const outputTokens = numberOrUndefined(usage.output_tokens)

	if (inputTokens === undefined && outputTokens === undefined) {
		return undefined
	}

	const cacheReadTokens = numberOrUndefined(usage.input_tokens_details?.cached_tokens)

	return {
		inputTokens: inputTokens ?? 0,
		outputTokens: outputTokens ?? 0,
		...(cacheReadTokens !== undefined && { cacheReadTokens }),
	}
}

/**
 * Map Gemini's `usageMetadata`, whose `promptTokenCount` includes the cached
 * portion (so the cache figure is a subset, as in the OpenAI protocol).
 */
export function geminiCompletionUsage(
	usage:
		| {
				promptTokenCount?: number | null
				candidatesTokenCount?: number | null
				cachedContentTokenCount?: number | null
		  }
		| null
		| undefined,
): CompletionUsage | undefined {
	if (!usage) {
		return undefined
	}

	const inputTokens = numberOrUndefined(usage.promptTokenCount)
	const outputTokens = numberOrUndefined(usage.candidatesTokenCount)

	if (inputTokens === undefined && outputTokens === undefined) {
		return undefined
	}

	const cacheReadTokens = numberOrUndefined(usage.cachedContentTokenCount)

	return {
		inputTokens: inputTokens ?? 0,
		outputTokens: outputTokens ?? 0,
		...(cacheReadTokens !== undefined && { cacheReadTokens }),
	}
}

/**
 * Map Ollama's native counters (`prompt_eval_count` / `eval_count`).
 */
export function ollamaCompletionUsage(
	usage: { prompt_eval_count?: number | null; eval_count?: number | null } | null | undefined,
): CompletionUsage | undefined {
	if (!usage) {
		return undefined
	}

	const inputTokens = numberOrUndefined(usage.prompt_eval_count)
	const outputTokens = numberOrUndefined(usage.eval_count)

	if (inputTokens === undefined && outputTokens === undefined) {
		return undefined
	}

	return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 }
}

/**
 * Map a `{ promptTokens, completionTokens }`-shaped usage block, as returned by
 * the Vercel AI SDK's `generateText`.
 */
export function aiSdkCompletionUsage(
	usage:
		| { promptTokens?: number; completionTokens?: number; inputTokens?: number; outputTokens?: number }
		| null
		| undefined,
): CompletionUsage | undefined {
	if (!usage) {
		return undefined
	}

	const inputTokens = numberOrUndefined(usage.promptTokens) ?? numberOrUndefined(usage.inputTokens)
	const outputTokens = numberOrUndefined(usage.completionTokens) ?? numberOrUndefined(usage.outputTokens)

	if (inputTokens === undefined && outputTokens === undefined) {
		return undefined
	}

	return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 }
}
