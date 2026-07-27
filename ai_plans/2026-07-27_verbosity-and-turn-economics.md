# Why Tumble Code feels "rozgadany" and slow — measured analysis + plan

Date: 2026-07-27
Author: analysis session (no code changes yet)
Scope: agent-loop turn economics, prompt/rule design, reviewer mode
Baseline: `main` @ `23ed3f7ba`, 204 real tasks recorded after 2026-07-14 in
`~/.config/Code/User/globalStorage/qub-it.tumble-code/tasks`
Daily driver: **GLM-5.2 (Z.ai)**, secondary profile **OpenAI Sol**

Predecessor: `ai_plans/2026-07-12_glm-agent-loop-efficiency.md` (WS-F and WS-8 still open).
This document supersedes its cost model — the measured numbers below are materially worse
than that plan assumed, and the dominant cause was not on its list.

---

## 0. Answer in one paragraph

Yes, it really happens, and it is measurable. But the "days" are mostly **calendar time, not
compute time** (87.3% of elapsed wall clock sits in gaps > 2 h with tasks left open; real
model-side active time is 6–17 min for a normal subtask, 48 min for the pathological ones).
What _is_ genuinely broken is the **cost and turn count per unit of work**: a GLM code task
burns 3.94 M input tokens over 39 turns for $5.71, a reviewer subtask 1.9–5.2 M, and one
orchestrator run in the corpus fanned out to 50 subtasks / 3,265 turns / **$251.28**. Three
mechanical defects account for most of it — a **microcompaction oscillation** that makes prompt
caching structurally impossible and re-bills the full context every other turn (31% of tasks,
77 M excess input tokens), **one-tool-per-turn** behaviour (79.5% of code turns, 100% of every
`OpenAI Sol` turn), and **read paging** that walks the same file in 200-line slices (48.4% of
all tool calls are reads; ~52% of them re-read a path already read in the same task). The
reviewer mode is the worst-affected consumer of all three, not a mode with an inherently longer
chain of thought.

---

## 1. Method

All numbers come from the on-disk task store, not from estimates:

- `history_item.json` → mode, profile, parent task, tokens, cost, timestamps
- `ui_messages.json` → `api_req_started` (per-request `tokensIn/tokensOut/cacheReads/cacheWrites/cost`),
  tool asks, approval gaps, `condense_context` events
- `api_conversation_history.json` → per-assistant-turn block structure (`tool_use` / `text` / `reasoning`)

Cutoff: tasks with `ts >= 2026-07-14` (i.e. after the background-hardening + agent-loop stack
landed on `main`), so the corpus reflects the _current_ code, not the pre-merge behaviour.
Corpus: 204 tasks, 10,062 billed API requests, ~986 M input tokens.

