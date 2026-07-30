# Count every LLM call, not just the ones in the conversation

Date: 2026-07-30
Scope: `src/` + `packages/` (emission) and `self-hosted-cloudapi/` (display)
Branches, stacked in this order on `feat/cloud-web-model-attribution`:

1. `feat/telemetry-side-call-usage` — the extension emits what it spends off the main loop
2. `feat/cloud-web-side-call-metrics` — the console shows it, and stops mis-attributing because of it

---

## 1. The gap

The metrics page under-reports against the local inference server, and the
reason is not sampling or a lost day: **only the main task loop emits an
`LLM Completion` event.** Every other call the extension makes to the same
endpoint is invisible — it costs prompt-processing time on the server and
appears nowhere in the console.

Measured against the code, 2026-07-30:

| Call site                                                     | Emits today | Usage available there                                     |
| ------------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| Task loop (`TaskApiLoop.ts:1159` → drain)                     | yes         | full                                                      |
| Condense (`core/condense/index.ts:313`)                       | **no**      | full — `streamSummary` receives the `usage` chunk         |
| Enhance prompt (`webview/messageEnhancer.ts:80`)              | **no**      | discarded: `completePrompt` returns a bare `string`       |
| Memory side-query (`core/memory/memoryTaskIntegration.ts:43`) | **no**      | same                                                      |
| Code-index embeddings (`services/code-index/embedders/*`)     | **no**      | full — embedders already sum `promptTokens`/`totalTokens` |
| Microcompaction                                               | n/a         | deterministic, makes no LLM call                          |

One correction to an earlier reading: a **cancelled request does emit**, as long
as the provider reported usage before the cancel — the drain runs after the
abort break (`TaskApiLoop.ts:648`) and `captureUsageData` fires on any non-zero
figure. What is genuinely lost is a request killed before the first `usage`
chunk, whose prompt the server had already processed.

## 2. Two traps this has to avoid

**T1 — `modelId` does not come from the event.** It is filled from the
_provider's current task_ (`ClineProvider.getTaskProperties`,
`ClineProvider.ts:4134`). Condense and enhance routinely run on a different
profile, so an event emitted without an explicit model would be labelled with
whatever the open task happens to use. Event properties take precedence over
provider properties in `BaseTelemetryClient.getEventProperties`, so each side
call must state its own `modelId`/`apiProvider`.

**T2 — the Zod schema silently strips undeclared properties.** `CloudTelemetryClient.capture`
posts `rooCodeTelemetryEventSchema.safeParse(payload).data`, and Zod drops
unknown keys. This is exactly why 16 393 `Tool Used` rows carry no `tool`
(D5 in the GUI-overhaul plan). Every new property is declared in the schema or
it does not exist.

**T3 — per-request model attribution breaks the moment this ships.** The join
built in `feat/cloud-web-model-attribution` matches `api_req_started` messages
to `LLM Completion` events on `(inputTokens, outputTokens)`, in order. Condense
and enhance events land on the same `taskId` and would be matched to
conversation rows. The reader must filter to task-kind completions; legacy rows
(no kind) stay task-kind.

## 3. Design

### 3.1 A kind on every completion

`LLM Completion` gains `completionKind: "task" | "condense" | "enhance" | "memory"`,
absent meaning `"task"` for rows written before this. Plus `usageReported: boolean`
— false when a provider could not tell us what the call cost, so the console can
say "3 calls, figures unknown" instead of "3 calls, 0 tokens".

### 3.2 Embeddings are a different animal, so a different event

`Embedding Usage` — its own event type carrying `{modelId, apiProvider,
promptTokens, totalTokens, source}`. Not folded into `LLM Completion`, because
indexing a repository is hundreds of thousands of tokens with no output and no
cost, and folding it in would swamp the conversation figures it is meant to sit
beside. It gets its own tile.

### 3.3 Recovering usage from `completePrompt`

`SingleCompletionHandler.completePrompt` returns `Promise<string>` and throws the
usage away, in all 23 providers. Rather than change that signature (23 call
sites, every provider test, every test double), each provider gains a sibling:

```ts
interface SingleCompletionHandler {
	completePrompt(prompt: string): Promise<string>
	completePromptWithUsage?(prompt: string): Promise<CompletionResult>
}
```

and its existing body moves into `completePromptWithUsage`, with `completePrompt`
delegating:

```ts
async completePrompt(prompt: string): Promise<string> {
	return (await this.completePromptWithUsage(prompt)).text
}
```

Behaviour is unchanged by construction — same request, same return value — and
the diff per provider is small. Callers go through one helper,
`runCompletion(handler, prompt)`, which prefers the usage-bearing method and
falls back to the plain one, so a provider that has not been converted (or an
external implementor) still works and simply reports `usageReported: false`.

### 3.4 Where the numbers come from

- **Condense**: `streamSummary` already reads the `usage` chunk but keeps only
  `cost` and `outputTokens`. It keeps all of it now and returns it.
- **Enhance / memory**: from `runCompletion`.
- **Embeddings**: the call site of `createEmbeddings`, which already receives
  `{promptTokens, totalTokens}`.

## 4. The console (branch 2)

- Attribution filters to `completionKind` task/absent — correctness, not display.
- A **kind breakdown** beside the by-model and by-mode tables: what the
  conversation cost versus what the machinery around it cost.
- An **Indexing** tile: embedding tokens for the period, separate from the
  token total.
- The task detail page names side calls in the header rollup without letting
  them into the per-request badges.

## 5. Non-goals

- Re-pricing embeddings. No provider reports a cost for them and this
  deployment runs them locally; tokens are the honest unit.
- A request killed before its first `usage` chunk. Nothing to report, and
  guessing is worse than a gap.

## 6. Outcome

_(filled in after the work)_
