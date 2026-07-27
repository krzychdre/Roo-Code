# Fix: OpenAI Codex (ChatGPT subscription) models condense far too early

Date: 2026-07-27
Branch: `fix/codex-subscription-response-reserve`

## Symptom

On the ChatGPT-subscription provider (`openai-codex`), GPT-5.6 Sol and its siblings show a very
large "reserved for response" segment in the context bar, and auto-condensing kicks in after only
a small fraction of the 200k window has been used.

## Root cause (traced, not guessed)

1. `packages/types/src/providers/openai-codex.ts` declares the subscription models with
   `contextWindow: 200_000` **and** `maxTokens: 128_000`.

    - History: `fa61b7c47` introduced the GPT-5.6 catalog with `contextWindow: 1_050_000`;
      `6792f2a0b` ("Refactor/provider simplification") cut the window to `200_000` — the real
      subscription limit — but left `maxTokens` at `128_000`.

2. `getModelMaxOutputTokens` (`src/shared/api.ts:130-143`) clamps `maxTokens` to 20% of the
   context window **except** for model IDs containing `gpt-5`, which bypass the clamp on purpose
   (so the API providers can send their exact `max_output_tokens`). Every subscription model ID
   matches `gpt-5`, so the reserve stays at the full 128k.

3. The context manager computes the condense/truncate threshold as
   `allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens`
   (`src/core/context-management/index.ts:176,182,308`, `TOKEN_BUFFER_PERCENTAGE = 0.1`).

    For Sol: `200_000 * 0.9 - 128_000 = 52_000`. Condensing fires at ~52k of a 200k window (26%).

4. The reserve is pure bookkeeping here: `src/api/providers/openai-codex.ts:304` deliberately omits
   `max_output_tokens` from the request body because the Codex backend rejects it. So `maxTokens`
   in this catalog only ever feeds the context math and the "reserved" bar in
   `ContextWindowProgress`.

Native API models are unaffected: their windows are 400k–1.05M, so a 128k reserve still leaves
232k–817k of usable context.

## Fix

`packages/types/src/providers/openai-codex.ts`: introduce
`SUBSCRIPTION_200K_MAX_OUTPUT_TOKENS = 40_000` (exactly the 20%-of-window convention the clamp
applies to every non-GPT-5 model) and use it for `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`,
`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`. `gpt-5.3-codex-spark` (128k window / 8_192 reserve) was
already within budget and is unchanged.

Result: `allowedTokens = 180_000 - 40_000 = 140_000` — 70% of the window usable before condensing,
with 20k of slack above the buffer even if a response fully consumes its reserve.

A code comment records _why_ this must be maintained by hand (the GPT-5 clamp bypass).

## Guard

New `packages/types/src/__tests__/openai-codex.spec.ts` asserts, for every model in the catalog:

- `maxTokens <= ceil(contextWindow * 0.2)`
- `(contextWindow * 0.9 - maxTokens) / contextWindow >= 0.7`

This makes the exact regression introduced by `6792f2a0b` — editing a context window without
revisiting the reserve — a CI failure rather than a silent behavioral change.

## Verification

- `packages/types`: `openai-codex.spec.ts` — 2 passed.
- `src`: `api/providers/__tests__/openai-codex.spec.ts` — 10 passed (expectation updated from
  128_000 to 40_000).
- `src`: `shared/__tests__/api.spec.ts` + `api/transform/__tests__/model-params.spec.ts` — 93 passed
  (the GPT-5 clamp bypass is untouched).
