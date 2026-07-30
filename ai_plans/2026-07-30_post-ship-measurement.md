# Post-ship measurement: instrumenting quality, and checking whether WS-1/WS-3 landed

Date: 2026-07-30
Branch: `feat/agent-bench-quality-metrics`
Predecessor: `ai_plans/2026-07-27_verbosity-and-turn-economics.md` (WS-1…WS-8)
Scope: measurement only. No agent behaviour is changed by this branch.

## 0. Why this exists

The turn-economics stack (`f7e749a84`, PR #131) shipped six workstreams on
2026-07-27 and every one of its acceptance criteria was stated against the
pre-change baseline — the plan says so itself: _"Not yet measured"_. Five of
those six changes push the same direction: fewer turns, fewer reads, a shorter
review. That is the direction that trades quality away, and there was no metric
in the repo that could have noticed. `collect.py` measured tokens, turns, TTFT,
decode, wall clock and `environment_details` bytes — nothing about whether the
work came out right.

So the ranked plan for "what next" could not be acted on: it was ranked on
numbers describing a build that no longer exists.

This branch adds the missing instrumentation, re-measures, and reports what the
data says — including where it says the previous plan was wrong.

## 1. What was added

### `scripts/agent-bench/collect.py`

Three tables instead of one.

**Quality proxies** (new). Every signal is a deterministic marker, never a
keyword scan of tool output — test logs say "error" and "failed" constantly:

| column           | source                                                                              |
| ---------------- | ----------------------------------------------------------------------------------- |
| `tool_fail%`     | `is_error`, `formatResponse` JSON envelope (`status: error\|denied`), fixed strings |
| `thrash`         | byte-identical `tool_use` repeated in one task                                      |
| `no_tool`        | `[ERROR] You did not use a tool` reminders                                          |
| `api_err`        | `say: error` + `ask: mistake_limit_reached`                                         |
| `retries`        | `say: api_req_retry_delayed`                                                        |
| `user_int`       | `say: user_feedback` — the user had to intervene mid-task                           |
| `rej_completion` | user answered an `attempt_completion` instead of accepting it                       |
| `done`           | the task reached a completion at all                                                |
| `subtasks`       | `new_task` + `run_parallel_tasks`                                                   |

**Acceptance criteria** (new): `whole%`, `re-read%`, `exact-dup%`, `osc`,
`drops`, `max_drop%`, `first_in`, `max_in`, `condense` — the WS-1 and WS-3
criteria, computed rather than argued.

**Window and grouping flags** (new): `--since` / `--until` (exclusive, so a
pre/post pair cannot double-count a task), `--config`, `--mode`, `--group-by`.
Real-work windows are how the baseline in the predecessor doc was produced; they
were previously only reachable through throwaway `/tmp` scripts.

### `scripts/agent-bench/vllm-prefix-cache-probe.mjs`

WS-8's server half, ready to run the moment the box is up. Diffs
`vllm:gpu_prefix_cache_{queries,hits}_total` (both v0 and v1 metric spellings)
around either a synthetic double request or, with `--watch`, a real multi-turn
task, and cross-checks the counters against `prompt_tokens_details.cached_tokens`
in the response body. Prints one of four verdicts, including the one that
matters most: _server caches but does not report it_ — in which case client-side
`cacheReads` is a permanent lower bound and only `/metrics` can judge WS-1.
Verified end-to-end against a fake server, including that it ignores decoy
series whose names merely start with a counter's name.

## 2. The collector reproduces the published baseline

Before trusting any new number, the new code was pointed at the window the
predecessor doc measured (`--since 2026-07-14 --until 2026-07-27`, 206 tasks).
It is an independent reimplementation, so agreement is evidence both are right:

| quantity               | predecessor doc | this collector           |
| ---------------------- | --------------- | ------------------------ |
| tools/turn, code+GLM   | 1.30            | 1.34 (all GLM modes)     |
| multi-tool turn share  | 20%             | 21%                      |
| same-path re-read      | ~52%            | 52%                      |
| exact duplicate reads  | 2%              | 2%                       |
| oscillation events     | 827             | 842                      |
| fixed per-turn payload | ~20.6 k         | 18.7 k median `first_in` |

The oscillation detector is the important one: 842 vs 827 events, arrived at
from a different definition (an unexplained ≥20% shrink followed by a ≥20%
rebound, `condense_context` events excluded) than the original ad-hoc script.
The defect RC-1 described was real and is now measurable from the repo.

## 3. WS-1 works — and its acceptance criterion was wrong

WS-1's criterion #1 was _"a monotonically non-decreasing `tokensIn` sequence
apart from genuine `condense_context` events"_. **That is unachievable by
design.** Microcompaction is non-destructive: it strips the outgoing copy, so
the provider measures — and the client records — a smaller number for that
request. One legitimate strip therefore produces one legitimate drop. The
defect was never the drop; it was the _rebound_.

The corrected criterion is `osc = 0`: no drop-then-rebound pairs. `collect.py`
reports both, so the distinction is visible rather than assumed.

Measured on the confirmed post-fix build, task `c83b921d` (74 requests):

```text
req 26..36:  120,178  124,626  130,364  133,094  45,121  45,868  45,081  41,763  46,382  42,962  45,450
req 50..66:   40,187   38,479   50,791  251,396  53,792  54,347  55,058  43,452  45,174  42,874  43,203 …
```

Both strips **stick**: after 133 k → 45 k the series stays in the 41–46 k band
for the next seven turns, and after the 251 k spike it settles at 43–55 k. Before
the fix the same shape alternated 222 k ↔ 92 k for 30 consecutive requests.

Per-task rate on the one profile present in both windows (`OpenAI Sol`):

| window             | tasks | osc events | osc/task |
| ------------------ | ----- | ---------- | -------- |
| 2026-07-14 … 07-27 | 57    | 524        | 9.2      |
| 2026-07-27 …       | 15    | 2          | 0.13     |

Both residual events are in tasks whose largest context was 66 k and 59 k —
far below any threshold microcompaction could have tripped, so neither is the
RC-1 defect. They are also in the 21:xx group whose build provenance is
uncertain (§5).

## 4. WS-3 moved, but not for the reason the plan assumed

Same profile, same definitions, pre → post: reads that fetch a whole file rose
**7% → 57%**, and same-path re-reads fell **58% → 25%** (n = 109 reads across 15
tasks — direction, not a delta).

The more useful finding is about the metric itself. WS-3's criterion was _"share
of reads using the 2000-line default window rises from 11.8%"_, on the premise
that small windows are model-chosen. Across the whole store, by profile:

| profile           | reads | omits `limit` | whole-file (omit or ≥2000) |
| ----------------- | ----: | ------------: | -------------------------: |
| GLM-5.2 (July)    | 2,964 |      **0.0%** |                      18.5% |
| OpenAI Sol (July) | 1,798 |      **0.0%** |                      10.0% |
| Nemotron 3 Ultra  |   324 |     **76.5%** |                      77.2% |

GLM-5.2 and Sol never once omitted the parameter, across 4,762 calls, while
Nemotron omitted it three times out of four **against the same schema on the
same harness**. The `read_file` schema is declared `strict: true`, so on the
profiles that honour strict function calling the model cannot express "omit
this" at all — it can only pass an explicit value. "Share of reads that omit
`limit`" was therefore never a measure of what the model wanted; it was a
measure of which serving path it was on.

The robust definition — `limit` omitted **or** ≥ 2000 — is what `whole%` now
reports, and it is the one that moved.

## 5. Build provenance, and why the post window is thin

WS-6 introduced a fixed string, `FILE_DETAILS_UNCHANGED_NOTE`, emitted only when
a workspace listing repeats identically. Its presence proves the running build
included the stack; its absence proves nothing (a task without a repeated
listing would never emit it). It first appears in a task started **2026-07-27
23:03**, so the fixed build was live by then. The four tasks between 21:21 and
21:46 may predate the install — including `f4bf841f`, which carries 4 of the 12
residual drops.

The post window is 15 tasks and **all 15 are `OpenAI Sol`**. There is not one
GLM-5.2 task after the stack landed, because the vLLM box has been down. So:

- WS-1 is validated on Sol, which is the profile that reports cache reads
  (34.7%) and therefore the one where prefix stability is visible at all.
- WS-2 and the `rules.ts` bullet are **unvalidated and unmeasurable** here. Sol
  emits 1.00 tools/turn regardless of prompt (0% multi-tool in both windows, as
  before). Running the batching workstreams on Sol and seeing no change is a
  false negative, not a result.
- WS-8's server half is untouched: it needs the machine.

## 6. Quality baseline (first ever recorded)

Window 2026-07-14 … 07-27, so this is the pre-stack reference every future
efficiency change must be compared against:

| profile    | tasks | turns | tool_fail% | thrash | api_err | retries | user_int | rej_completion | done |
| ---------- | ----: | ----: | ---------: | -----: | ------: | ------: | -------: | -------------: | ---: |
| GLM-5.2    |   146 | 5,213 |         2% |     80 |      10 |      59 |      135 |             81 |  127 |
| OpenAI Sol |    57 | 4,816 |         6% |    151 |      22 |      14 |       20 |             11 |   51 |

Two things stand out and neither is explained yet:

- **Sol's `tool_fail%` is three times GLM's** (6% vs 2%) and it thrashes twice
  as much in absolute terms on a third of the tasks. Worth a look on its own
  terms; it is not something any of WS-1…WS-8 addresses.
- `rej_completion` is 81 across 146 GLM tasks. The metric counts follow-ups as
  well as pushback, so it is not a defect count — but as a comparison baseline
  it is the sharpest signal on disk, and it is exactly the number that a
  turn-cutting change would be expected to worsen.

Post-window quality (Sol, 15 tasks): `tool_fail%` 2%, thrash 3, `user_int` 1,
`rej_completion` 0, done 10/15. Nothing regressed, but n is far too small to
call it evidence.

## 7. What this changes about the plan

1. **WS-1: done and verified.** Update its acceptance criterion in the
   predecessor doc from "monotone `tokensIn`" to "`osc = 0`".
2. **WS-3: directionally confirmed on Sol**, with a corrected metric. The
   original 11.8% figure should not be quoted again.
3. **WS-2 and the `rules.ts` change remain unvalidated.** They cannot be
   validated on any profile currently reachable.
4. **The "deferred tools by default" item is not a cost lever.** Unchanged from
   the earlier analysis and worth restating because it keeps being ranked high:
   deferred tools defer MCP/custom tools only, `tools_load` is 0.4% of turns,
   and 11.5 k of the ~20 k fixed payload is native schemas it cannot touch.
5. **A read-dedup change must be range-aware.** `exact-dup%` is 2% and already
   handled; the 52% is same-path-different-range. Deduplicating "unchanged
   reads" as literally described would be a no-op.
6. **Ranking by measured multiplier, the subagent-tree budget is first, not
   last.** 118 subtasks from 13 parents, one run at 50 subtasks / 3,265 turns /
   $251, each subtask re-paying the full fixed prompt. But it is also a hard cap
   on how much work an agent may do, so it is a quality trade and belongs behind
   a measurement, not in front of one.

## 8. Next steps, in order

1. **2026-07-31, when the vLLM box is up:**
   `node scripts/agent-bench/vllm-prefix-cache-probe.mjs --watch` around a real
   multi-turn GLM task, then `collect.py --recent 1`. This settles the open
   question of whether the server caches, whether it reports, and what WS-1
   actually bought on local hardware — where the saving is prefill time on a GPU
   that is also decoding, not money.
2. **Matched GLM run of the five fixed tasks** (README protocol) on this build.
   That is the only way WS-2 / WS-3 / the `rules.ts` bullet become results
   instead of arguments, and it produces the first post-stack quality row for
   the profile that is actually the daily driver.
3. Only then re-rank the remaining workstreams. Nothing on the current list is
   blocked by code; it is blocked by not knowing.

## 9. Deliberately not done

- No change to any prompt, tool description, mode definition, or context
  behaviour. This branch cannot alter how the agent works.
- The reviewer's `Aim to finish in under 25 tool calls` budget was left in
  place. It is the shipped change most likely to cost review depth, but it lives
  in the user's `custom_modes.yaml`, and with zero post-stack reviewer tasks on
  GLM there is nothing to justify moving it in either direction yet. Flagged
  here so it is not forgotten: `ai_plans/assets/reviewer-mode.yaml:46`.
