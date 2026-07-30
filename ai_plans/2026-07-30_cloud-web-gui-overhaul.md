# Self-hosted cloud web GUI — audit and overhaul plan

Date: 2026-07-30
Scope: `self-hosted-cloudapi/` (FastAPI backend + server-rendered web GUI)

---

## 1. Audit of the running deployment

This is not a paper review. Every number below was measured against the live
stack (containers up 46h, all healthy) on 2026-07-30.

### 1.1 What works

| Area              | State                                                                      |
| ----------------- | -------------------------------------------------------------------------- |
| Infrastructure    | `api` (:8085), own Postgres, full Authentik (server/worker/db :5544/redis) |
| Health            | `GET /health` → 200                                                        |
| Tests             | 91/91 pass in 2.2s                                                         |
| Clerk auth facade | sign-in by ticket, session tokens, `/v1/me`, memberships, logout           |
| Authentik OAuth   | PKCE, front/back-channel URL split, `Host` header override for brand       |
| Web session       | signed `tumble_session` cookie, re-validated against DB per request        |
| Share + backfill  | idempotent message replace, absolute share/manage URLs                     |
| Live bridge       | socket.io relay, approve/deny/send/stop/resume/auto-approval               |
| Streaming persist | `ON CONFLICT` upsert with a monotonic guard against short late partials    |

Live data volume: **387 tasks, 55 541 messages, 90 223 telemetry events**.

### 1.2 Defects and gaps (with evidence)

**D1 — Task list is O(all messages) per page view.**
`routers/web.py:237-239` runs one query per task and JSON-parses every message
of every task to derive the title and totals. Measured in-container:

```
tasks=387 msgs=55541 list_query=0.06s full_render=2.47s
```

387 queries + 205 MB of text parsed on every `/app` load. No pagination, no
search. Cost grows linearly and unboundedly.

**D2 — No retention, and the conversation is stored twice.**
`grep -r "retention|cleanup|purge"` over the project: zero hits.
`task_messages` = **479 MB**; `telemetry_events` = **146 MB**, of which the
`Task Message` event type (53 067 rows) carries the _full_ `ClineMessage` —
duplicating what `task_messages` already holds.

**D3 — Not every conversation block is collapsible.**
`static/render.js:91-195` sets `fold: true` only for assistant text, reasoning,
command, command output, tool and MCP. Always-expanded: user message,
completion result, error, followup question, subtask result, condensed context,
image, and the generic fallback. Several of those (condensed context, subtask
result) are routinely long.

**D4 — Subtasks are invisible even though the data is complete.**
`Task Created` telemetry carries `parentTaskId` and `isSubtask`. Of 151 known
subtasks, **150 have a parent row in `tasks` AND stored messages**, and 151/151
have telemetry messages. Nothing reads this; children appear as flat, orphaned
entries in the list.

**D5 — `Tool Used` telemetry loses the tool name.**
`TelemetryService.ts:118` sends `{taskId, tool}`, but the `TOOL_USED` branch of
`rooCodeTelemetryEventSchema` (`packages/types/src/telemetry.ts:174`) declares
only `telemetryPropertiesSchema`, so Zod strips `tool` before the POST.
Confirmed against the DB: 16 393 `Tool Used` rows, no `tool` key on any of them.
_This is an extension-side fix, outside this plan's backend scope; recorded for
a follow-up branch._

**D6 — LLM proxy is a stub with an open door.**
Hardcoded 2-model catalog; `provider_configs` table exists but is never read;
no usage accounting. `routers/proxy.py:36` uses `get_current_user_optional`, so
`/v1/chat/completions` and `/v1/images/generations` are effectively
**unauthenticated**. Currently latent only because no LLM key is set in `.env`.
_Recorded; not in this plan's scope._

**D7 — Deletion is one-at-a-time**, via a per-row form + `confirm()`.

**D8 — No cost/quality surfacing per session.** `/api/extension/credit-balance`
returns a hardcoded `{"balance": 0}` with a `TODO`. Telemetry meanwhile holds
**$1024.41** across 13 164 completions (openai $1023.18 / 7814 calls;
openai-codex $1.23 / 5350 calls — the latter is a subscription reporting zero).

---

## 2. Scope decision

The user initially asked for full cost-charging support, then explicitly
retracted it: _"zupełnie omiń budżetowanie i rozliczenia"_.

**Out of scope:** budgets, markup, amounts due, per-user chargeback, invoices,
credit balances, subscription imputed pricing.

**In scope:** cost as a _displayed metric_ alongside tokens and duration — it is
part of "session quality" and is already half-present in the UI.

