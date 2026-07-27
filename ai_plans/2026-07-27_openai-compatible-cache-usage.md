# OpenAI-Compatible provider never reports prefix-cache hits

Date: 2026-07-27
Branch: `fix/openai-compatible-cache-usage` (off `main` @ `45b252b01`)
Related: `ai_plans/2026-07-27_verbosity-and-turn-economics.md` §2.3, RC-1, WS-8

## Trigger

The verbosity analysis measured a **0.3% cache hit rate** for the GLM-5.2 profile and treated it
as a fact about the endpoint. That premise was wrong in two ways:

1. The user does not run GLM through a hosted vendor at all — glm-5.2 runs on their **own vLLM**
   server, reached through an **OpenAI-Compatible** profile.
2. That profile is served by `OpenAiHandler` (`src/api/providers/openai.ts`), which is a
   _different_ code path from `BaseOpenAiCompatibleProvider` — and it never parsed the field that
   OpenAI-compatible servers use to report cached prompt tokens.

## Root cause (verified in code, offline)

`src/api/providers/openai.ts`, `processUsageMetrics`, before the fix:

```ts
cacheWriteTokens: usage?.cache_creation_input_tokens || undefined,
cacheReadTokens: usage?.cache_read_input_tokens || undefined,
```

Those two names are **Anthropic's** convention. The OpenAI standard — which vLLM, SGLang, LiteLLM
and OpenAI itself follow — nests them:

```json
"usage": { "prompt_tokens": 95000, "prompt_tokens_details": { "cached_tokens": 90000 } }
```

`base-openai-compatible-provider.ts:216-219` already reads the standard shape; `openai.ts` did
not. `deepseek.ts:183` overrides the method with its own variant, so it was never affected.

**Consequence.** On any OpenAI-Compatible profile — which is exactly what a self-hosted vLLM
endpoint is — `cacheReadTokens` is structurally always `undefined`. It reaches
`TaskStreamProcessor.ts:760-789` as 0, is persisted as `cacheReads: 0`, and is what the analysis
aggregated. **A 0.3% measured hit rate on that profile therefore cannot distinguish "the server
never cached" from "the client never looked".** Every conclusion in §2.3 that rests on that
number is unsafe until re-measured.

This does not retract RC-1: the microcompaction oscillation is proven independently, from the
alternating `tokensIn` sequence, and it would defeat prefix caching even on a perfectly
instrumented client. It does mean RC-1 was credited with a number it may not own.

## Fix

Read the OpenAI-standard fields first, fall back to the Anthropic-style ones:

```ts
const cacheWriteTokens = usage?.prompt_tokens_details?.cache_write_tokens || usage?.cache_creation_input_tokens
const cacheReadTokens = usage?.prompt_tokens_details?.cached_tokens || usage?.cache_read_input_tokens
```

No double-counting: both conventions report cached tokens **inside** `prompt_tokens`, and
`calculateApiCostOpenAI` (`src/shared/cost.ts:92-116`) is written for exactly that inclusive
convention (`nonCached = max(0, input − cacheCreation − cacheRead)`). `getApiProtocol` routes the
`openai` provider to that function, so surfacing the value makes cost _more_ accurate, not less.

Also added the `ROO_LOG_RAW_USAGE=1` raw-usage dump that `base-openai-compatible-provider.ts`
already has, so the endpoint's actual usage object can be inspected without a debugger.

## Tests

`src/api/providers/__tests__/openai-cache-usage.spec.ts` — 7 tests: standard shape, cache writes,
Anthropic-style fallback, precedence when both are present, absent-caching stays `undefined`, and
the raw-usage dump on/off. Existing `openai-usage-tracking.spec.ts` and `deepseek.spec.ts` stay
green; `tsc --noEmit -p src` clean.

## How to verify on the real server (when it is back)

```bash
ROO_LOG_RAW_USAGE=1 code --extensionDevelopmentPath=...   # or read the extension host log
```

Run any second turn of a task and look for `[openai-compatible] raw usage:`.

- `prompt_tokens_details.cached_tokens > 0` → vLLM prefix caching works and the client now sees
  it; the §2.3 number was a client-side artefact.
- field absent → the server does not report it. Then cross-check vLLM's own
  `/metrics` (`vllm:prefix_cache_hits_total` / `vllm:prefix_cache_queries_total`), which is
  authoritative regardless of what the response body says, and confirm the server was **not**
  started with `--no-enable-prefix-caching`.

Either way this is now answerable in one request instead of being unknowable.
