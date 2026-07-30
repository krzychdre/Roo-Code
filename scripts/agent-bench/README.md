# agent-bench — agent-loop efficiency benchmark

Measures how efficiently a model+harness combination completes a fixed set of
tasks. Used to gate the efficiency workstreams in
`ai_plans/2026-07-12_glm-agent-loop-efficiency-implementation.md`.

## Protocol

1. Build + install the extension from the branch under test.
2. In a clean VS Code window on this repo, run each task below **once**, in a
   fresh Roo task, with the profile under test (e.g. `GLM-5.2`). Do not
   intervene unless the task stalls; auto-approve settings identical across runs.
3. Note each task ID (visible in task history), then run the collector:

    ```bash
    python3 scripts/agent-bench/collect.py <taskId> [<taskId> ...]
    # or the N most recent tasks:
    python3 scripts/agent-bench/collect.py --recent 5
    ```

4. Paste the emitted markdown tables into the PR description next to the
   baseline numbers.

Run the full set twice per branch (variance on GLM is real); report both.

To measure a whole period of real work instead of the fixed set — which is how
the numbers in `ai_plans/2026-07-27_verbosity-and-turn-economics.md` were
produced — use the date window and grouping flags:

```bash
# everything since a change landed, one row per profile
python3 scripts/agent-bench/collect.py --since 2026-07-27 --group-by config
# the window before it, same definitions on both sides (--until is exclusive)
python3 scripts/agent-bench/collect.py --since 2026-07-14 --until 2026-07-27 --group-by config
```

A real-work window is task-mix dependent, so treat it as a direction, not a
delta — and always read the quality table next to the efficiency one.

## Fixed tasks

| #   | Size | Mode      | Prompt                                                                                                                                                                                   |
| --- | ---- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | S    | code      | `What does getEnvironmentDetails include in each message and which settings control it? Answer only, do not modify anything.`                                                            |
| 2   | M    | code      | `In src/core/prompts/sections/modes.ts there is a formatting inconsistency: find any mode listed without its whenToUse description and make the output uniform. Small, surgical change.` |
| 3   | M    | code      | `Add a unit test for formatResponse.noToolsUsed covering its exact text, in the existing formatResponse test file.`                                                                      |
| 4   | L    | code      | `Add an optional "maxLines" parameter to the list_files tool that caps returned entries, wired through schema, tool, and one test.`                                                      |
| 5   | L    | architect | `Plan and then implement (switching modes yourself) a --json flag for scripts/find-missing-translations.js.`                                                                             |

Tasks 2–5 must be run on a throwaway branch; reset the working tree between runs
(`git checkout -- . && git clean -fd` scoped to the touched paths).

## Metrics reported per task

`collect.py` prints three tables. Read them together: on their own, every
efficiency column rewards doing less work, and doing less work is trivially
achievable by doing the task badly.

### Efficiency — what it cost

- API turns, tool calls, tools/turn, share of multi-tool turns
- input/output tokens per turn, cacheReads
- reasoning chars per turn
- TTFT and decode seconds per turn (from ui_messages timestamps)
- total wall-clock, environment_details bytes

### Acceptance criteria — did WS-1 / WS-3 land

- `whole%` — reads that omit `limit` or ask for ≥ 2000 lines (WS-3). Note that
  some profiles never omit a parameter at all, so this can only move via an
  explicit large `limit`; do not read a low `whole%` as "the model ignored the
  tool description" without checking whether it ever omits anything.
- `re-read%` / `exact-dup%` — reads of a path already read in this task, and the
  subset that repeats the identical range. The gap between them is the paging
  behaviour RC-3 describes; only the `exact-dup%` part is what a naive read
  cache would remove.
- `osc` / `drops` — shrinks in reported `tokensIn` that no `condense_context`
  explains. `drops` counts every one; `osc` counts only a drop followed by a
  rebound. **`osc` is the WS-1 criterion, not `drops`** — non-destructive
  microcompaction legitimately makes one request report smaller and keeps it
  that way, so a monotone series was never achievable. A drop that rebounds is
  the defect; a drop that sticks is the fix working.
- `first_in` / `max_in` — fixed per-turn payload proxy, and the largest context
  the task reached. `max_in` is what tells you whether microcompaction had any
  chance to fire: `osc = 0` on a task that never passed the threshold proves
  nothing.

### Quality proxies — did the work come out right

Counts, not rates, except `tool_fail%`:

- `tool_fail%` — tool results the harness itself reported as failed or denied.
  Detected from `is_error`, the `formatResponse` JSON envelope
  (`status: error|denied`), and the fixed strings in `src/core/prompts/responses.ts`.
  Arbitrary output is **not** keyword-scanned: test logs say "error" and
  "failed" constantly and would swamp the signal.
- `thrash` — byte-identical tool calls repeated within one task.
- `no_tool` — `[ERROR] You did not use a tool` reminders (a weak-model signal).
- `api_err` / `retries` — `error` and `mistake_limit_reached` events, and
  provider retry delays.
- `user_int` — user messages sent mid-task: the user had to intervene.
- `rej_completion` — the user answered an `attempt_completion` instead of
  accepting it silently. The closest thing to a quality verdict available on
  disk, but it counts follow-up requests as well as pushback, so read it as
  "the task was not done when the agent said it was **or** the user wanted
  more" — compare it across windows, do not treat it as a defect count.
- `done` — the task reached a completion at all.
- `subtasks` — `new_task` / `run_parallel_tasks` delegations.

An efficiency win that moves any of these in the wrong direction is not a win.

## Prefix-cache probes

- `vllm-prefix-cache-probe.mjs` — for the self-hosted vLLM server. Diffs
  `vllm:gpu_prefix_cache_{queries,hits}_total` from `/metrics` around either a
  synthetic double request or (with `--watch`) a real task, and cross-checks
  against `prompt_tokens_details.cached_tokens` in the response body. `/metrics`
  is authoritative: a server can serve hits and never report them.
- `zai-cache-probe.mjs` — the same question for a hosted Z.ai endpoint.

## Separation experiment (model vs harness)

Run the same 5 tasks with a Claude profile (Sonnet or Opus) on the same branch
and compare turns/task and s/turn against GLM-5.2. Record results in the
implementation plan doc.