Retention semantics chosen by the user: **hard delete of whole tasks**.

---

## 3. Branch stack

Files overlap heavily (`routers/web.py`, `app.css`, all templates,
`render.js`), so branches are stacked, each on the previous.

| #   | Branch                              | Delivers                                                  |
| --- | ----------------------------------- | --------------------------------------------------------- |
| 1   | `perf/cloud-web-task-list`          | persisted per-task summary, no N+1, pagination — fixes D1 |
| 2   | `feat/cloud-web-ui-foundation`      | design system + layout refresh                            |
| 3   | `feat/cloud-web-collapsible-blocks` | every block foldable + collapse/expand all — fixes D3     |
| 4   | `feat/cloud-web-subtasks`           | parent/child linkage, subtask tree, drill-in — fixes D4   |
| 5   | `feat/cloud-web-session-quality`    | quality metrics per task and in aggregate — addresses D8  |
| 6   | `feat/cloud-web-bulk-delete`        | multi-select + bulk delete — fixes D7                     |
| 7   | `feat/cloud-web-retention`          | retention settings page + purge job — fixes D2            |

### Branch 1 — `perf/cloud-web-task-list`

Root cause of D1 is that display data is derived at read time from the full
message corpus. Fix: derive it **once, at write time**, and store it.

- New columns on `tasks`: `title`, `message_count`, `tokens_in`, `tokens_out`,
  `cache_reads`, `cache_writes`, `cost`, `duration_ms`, `first_ts`, `last_ts`.
- New `src/services/task_summary.py` — a single implementation of the
  aggregation currently duplicated in `web._compute_metrics` and
  `render.js:getMetrics`. Recomputed on backfill (full recompute, cheap: the
  messages are already in hand) and incrementally on live upsert.
- Alembic migration + one-shot backfill for the existing 387 tasks.
- `/app` becomes a single indexed query with `LIMIT/OFFSET` + pagination UI.
- Target: `/app` server time from 2.47s to under 50ms.

### Branch 2 — `feat/cloud-web-ui-foundation`

Current CSS is a flat VS Code dark palette with no spacing scale, no elevation
model, and no light mode. Replace with a proper token layer (colour ramps,
spacing, radius, shadow, type scale), rebuild the shell (topbar, nav, content
container), and restyle the existing task list / detail / metrics pages against
it. Add a light/dark toggle honouring `prefers-color-scheme`.

### Branch 3 — `feat/cloud-web-collapsible-blocks`

- Every `classify()` branch returns a foldable row; the fold decision moves from
  a hand-maintained per-kind flag to a rule: _a row with a body is foldable_.
- Default open/closed per role (user message and result open; reasoning, tool
  output, environment details closed).
- Toolbar: collapse all / expand all, and a per-role filter.
- Long bodies get a max-height with a "show more" affordance so an expanded
  block cannot swallow the page.

### Branch 4 — `feat/cloud-web-subtasks`

- `tasks.parent_task_id` column, filled from `Task Created` telemetry in
  `record_event` (and by a one-shot backfill for the existing 151 links).
- Task list groups children under their parent, collapsed by default, with a
  child-count badge; a filter toggles "roots only" vs "flat".
- Task detail: breadcrumb up to the root, and a subtask panel listing children
  with their own tokens/cost/duration, each a link into the child's own page.
- The `newTask`/`subtask_result` rows in the conversation link to the child task
  where the id can be resolved.

### Branch 5 — `feat/cloud-web-session-quality`

Quality proxies computed from data already present — deterministic markers only,
never keyword scans of tool output (the same discipline as
`scripts/agent-bench/collect.py`):

- **Corrections**: count of mid-task `user_feedback` (278 in the corpus).
- **Errors**: `error`, `diff_error`, `api_req_failed`, `api_req_retry_delayed`,
  `mistake_limit_reached` rows.
- **Context pressure**: `condense_context` count, `Context Microcompacted`,
  `Sliding Window Truncation` events.
- **Retries/rework**: repeated identical tool paths within a task.
- **Latency**: `ttftMs` distribution from `LLM Completion`.
- **Completion**: whether the task reached `completion_result`, and whether the
  user answered it instead of accepting (rework signal).
- **Efficiency**: tokens per tool call, cache hit ratio, cost per task.

Surfaced as: a score strip on the task detail header, a per-task quality badge in
the list, and a quality section on `/app/metrics` (distribution + worst offenders).

### Branch 6 — `feat/cloud-web-bulk-delete`