Scripts used: `/tmp/roo_*.py` (throwaway; regenerate from this doc's queries if needed).

---

## 2. Measured baseline

### 2.1 Per-mode / per-profile economics

| mode / profile         | tasks | turns   | tools/msg | multi-tool turns | active min | cost     | input tok   |
| ---------------------- | ----- | ------- | --------- | ---------------- | ---------- | -------- | ----------- |
| code / GLM-5.2         | 121   | 39      | 1.30      | 20%              | 11.9       | $5.71    | 3.94 M      |
| reviewer / OpenAI Sol  | 38    | 65      | **1.00**  | **0%**           | 16.8       | $0 (sub) | 5.24 M      |
| code / OpenAI Sol      | 12    | **177** | **1.01**  | 1%               | **47.8**   | $1.98    | **21.44 M** |
| reviewer / GLM-5.2     | 13    | 22      | 1.52      | 33%              | 5.9        | $2.69    | 1.88 M      |
| architect / GLM-5.2    | 5     | 20      | **2.46**  | **64%**          | 10.6       | $2.75    | 1.87 M      |
| orchestrator / GLM-5.2 | 5     | 19      | 1.00      | 0%               | 8.1        | $1.16    | 1.02 M      |

"active min" = sum of inter-message gaps < 180 s (idle-filtered).

### 2.2 Orchestrator fan-out

13 parent tasks spawned 118 subtasks (mean 9.1, max 50).

| parent     | subtasks | modes                               | total turns | cost        |
| ---------- | -------- | ----------------------------------- | ----------- | ----------- |
| `019f8e32` | 50       | 26 code + 24 reviewer               | 3,265       | **$251.28** |
| `019f95ce` | 32       | 17 code + 14 reviewer + 1 architect | 1,430       | $199.43     |
| `019f71d7` | 12       | 6 reviewer + 5 code + 1 ask         | 1,037       | $59.88      |
| `019f7443` | 12       | 8 code + 3 architect + 1 reviewer   | 1,962       | $44.13      |

Every subtask is a fresh conversation that re-pays the full fixed prompt (§2.4) and re-discovers
the codebase from zero. The code↔reviewer 1:1 pairing doubles that overhead by construction.

### 2.3 Prompt cache

| profile    | API reqs | input   | cacheRead | hit rate | ctx/req median | p90     | max     |
| ---------- | -------- | ------- | --------- | -------- | -------------- | ------- | ------- |
| GLM-5.2    | 5,242    | 515.6 M | 1.5 M     | **0.3%** | 94,943         | 176,510 | 384,911 |
| OpenAI Sol | 4,820    | 470.2 M | 250.1 M   | 34.7%    | 99,348         | 307,429 | 739,401 |

The parsing side is correct (`base-openai-compatible-provider.ts:219` reads
`prompt_tokens_details.cached_tokens`, and the `ROO_LOG_RAW_USAGE=1` spike from WS-6 is still
in place). The system prompt is byte-stable across a task — no timestamp, and `todoList` is
passed as `undefined` (`ApiRequestBuilder.ts:177`). So a 0.3% hit rate is **not** explained by
prompt drift at the head. It _is_ explained by §3.1.

### 2.4 Fixed per-turn payload

First-turn payload ≈ **20,577 tokens** before any conversation content:

- 23 native tool schemas: 41,583 chars ≈ **11,551 tokens** (sent in the `tools` param every turn)
- prompt sections: 13,896 chars ≈ 3,860 tokens, of which `rules.ts` alone is 6,430 chars ≈ 1,786 tokens
- role definition + custom instructions + environment details: the remainder

`environment_details` per user message: **6,263 chars in orchestrator mode** vs 1,365 in code
mode — 4.6× the noise on the mode that fans out.

`deferredTools: true` is **not** a problem: `tools_load` accounts for 0.4% of turns (39 calls
across 10,062 requests), and it only defers MCP/custom tools, never native ones. The prior
plan's rejection of the experiment for GLM can be dropped.

### 2.5 Tool mix and read behaviour

- `readFile` = **48.4%** of 8,232 tool calls.
- Only **11.8%** of reads use the 2000-line default window; the rest use small model-chosen slices.
- **53%** of code-mode reads and **51%** of reviewer reads are _same path, different range_
  (exact duplicates are only 2% / 0% — the dedup cache is working, the paging is not).
- **52 distinct paths** were read ≥ 10× within a single task.
- Observed walk on one file: `200 → 200-519 → 520-819 → 820-1159 → 1159-1438 → 2350-2569 →
3646-3865 → 4270-4669` — eight turns, eight reasoning episodes, one file.

### 2.6 Turn shape

- **79.5%** of code-mode assistant turns contain exactly one `tool_use` block.
- Every `OpenAI Sol` turn does (1.00–1.01 tools/msg, 0–1% multi-tool) — that profile never
  batches regardless of what the prompt says. `parallel_tool_calls: true` _is_ being sent
  (`openai-codex.ts:337`, `zai.ts:125`), so this is a model policy, not a wiring bug.
- GLM-5.2 batches only in `architect` (2.46) and `ask` (3.57); in `code` it manages 1.30.
- Reasoning per assistant message: code/GLM 2,552 chars, reviewer/GLM 1,231 chars.

### 2.7 Calendar vs compute

- 87.3% of elapsed time falls in gaps > 2 h — tasks left open overnight. "Trwa całymi dniami" is
  dominated by this, not by the model.
- Approval waits after a tool ask: median 1.5 s, but **195 waits > 60 s** and **126 > 5 min**,
  driven by `alwaysAllowWrite: false` while read/execute are auto-approved.
- `ask_followup_question` stalls total only 3.4 h across the whole corpus (42 events, median
  58 s) — minor.

---

## 3. Root causes, ranked

### RC-1 (critical) — microcompaction oscillates every other turn, destroying prompt caching

**Evidence (data).** Task `019f92d4` (code / GLM-5.2, subtask of `019f8e32`), consecutive billed
requests, strictly sequential in time:

```
29  08:49:08  in=219,162
30  08:49:17  in= 92,394     <- microcompacted
31  08:49:54  in=222,714     <- NOT microcompacted
32  08:50:00  in= 93,776     <- microcompacted
33  08:50:57  in=225,542
...  (alternates for 30 consecutive requests, cacheReads = 0 throughout)
```

**Evidence (code).** The loop is closed and provably unstable:

1. `packages/core/src/message-utils/consolidateTokenUsage.ts:89` derives `contextTokens` from
   the **last `api_req_started` message**: `tokensIn + tokensOut`.
2. Microcompaction is _non-destructive_: it clears old `tool_result` bodies **only in the
   outgoing copy** (`ApiRequestBuilder.ts:284-293`, `applyMicrocompactCleared`). Stored history
   stays pristine — by design, and that part is right.
3. Therefore a microcompacted request **reports the reduced size**. Next turn,
   `TaskContextManager.ts:342` reads that reduced number as `prevContextTokens`.
4. `context-management/index.ts:333` gates the pre-pass on
   `overCondenseThreshold || overAllowedTokens`, computed from that same reduced number. At 92 k
   of a 262 k window that is 35% — below the 75% threshold — so **no microcompaction runs**, and
   the full 222 k history goes out.
5. That request reports 222 k → 85% → microcompact → 92 k → 35% → … A textbook
   **hysteresis-free two-cycle**. Nothing in the path remembers that the reduction was a _send-time
   projection_, not a real shrink.

**Consequences.**

- The byte prefix sent to the provider changes on **every single turn**, so prefix caching can
  never hit. This is a complete, sufficient explanation for the measured **0.3%** GLM hit rate —
  no Z.ai-side probe is needed to explain it (a probe is still worth running to know the ceiling).
- On every "rebound" turn the full context is billed at full price.
- The model watches old tool results vanish and reappear. That is a strong candidate cause for
  the paging behaviour in §2.5: content it already read is no longer in context, so it reads it
  again — with a different offset, because it doesn't remember the previous window either.

**Blast radius.** 55 of 180 tasks with ≥ 6 billed requests (**31%**) show ≥ 2 oscillation events;
827 events total; **77.0 M excess input tokens** on the rebound turns alone. By mode:
**reviewer 27/51 (53%)**, code 26/135 (19%), architect 1, orchestrator 1. The reviewer is hit
hardest because its context is almost entirely tool results.

This single defect is the best explanation for the user's whole complaint, and it lands
disproportionately on the exact mode they singled out.

### RC-2 (high) — one tool per turn

79.5% of code turns and ~100% of `OpenAI Sol` turns carry a single tool call. Each such turn
costs a full round trip _plus_ a regenerated reasoning episode (GLM re-derives ~700–1000 tokens
of fixed-effort reasoning every turn; it has no adaptive thinking). Wall clock = decode ×
turn count, so turn count is the lever.

The prompt actively contradicts itself on this point:

- `sections/tool-use.ts`: _"Prefer calling as many tools as are reasonably needed in a single
  response to reduce back-and-forth and complete tasks faster."_
- `sections/tool-use-guidelines.ts:6` (item 3, legacy XML-era text): _"…or use tools iteratively
  across messages. Each tool use should be informed by the results of previous tool uses. Do not
  assume the outcome of any tool use. **Each step must be informed by the previous step's result.**"_

A frontier model resolves the tension. GLM/Qwen/local Llamas take the last, most absolute
sentence literally — and it says _one tool, then wait_. Item 3 is the older, stronger, more
specific instruction and it wins.

Note the honest limit: for `OpenAI Sol` no prompt change will help (1.00 tools/msg with
`parallel_tool_calls: true` already set). For that profile only RC-1, RC-3 and RC-5 apply.

### RC-3 (high) — read paging

`read_file`'s `limit` is documented only as _"Maximum number of lines to return (slice mode,
default: 2000)"_ (`native-tools/read_file.ts`). Nothing tells the model that reading a whole file
in one call is cheaper than four windowed calls, and the description actively steers toward
`indentation` mode with an `anchor_line` when a line number is known. `ReadFileTool.ts:568`
confirms the small windows are model-chosen (`entry.limit ?? DEFAULT_LINE_LIMIT`), not a setting.

