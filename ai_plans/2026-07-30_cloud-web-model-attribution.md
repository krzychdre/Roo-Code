# Which model ran this request — model attribution in the cloud web GUI

Date: 2026-07-30
Scope: `self-hosted-cloudapi/` (schema, services, web views, renderer)
Branch: `feat/cloud-web-model-attribution` (stacked on `feat/cloud-web-retention`)

---

## 1. The gap

The console can already say what a run cost and how it went. It cannot say
**what answered**. Opening a task shows a column of `API ↑16591 ↓498 $0.0000`
rows with no indication of which model produced them — and a run is routinely
not one model: 13 of 376 recorded tasks switched model mid-run (measured, §2).

The metrics page has a "Tokens by model" breakdown, but that is an aggregate
over a period. It answers "what did I spend on GLM this week", never "which
model wrote _this_ answer".

## 2. What the data actually supports (measured on the live DB, 2026-07-30)

**`task_messages` cannot answer it.** The stored `api_req_started` payload is
the whole record of a request and it carries no model:

```json
{ "apiProtocol": "openai", "tokensIn": 16591, "tokensOut": 498, "cacheWrites": 0, "cacheReads": 15872, "cost": 0 }
```

**`telemetry_events` can.** Every `LLM Completion` event carries
`{taskId, modelId, mode, apiProvider, inputTokens, outputTokens, cost}`.

```
LLM Completion rows            13 164
distinct taskIds                  376
tasks that used >1 model           13
```

**The two sources line up 1:1 and in order.** Checked against task
`019fa87b-2a52-…`, whose four requests match four events exactly on the
`(inputTokens, outputTokens)` pair and in chronological order:

```
api_req_started            LLM Completion
↑12019 ↓206                gpt-5.6-sol / orchestrator  12019 / 206
↑12389 ↓792                gpt-5.6-sol / orchestrator  12389 / 792
↑16221 ↓231                gpt-5.6-sol / orchestrator  16221 / 231
↑16591 ↓498                gpt-5.6-sol / orchestrator  16591 / 498
```

That pair is the join key. It is not a timestamp match: the message `ts` is
stamped client-side when the request _starts_, the event `created_at`
server-side when it _finishes_ — 3.5 minutes apart in the sample above.

**The join key is not free today.** `taskId` lives inside the `properties`
TEXT blob, so every consumer (`metrics_service`, `task_tree`, and this feature)
re-parses JSON to find it. Filtering 13 164 rows by `LIKE '%"taskId":"…"%'` on
every page view is precisely the O(corpus) read the list view was just rescued
from (`3aaa6c9f1`). So the column gets promoted.

## 3. Design

### 3.1 Schema (migration `e1f2a3b4c5d6`)

- `telemetry_events.task_id` — String, nullable, **indexed**. Stamped at ingest
  from `properties.taskId`; backfilled for existing rows. The blob stays
  authoritative; this is a lifted lookup key, not a second source of truth.
- `tasks.models` — String, nullable. Comma-joined distinct model ids for the
  task, most-used first. Denormalized for the same reason every other summary
  column is: the list must not parse JSON per row.

### 3.2 Attribution (`services/model_attribution.py`)

`attribute_requests(messages, completions) -> {message_ts: {model, mode}}`

1. **Greedy ordered match** on `(tokensIn, tokensOut)`. Walk the requests in
   order, consuming events in order; an event may be skipped (telemetry can
   exist for a request whose message was never stored), a request may go
   unmatched (a cancelled request emits no completion event).
2. **Single-model fallback.** A request left unmatched in a task that only ever
   used one model is attributed to it — unambiguous by construction.
3. **Otherwise: nothing.** No badge is better than a guessed badge. This is a
   provenance display; a wrong model name here would be worse than a blank.

Why not positional-only: a task with 74 events and 169 messages (real row) has
requests that never reached telemetry. Position alone would shift every
attribution after the first gap.