Checkbox column, shift-click range select, select-all-on-page, a sticky action
bar showing the selection count and total size to be freed, one confirmation
dialog for the whole batch, `POST /app/tasks/bulk-delete` with owner checks per
id. Deleting a parent offers to include its subtasks.

### Branch 7 — `feat/cloud-web-retention`

- New `retention_policies` table (per user): enabled, `max_age_days`,
  `max_tasks`, `max_total_bytes`, whether to keep shared tasks, whether to purge
  raw telemetry, and a separate shorter window for `Task Message` events (which
  duplicate `task_messages`) while preserving `LLM Completion` (needed for
  metrics).
- Settings page under `/app/settings` with a **dry-run preview**: exactly what
  would be deleted, how many rows, how many MB freed — before anything runs.
- Hard delete of whole tasks, per the user's choice.
- A background sweep on an interval, plus a manual "run now" button.

---

## 4. Outcome

All seven branches are built, tested and committed, stacked in the order above.
138 tests pass (up from 91). Every migration was verified against a clone of the
production database, never against production itself.

| Branch                                | State | Evidence                                                                                                   |
| ------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| 1 `perf/cloud-web-task-list`          | done  | `/app` server time 2470ms -> 2.3ms; 387/387 tasks match the old computation on every field, 0 mismatches   |
| 2 `feat/cloud-web-ui-foundation`      | done  | screenshots of all three pages; found the column-alignment and uppercase-content defects                   |
| 3 `feat/cloud-web-collapsible-blocks` | done  | 21 browser assertions; mutation-checked (breaking the fold rule turns 21 passes into 10 failures)          |
| 4 `feat/cloud-web-subtasks`           | done  | 157 links recovered, 151 stamped, 0 dangling / 0 disagreements / 0 self-parents; list 387 flat -> 236 runs |
| 5 `feat/cloud-web-session-quality`    | done  | 60 clean / 104 friction / 72 unfinished across 236 runs                                                    |
| 6 `feat/cloud-web-bulk-delete`        | done  | 20 browser assertions + 8 server tests                                                                     |
| 7 `feat/cloud-web-retention`          | done  | 15 tests; preview verified against the sweep                                                               |

### Changes from the plan as written

**Light mode was cut** (planned in branch 2). Dark is the identity here and a
half-committed light theme would dilute it for a personal console used beside a
dark editor. The token layer would support one if it is ever wanted.

**The "rejection" signal was renamed and taken out of the grade** (branch 5).
Counting a reply to a proposed result as a defect fired 160 times against 104
mid-run corrections on the live corpus, and moved 17 of 236 runs out of "clean"
on a reading the data does not support — `scripts/agent-bench/collect.py`
documents the same signal as "pushback or follow-up, not a defect count". It is
now reported as context, named honestly, and excluded from the grade.

**A retention default was removed before it could bite** (branch 7). The first
draft gave a fresh policy `max_age_days = 90`; a test written for it showed that
"Run now" would then delete months of conversations for someone who had only
just opened the page. Limits now start NULL, with the suggested values as form
placeholders.

### Defects found while building, beyond the audit list

- The task list was a flex row, so a task missing a workspace or a cost shifted
  every figure after it and the columns could not be read down.
- Message headers uppercased their whole label, mangling content: `uv run pytest
-q` rendered as `UV RUN PYTEST -Q`, and file paths came out shouting.
- A fold the reader opened slammed shut on the next streamed chunk, because
  every partial re-rendered the row.
- Deleting a parent left its children pointing at a deleted task. Postgres nulls
  it via the foreign key; SQLite does not enforce foreign keys unless asked, so
  the engines disagreed — and a child left pointing at a deleted parent
  disappears from the list entirely, since the default view selects on
  `parent_task_id IS NULL`. Now nulled explicitly, in code, on both.
- Session quality was rendered inside the telemetry `has_data` gate, so it
  vanished whenever no completions were recorded for the period — even though it
  is computed from the task rows, not from telemetry.

### Operational note

The running `api` container is built from an image that predates
`src/utils/`, so it is behind this branch stack. It needs rebuilding before any
of this is live: `docker compose up -d --build api`. The migrations then run
from the entrypoint; the whole chain took 14s against a clone of the production
database.

---

## 5. Non-goals / follow-ups recorded

- **D5** (`Tool Used` loses `tool`) — extension-side Zod schema fix.
- **D6** (proxy stub + optional auth) — separate hardening branch; make auth
  mandatory before any LLM key is ever configured.
- Reconstructing conversations for the 1 subtask that has telemetry messages but
  no stored messages — not worth the machinery for a single row.
