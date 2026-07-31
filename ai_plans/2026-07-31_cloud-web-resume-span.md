# Stop counting the time a task spent closed as time it ran

**Date:** 2026-07-31
**Branch:** `fix/cloud-web-resume-span` (stacked on `feat/cloud-web-prompt-hover`)

## The complaint

A row in `/app` reported **4h 26m** for a run the user knew had taken minutes.

## What the data says

Task `019fb79d-5c3b-7261-b1eb-06093f188558` on the live deployment, 55 messages:

| what                                              | when                                                        |
| ------------------------------------------------- | ----------------------------------------------------------- |
| first message (the user's prompt)                 | 09:59:31                                                    |
| last message that is actually work (`finishTask`) | 10:02:41                                                    |
| **real span**                                     | **3m 10s**                                                  |
| message #55                                       | 14:25:37 — `{"ts": …, "type": "ask", "ask": "resume_task"}` |
| reported span                                     | 4h 26m                                                      |

The gap between step 54 and step 55 is **15 776 s**; all 54 gaps before it are
0–28 s. The final "step" is an empty marker: no `q_kind`, no tokens, no text.

`ask: resume_task` is not part of the conversation. The extension writes it when
a task is **reopened from history** — `TaskResumption.determineAskType()` picks
it (or `resume_completed_task` when the run had finished), and the ask is the
confirmation prompt "resume this task?". So the row records the moment the user
came back to the task, and nothing else.

The extension itself does not treat these as content: on the next resume,
`TaskResumption.cleanupStaleMessages()` splices off every trailing
`resume_task`/`resume_completed_task`, and `taskMetadata.ts` skips them when
looking for the last real message. The cloud copy keeps them forever, because
ingest only ever upserts rows and never deletes.

## Why the number came out wrong

`refresh_task_summary()` stores the span as `MIN`/`MAX(message_ts)` over _all_
of a task's rows, and `duration_ms(first_ts, last_ts)` subtracts them. A marker
written four hours after the work ended is a row like any other, so it moves
`MAX` four hours forward.

## Scale (live DB, 392 tasks)

- **59 tasks** end in a resume marker; mean inflation **100 min**, worst
  **1752 min (29 h)**.
- 183 × `resume_task` + 41 × `resume_completed_task` rows stored.
- 58 tasks report over an hour — essentially all of them for this reason.

## The decision that shapes the fix

Idle time **stays in the span**. The user's ruling: time a run spends waiting
for them to answer is time the task took, and pretending otherwise would flatter
the numbers. So there is no "active time" heuristic, no gap threshold, and no
capping — the span remains wall-clock from the first message to the last.

What is removed is only the case where the wall-clock has nothing to measure:
a marker that says "you came back", written after the run had already stopped.

## Design

### 1. `KIND_RESUME` — classify the marker at write time

`services/session_quality` already classifies every message once, at ingest, into
a `q_kind` column. Resume asks currently classify to `NULL`, which is why the
span cannot tell them apart from work.

They get a kind of their own: `resume`. It is not a quality signal — no `q_*`
counter counts it and the grade does not see it — it exists so that the one
aggregate that must exclude these rows can do so on an **indexed column**,
without reading `message_data`. That is the constraint `services/task_summary`
was built around: the list must never touch message text.

### 2. The span skips resume rows

In `refresh_task_summary`, `MIN`/`MAX` run over
`CASE WHEN q_kind IS DISTINCT FROM 'resume' THEN message_ts END` instead of
`message_ts`. Everything else in the same aggregate — counts, tokens, quality —
is untouched.

A resume marker in the _middle_ of a task changes nothing (it was never the
`MIN` or the `MAX`), and the idle time before the work that followed it stays
counted, exactly as decided above.

A task whose only rows are resume markers ends with `first_ts`/`last_ts` NULL,
so it shows no duration rather than a fabricated one. Nothing else reads those
two columns.

### 3. The detail timeline needs no change — checked, not assumed

`static/render.js` gives each row the gap to the row that follows it, so the
expectation was that a marker four hours later had labelled the run's final step
**4h 23m** as well. It had not: a resume ask carries no `text`, `classify()`
routes it to the `default` branch, and that branch returns `null` for a message
with no text. The row is never created, so no duration is ever stamped from it.

That is correct behaviour arrived at incidentally — one `case` added for
`resume_task` in `classify()` would reintroduce the defect in the detail view.
It is pinned by a browser harness instead of being defended by code that cannot
currently run.

### 4. Migration `f2a3b4c5d6e7` — mark, then recompute

1. Find the resume rows and set `q_kind = 'resume'`. Candidates are narrowed in
   SQL by text match and then **confirmed by parsing** each candidate, so a
   message that merely mentions the word is not mislabelled. One-time cost is a
   scan of `message_data`; the same walk the `b8c9d0e1f2a3` backfill already did.
2. Recompute `tasks.first_ts` / `tasks.last_ts` with the resume rows excluded —
   the same rule as the runtime aggregate, so a migrated row and a freshly
   written one agree.

`downgrade()` restores both: `q_kind` back to NULL, spans back to the plain
`MIN`/`MAX`.

## Deliberately unchanged

- **`message_count`** still counts the resume rows. It is documented as the
  number of stored rows, it is not a time claim, and the off-by-one is not what
  anyone reads that column for.
- **The metrics page's session duration** already sums per-task spans from
  `LLM Completion` telemetry, not from messages, so it never saw this.

## Tests

- `refresh_task_summary` puts the span at the last _work_ message when a resume
  marker trails it (the live shape: work, long gap, marker).
- A resume marker between two work messages leaves the span alone.
- A resume ask classifies as `KIND_RESUME` and still counts as no quality signal.
- Browser: a resume row does not stamp a duration on the step before it.

All 196 cloudapi tests pass, browser harnesses included.

## Measured on a clone of the live database

`roo_cloud` was cloned inside the postgres container and migrated from a
throwaway container on the compose network (the method recorded for
`d0e1f2a3b4c5`), starting from `e1f2a3b4c5d6`, which is where the live DB sits.

|                              |                                                |
| ---------------------------- | ---------------------------------------------- |
| resume rows classified       | 224 (183 + 41, matching the pre-count exactly) |
| tasks whose span changed     | 61                                             |
| phantom time removed         | **98 hours**                                   |
| worst single correction      | 1752 min (29 h)                                |
| tasks reporting over an hour | 58 → 44                                        |
| the reported task            | 266.1 min → **3.17 min**                       |
| tasks whose span grew        | 0                                              |

One task ends with a NULL span: a single-row task whose only row is a resume
marker. It displayed no duration before (a lone row spans 0) and displays none
now.

`alembic downgrade -1` was run on the same clone: every marker cleared, the
reported task back to 266.1 min, and every task's span equal to the plain
`MIN`/`MAX` again — 0 rows differing.