### 3.3 Where it surfaces

| View         | What                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| Conversation | Model badge on each `API` row, next to the token/cost figures           |
| Task detail  | "Models" line in the quality panel: model · mode · request count        |
| Task list    | Model badge per row, from `tasks.models` (no query per row)             |
| Share view   | Same as the detail view — provenance travels with the shared transcript |

The renderer gets the map as a separate `#request-models` JSON island keyed by
message `ts`, rather than mutating the stored `api_req_started` payload. The
payload is a verbatim copy of what the client sent; the attribution is derived,
and derived data does not get written back into the record.

### 3.4 Keeping `tasks.models` true

Telemetry and messages arrive in either order (a task can be shared long after
it ran, or run live before it is ever shared), so the column is refreshed from
both directions:

- `telemetry_service.record_event` — after an `LLM Completion` lands.
- `task_summary.refresh_task_summary` — after any message write.

Both do the same indexed `SELECT task_id, properties … WHERE task_id = ?`, which
is small (the largest task has 74 events) and now index-backed.

## 4. Non-goals

- **Live rows.** A request streaming in over the bridge gets its badge on the
  next page load, once its completion event exists. Threading the model through
  the socket relay is a bridge-protocol change, not this one.
- **Backfilling the model into `api_req_started`.** See §3.3.
- **Fixing the extension.** `api_req_started` _could_ carry `modelId` from the
  client; that is an extension-side change and a separate branch.

## 5. Test plan

- Attribution: exact 1:1 match; extra events; missing events; multi-model task;
  single-model fallback; ambiguous multi-model gap → unattributed.
- Ingest stamps `task_id` and refreshes `tasks.models`, in both arrival orders.
- Detail page renders the map and the models line; list renders the badge.
- Migration backfill over seeded legacy rows.

## 6. Outcome

Built, tested and verified against a clone of the production database — never
against production itself. 157 tests pass (up from 138).

### Measured on the clone (387 tasks, 90 223 events)

Migration: **12s** end to end.

```
telemetry_events stamped                 : 86 523 / 90 223
events with a taskId left unstamped      : 0
tasks given a models label               : 359 / 387
```

Attribution, run over every task that has both stored messages and telemetry:

```
tasks with both messages and telemetry : 359
api_req_started rows                   : 12 929
attributed                             : 12 777 (98.8%)
multi-model tasks                      : 13
  their requests / attributed          : 877 / 821 (93.6%)
attributions naming an unused model    : 0
tasks whose stored label disagrees     : 0
```

The 152 unattributed requests are the design working: a request with no
completion event in a run that used more than one model gets no badge. Zero
attributions name a model the task never ran on.

Browser assertions: 6 added (26 total in `render_checks.html`). Mutation-checked
— stubbing `modelOf()` to return null turns 3 of them red.

### Defects found while building

**The row grid was crushing titles, and had been before this change.** The
project badge sat in an `auto` track. Each list row is its own grid, so `auto`
is sized per row: the badges never lined up with each other, and a long worktree
name ate the title — `Upload Tracking Resource SODP Immuta Integration` rendered
as `U…` next to `data-products-molecular`. Adding a second badge column made it
unmissable. Both badge columns are now fixed tracks, and the scanning measure
went 1180px → 1360px to pay for the new column out of the page rather than out
of the title. Screenshots before/after: titles went from ~4 characters to full
sentences on the affected rows.

**A collapsed badge can truncate away its own meaning.** `GLM-5.2-MXFP4-A8 +1`
ellipsised to `GLM-5.2-MXFP4-A8…`, silently turning a two-model run into a
one-model one. The name and the `+N` are now separate elements; the name
yields, the count does not.

### Operational note

The production database is **not** migrated. `docker compose up -d --build api`
runs the chain from the entrypoint (~12s on this corpus). Until then the running
container is on the previous image and the column does not exist.
