# Show the task's opening prompt on hover in the web list

**Date:** 2026-07-31
**Branch:** `feat/cloud-web-prompt-hover` (stacked on `feat/cloud-web-pager-jump`)

## The complaint

A row in `/app` identifies its task by `tasks.title` — the **first line** of the
opening user message, cut at 100 characters. That is enough to tell two runs
apart and not enough to remember what either one was. Hovering a row today adds
only the token/cost breakdown; the request that started the run is nowhere on
the page. Opening the task is the only way to read it.

The ask: on hover, show the prompt as well — not necessarily all of it if it is
very long, but far more than the single truncated line there is now.

## Where the text is (and why it isn't cheap)

The prompt lives in the first text-bearing `task_messages` row, wrapped by the
extension in `<task>`/`<user_message>` and trailed by a machine-built
`<environment_details>` block (mode, open tabs, file tree, cost). Those opening
rows are the _largest_ in the corpus — the environment appendix alone runs to
tens of kilobytes.

So the list must not read them. `services/task_summary` exists precisely because
the list used to load and parse every message on every page view (387 queries
and 205 MB per request on the live deployment). Fetching 25 opening messages per
page would walk that back in the one place it hurts most.

The prompt is therefore denormalized onto the task row, next to the title it is
derived from — same source message, same write, same read.

## Design

### 1. `tasks.prompt_excerpt` (new nullable column)

The opening query, wrappers stripped, capped at `PROMPT_MAX = 1000` characters
(cut at a word boundary, `…` appended). Newlines are kept — a prompt's shape is
half of how it reads — with runs of blank lines collapsed to one.

1000 characters is ~10 wrapped lines: a paragraph or a short bulleted brief
fits whole, a 30-line specification shows its first screen. The cap is on the
stored value, so a giant prompt costs the row nothing.

### 2. `derive_prompt()` beside `derive_title()`

Both currently answer the same question — _what did the user actually ask?_ —
and `derive_title` already does the work: walk to the first text-bearing
message, drop `<environment_details>`, unwrap `<task>`. That walk is lifted into
`first_user_query()`; `derive_title` keeps taking its first line, `derive_prompt`
takes the whole thing to the cap.

One source, so the two can never describe different messages.

### 3. Written under the title's rule

`refresh_task_summary(..., title=, prompt=)` applies both together, gated by the
existing "only when the row has no real title yet, unless `force_title`" check.
A re-share (which replaces the conversation wholesale) forces both; a live
message that arrives after the opening one changes neither.

### 4. Backfill

Migration `e1f2a3b4c5d6` adds the column and fills it the way
`f6a7b8c9d0e1` filled the titles: the earliest 40 rows of each task, which is
where the opening message always is — never the whole conversation.

### 5. The hover itself

`_row_tooltip()` composes what `_metrics_tooltip()` used to return alone:

```
Rewrite the pager so every page is reachable, not just the
next one. It should keep the search terms.

↑ In: 412,004
↓ Out: 18,220
⚡ Cache: 90,112 write / 301,880 read
⏱ Session: 41m
$ Cost: $2.9431
```

Native `title` tooltips are what every other cell on the row uses (workspace,
model, grade, subtask count), they honour newlines, and they need no script. But
they do **not** wrap: a 1000-character paragraph would render as one line wider
than the screen. So the excerpt is wrapped at 78 columns and capped at 14 lines
in the view layer — the stored value stays raw, and the wrapping is a rendering
decision the template's consumer can change.

The tooltip now appears for a task with no metrics at all (a run that never got
an `api_req_started`), which the old `has_metrics` gate suppressed entirely.

## Files

| File                                                   | Change                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `src/models/task.py`                                   | `prompt_excerpt` column                                                            |
| `src/services/task_summary.py`                         | `first_user_query`, `derive_prompt`, `PROMPT_MAX`; `refresh_task_summary(prompt=)` |
| `src/services/telemetry_service.py`                    | pass `prompt=` at both write sites                                                 |
| `src/routers/web.py`                                   | `_row_tooltip`, `_wrap_prompt`; list + tree view-models                            |
| `src/web/templates/tasks_list.html`                    | `title="{{ t.hover_title }}"`                                                      |
| `alembic/versions/e1f2a3b4c5d6_task_prompt_excerpt.py` | column + backfill                                                                  |
| `tests/test_web_and_share.py`                          | new cases                                                                          |

Two places beyond the list get the same hover for free, because they render the
same view-model off the same rows: the **subtask panel** (a delegated run's
title is the least informative of all — usually one instruction, cut) and the
**breadcrumb**, whose `title` previously just repeated the link text.

## Verification

`uv run pytest -q` → **191 passed** (183 before; 8 new).

Migration and rendering were checked against a clone of the production database
(389 tasks, 55 593 messages, at `d0e1f2a3b4c5` — this migration's parent),
restored into a throwaway Postgres and served on a local port:

- `alembic upgrade head` filled **387 of 389** rows (the 2 without are the known
  tasks that have telemetry but no stored messages). Average excerpt 608
  characters, longest 1001 — the cap plus its ellipsis.
- **0** excerpts contain `<environment_details>`, `<task>`, `<user_message>`, or
  open with `{`.
- **19** rows have an excerpt that says more than its title's first line — the
  runs titled `fix:`, `## Context`, `review this diff:`. Those are the rows the
  list could not identify at all before.
- Across three pages, 61 of 62 rows render a hover (the 62nd has neither prompt
  nor figures and correctly carries no `title` attribute at all); no line
  exceeds 78 columns and no tooltip exceeds 20 lines.
- The detail page: all 50 subtask links and the breadcrumb carry the parent's
  own request.

Two defects the real data found:

- `textwrap` hyphen-breaking turned a URL into `local-inference-` / `lab/…`,
  which reads as a hyphenation that isn't in the text. `break_on_hyphens=False`
  (long words are still broken — an unbroken 1000-character token has to be
  bounded somehow).
- The elision mark was appended _past_ the column, so a height-capped tooltip
  had one 79-character line. Room is made for it instead.

No screenshot pass: this changes an attribute, not the layout — and a native
tooltip is drawn by the OS, not into the DOM, so a headless capture would show
nothing anyway.

The running `api` container must be rebuilt before any of this is live
(`docker compose up -d --build api`); the migration runs from the entrypoint.

## Tests

- `derive_prompt` returns the whole multi-line query where `derive_title` returns
  one truncated line, and strips `<environment_details>` / `<task>` framing.
- A prompt past the cap is cut at a word boundary and ends with `…`; a blob with
  no whitespace at all is still cut.
- Backfill stores `prompt_excerpt`; a re-share overwrites it.
- The rendered list carries the prompt in the row's `title` attribute, with the
  figures still under it.
- `_wrap_prompt` holds the column and the height, mark included.
- A task with no metrics still gets a tooltip (prompt only), and one with
  neither gets no attribute — where the old template rendered `title="None"`.