Result: 48.4% of all tool calls are reads, half of them re-reads of an already-read path at a new
offset, each costing a turn. WS-F (read-dedup) from the July plan is still unimplemented, and
RC-1 partially defeats it anyway.

### RC-4 (medium) — fixed per-turn payload

~20.6 k tokens before any content, of which 11.5 k is the native tool schema block, re-sent every
turn _and_ re-paid in full by every one of the 118 delegated subtasks. With RC-1 fixed this
becomes cacheable and mostly free; without RC-1 it is pure, repeated cost. Fix order matters.

### RC-5 (medium) — reviewer mode: turn count, not thinking length

The user's perception is "b. długi tok myślowy". The data says the _reasoning_ is shorter than
code mode (1,231 vs 2,552 chars/msg). What is long is the **turn chain**:

- reviewer averages 54.2 turns/task, median 53 — a _higher median_ than code mode (33)
- 49 of 51 reviewer tasks are orchestrator-delegated subtasks, each re-paying ~20.6 k fixed tokens
- reviewer tool mix: readFile 56%, searchFiles 20%, codebaseSearch 9% — it is a pure read loop,
  and therefore the maximal victim of RC-1 and RC-3
- a representative GLM reviewer task ran **96 turns, ~1 tool per turn**, interleaving prose
  commentary with single reads; the visible "thinking" the user sees is that prose, not reasoning

Prompt-side contributors in the active mode definition
(`~/.config/Code/User/globalStorage/qub-it.tumble-code/settings/custom_modes.yaml`, slug `reviewer`):

- **eight** parallel focus areas, with _Performance_ listed twice ("Performance issues that might
  surface…" and "Performance: blocking calls, N+1 queries…") — a duplicated instruction reads as
  emphasis to a weak model and buys an extra sweep
- _"Ask for decisoin made by engineer or reveal apropriate ai_plan document…"_ — three typos
  (`decisoin`, `apropriate`, and later `actionable commendation` where `recommendation` is meant).
  Weak models pattern-match; a garbled instruction produces garbled compliance. In a delegated
  subtask there is no engineer to ask, so this clause is also unactionable.
- _"Use web search tools if uncertain of used mechanisms."_ — an open invitation to spend turns
  on MCP web search during a code review
- no budget, no ordering, no stop condition: nothing tells it to read the diff first, cap its
  file reads, or stop at N findings

**Dead rules directory (confirmed).** `~/.roo/rules-code-reviewer/` holds 7 files / **39,212
bytes** of XML — and it is **never loaded**. `sections/custom-instructions.ts:422` resolves
`path.join(rooDir, \`rules-${mode}\`)`where`mode`is the slug, and the active slug is`reviewer`, not `code-reviewer`(the`code-reviewer`slug belongs to the *old*`rooveterinaryinc.roo-cline`storage). The fallbacks`.roorules-reviewer`/`.clinerules-reviewer`don't exist either. So the reviewer today runs on`.roo/rules/` (4,004 B project + 145 B global)
plus its role definition — nothing else. Either rename the directory (and accept +39 kB/turn on
every reviewer turn, which is the _wrong_ direction) or delete it. Right now it is invisible
dead weight that also means past attempts to steer the reviewer via those files did nothing.

### RC-6 (low) — approval gating

Read and execute are auto-approved; **write is not**. 195 approval waits > 60 s and 126 > 5 min.
This is a user-side setting, not a code defect, but it is a real contributor to "days".

### RC-7 (non-cause, for the record)

- `deferredTools` is harmless (0.4% of turns). The July plan's rejection can be reversed.
- The system prompt is byte-stable; there is no timestamp or per-turn todo list in it.
- Batching did **not** regress after the July merge — the weekly series (w25 1.23, w26 1.36,
  w27 1.99, w28 1.37, w29 1.32) shows it is simply _weak and task-mix dependent_, ~1.2–2.0
  throughout. Do not chase a regression that isn't there.
- Reviewer reasoning length is _not_ the problem; see RC-5.

---

## 4. Plan

Ordered by measured impact ÷ effort. Each workstream gets its own branch, per repo convention.

### WS-1 — Fix the microcompaction oscillation (critical, small diff)

Branch: `fix/microcompact-oscillation`

The gate must be evaluated against the **pristine** context size, not the size of the last
_projected_ send. Options, preferred first:

1. **Track the pristine size separately.** Have `manageContext` return the pre-strip estimate and
   persist it (or recompute it from `apiConversationHistory` when the last request was
   microcompacted), and gate on _that_. The reported `tokensIn` stays honest for cost display.
2. **Latch the decision.** Once microcompaction selects a set of `tool_use_id`s in a task, keep
   clearing at least that set for the rest of the task (monotone, append-only). This alone makes
   the prefix monotone again and restores cacheability, and is the smallest possible change.
3. Add hysteresis (compact at 75%, stop only below 55%) — necessary but _not sufficient_ on its
   own here, because the measured swing is 35% ↔ 85%; it would still oscillate.

Recommendation: implement (2) as the correctness floor — a monotone cleared-set is exactly what
prefix caching needs — and (1) for the honest gate. Do not do (3) alone.

Acceptance criteria:

- a synthetic 40-turn task shows a **monotonically non-decreasing** `tokensIn` sequence apart from
  genuine `condense_context` events
- `cacheReads > 0` on GLM after turn 2 in a real task (if Z.ai reports caching at all — run the
  `ROO_LOG_RAW_USAGE=1` probe first to separate "we broke it" from "they don't report it")
- regression test asserting the gate is computed from pristine size, with a fixture that
  reproduces the 92 k/222 k alternation

Expected saving: the 77 M measured excess input tokens, plus whatever prefix caching then yields
(34.7% on Sol suggests the ceiling is large).

### WS-2 — Remove the batching contradiction (small diff, weak-model-critical)

Branch: `fix/tool-use-guidelines-contradiction`

Rewrite `tool-use-guidelines.ts` item 3 so it stops issuing the absolute
"each step must be informed by the previous step's result". Keep the genuine constraint
(don't chain on an _unknown_ result) and make the default explicit:

> 3. Batch by default. In one response, call every tool whose input you already know — reads,
>    searches, and listings of different paths are independent and must go in the same message.
>    Split into separate messages only when a tool's input literally depends on another tool's
>    output. Never assume a tool's result.

Write it as an imperative with a concrete example; weak models follow examples, not principles.
Delete the softer "you may use multiple tools… or use tools iteratively" hedge — a weak model
reads "may" as "need not".

Acceptance: `tools/msg` in code/GLM rises from 1.30. Measure with `scripts/agent-bench/collect.py`
before/after on the same task set. Do not ship on vibes — the metric already exists.

### WS-3 — Make whole-file reads the default (small diff)

Branch: `feat/read-file-whole-file-default`

In `native-tools/read_file.ts`:

- state the economics in the `limit` description: _"Omit `limit` to read the whole file (up to
  2000 lines). Prefer one whole-file read over several windowed reads — each extra call costs a
  full round trip. Only pass `limit` for files you know are larger than 2000 lines."_
- demote `indentation` mode from "preferred when a line number is known" to "use only for files
  above 2000 lines"
- add one worked example showing three files read in a **single** message with no `limit`

Optionally revive WS-F (read-dedup) from the July plan: when a path+range is already in context,
return a pointer instead of the bytes. After WS-1 this actually holds, because content stops
disappearing from under the model.

Acceptance: share of reads using the default window rises from 11.8%; same-path re-read share
falls from ~52%.

### WS-4 — Rewrite the reviewer mode (prompt-only, user-side file)

Branch: n/a (edit `custom_modes.yaml`) — but keep the new text in this repo under
`ai_plans/assets/` so it is reviewable and versioned.

Changes:

1. Fix the typos (`decisoin`→`decision`, `apropriate`→`appropriate`,
   `actionable commendation`→`actionable recommendation`). Non-negotiable for weak models.
2. Delete the duplicated _Performance_ bullet; collapse eight focus areas into a **ranked** list
   of four with an explicit instruction to spend budget in that order.
3. Replace _"Ask for decisoin made by engineer…"_ with a subtask-safe form:
   _"If an `ai_plans/` document for this change exists, read it first — it is the source of
   intended behaviour. You are usually running as a delegated subtask with no interactive user:
   do not ask questions, state your assumption in the report instead."_
4. Delete _"Use web search tools if uncertain of used mechanisms."_ — replace with
   _"Do not use web search. Ground every finding in this repository's code."_
5. Add an explicit **procedure and budget**, which is what actually cuts turns:

    > Work in this order: (1) read the full diff in one command; (2) list the changed files and
    > read each **once, in full, batching all reads into as few messages as possible**; (3) only
    > then search for callers of anything you suspect. Do not re-read a file you have already read
    > — scroll back in the conversation. Aim to finish in under 25 tool calls. Stop reading and
    > write the report once you have enough evidence for your findings; a shorter review with
    > proven findings beats an exhaustive one.

6. Keep the severity-ranked report format and the read-only constraint — those are working.

Acceptance: reviewer turns/task falls from 54 median 53; `tools/msg` rises for reviewer/GLM from
1.52. Note honestly that reviewer/`OpenAI Sol` will not batch (§2.6) — for that profile the win
comes only from the budget and the no-re-read rule.

### WS-5 — Delete the dead reviewer rules directory

`~/.roo/rules-code-reviewer/` (39,212 B) is not loaded for slug `reviewer` and belongs to the
retired `rooveterinaryinc.roo-cline` install. Delete it, or move anything still wanted into the
mode's `customInstructions` (currently empty) — where it will actually be read. Do **not** simply
rename it to `rules-reviewer`: that would add 39 kB to every reviewer turn, which is the opposite
of the goal.

Consider a diagnostic in the extension: when a `rules-<slug>` directory exists whose slug matches
no configured mode, log a warning. This trap is silent today and cost real steering effort.

### WS-6 — Cut the orchestrator's fixed overhead (medium)

Branch: `perf/orchestrator-payload`

- `environment_details` in orchestrator mode is 6,263 chars vs 1,365 elsewhere. The orchestrator
  delegates; it does not need the full recursive file listing. Trim it.
- Revisit the code↔reviewer 1:1 pairing in the orchestrator's `customInstructions`
  (`packages/types/src/mode.ts:150-246`). 24 reviewer subtasks for 26 code subtasks in a single
  run is a doubling of fixed overhead. Reviewing _batches_ of related slices, or reviewing once at
  the end of a phase, would cut subtask count roughly in half at a modest recall cost.
- Re-examine `rules.ts` (1,786 tokens, the largest section) for content that is dead under native
  tool calling.

### WS-7 — Settings (user-side, zero code)

- Turn on `alwaysAllowWrite` for the workspaces where the user already auto-approves execute.
  Auto-approving _execute_ but not _write_ is the wrong way round on a risk basis and costs
  195 waits > 60 s.
- Close finished tasks. 87.3% of measured "duration" is an open tab.
- Keep `deferredTools: true` — it is free (§2.4).

### WS-8 — Z.ai cache probe (prerequisite for judging WS-1)

Still open from the July plan. Run with `ROO_LOG_RAW_USAGE=1` and inspect
`prompt_tokens_details` on a task with a stable prefix (i.e. **after** WS-1). Until then, we know
the client makes caching impossible; we do not know what Z.ai would give us if it were possible.

---

## 5. Suggested order

1. **WS-1** — everything else is measured against a moving baseline until this lands
2. **WS-5**, **WS-7** — zero-risk, immediate
3. **WS-4** — prompt-only, directly answers the reviewer complaint
4. **WS-2**, **WS-3** — prompt-only, measurable with the existing agent-bench
5. **WS-8** — after WS-1
6. **WS-6** — largest design surface, do last

## 6. Open questions

- Does Z.ai's coding plan report `cached_tokens` at all? (WS-8)
- Is `OpenAI Sol`'s hard 1.00 tools/msg a Responses-API constraint or a model policy? If the
  former, there may be a request-shape fix; if the latter, only turn-reduction helps. Worth one
  probe before assuming it is immovable.
- Would a monotone cleared-set (WS-1 option 2) degrade long-task recall enough to matter? The
  measured alternative is that the model loses and regains the same content every turn, so the
  bar is low — but this needs a real long-task comparison, not an assertion.
