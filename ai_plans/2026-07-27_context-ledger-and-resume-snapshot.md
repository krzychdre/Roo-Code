# Typed context ledger + semantic resume snapshot — measured evaluation and plan

Date: 2026-07-27
Scope: post-implementation review of the turn-economics phase, two recommendations
Baseline: `main` @ `67fc3d2f0`
Corpus: **563 task directories, 7.6 GB** in
`~/.config/Code/User/globalStorage/qub-it.tumble-code/tasks` (full store, not a sample)
Predecessor: `ai_plans/2026-07-27_verbosity-and-turn-economics.md` (all workstreams merged)

Measurement scripts: `/tmp/ledger_measure.py`, `/tmp/ledger_measure2.py`, `/tmp/err_probe.py`
(throwaway, same convention as the predecessor plan).

---

## 0. Verdict in one paragraph

Both review findings are **correct, and both are measurable in the store**. Finding 1 understates
the problem: `MICROCOMPACT_KEEP_RECENT = 5` is not merely "importance-unaware", it is _inversely_
correlated with importance — **66.3%** of the five protected slots hold results under 2 KB
(results that were never a context cost), while **84.8%** of failed tool results are cleared by
the same rule that clears a 192 KB listing, and failures are **10.4× smaller** than successes
(median 123 vs 1,275 chars): the cheapest thing to keep is the most expensive thing to lose.
Finding 2 is confirmed by the resume path re-sending **7.48 M tokens** across 119 resume events
purely to restart paused tasks (median first request **43,953** tokens, p90 134,948, max 384,004),
with **90%** of resumes producing a first request _larger_ than the last request before the pause.
One design serves both: a deterministic, no-LLM **typed state ledger** that microcompaction
consumes as a protection policy, condense consumes as a critical-fact checklist, and resume
consumes as the semantic snapshot. Deterministic derivation is what neutralises the review's own
stated risk — a classifier that cannot hallucinate cannot misclassify beyond its rules, and every
rule here degrades toward "reclaim less", never toward "lose data".

---

## 1. Evidence

### 1.1 Tool-result size distribution (16,649 compactable results)

| tool                  |     n | median |    p90 |         max |   total |
| --------------------- | ----: | -----: | -----: | ----------: | ------: |
| `read_file`           | 6,896 |  3,600 | 17,309 |     156,950 | 55.9 MB |
| `execute_command`     | 4,547 |    872 |  6,630 |      50,152 |  9.7 MB |
| `search_files`        | 1,974 |    972 | 10,960 | **192,018** |  9.3 MB |
| `codebase_search`     |   439 | 13,296 | 22,143 |      31,177 |  5.9 MB |
| `read_command_output` |   160 |  1,593 | 45,141 |     140,824 |  1.8 MB |
| `list_files`          |   658 |    388 |  6,473 |      25,256 |  1.3 MB |
| `apply_diff`          | 1,197 |    421 |    501 |      22,532 |  0.9 MB |

Within the single `COMPACTABLE_TOOL_NAMES` class the spread is
`p10=197 · p25=412 · median=1,563 · p75=5,340 · p90=12,053 · p99=57,388 · max=192,018` — a
**~1000× range that the current count-based rule treats as identical**.

- Results **< 2 KB: 55.2% of items but only 6.96% of the bytes.**
- Results **≥ 20 KB: 4.5% of items carrying 38.9% of the bytes.**

This is the review's "test result vs. huge listing" stated exactly: half the items are free to
keep, and a twentieth of them are the entire problem.

### 1.2 What the five protected slots actually hold (1,750 sampled slots)

- median slot = **980 chars**, p90 = 7,695
- **66.3% of slots hold < 2 KB** — two thirds of the protection budget is spent on results that
  cost nothing to retain and nothing to reclaim.
- The largest single kept slot is **median 45.5% / p90 70.2%** of all kept bytes. A count-based
  cap therefore bounds _nothing_: one recent `search_files` can hold more context than the other
  four slots combined, and a count of 5 can mean 3 KB or 250 KB.

### 1.3 Importance is inverted, not merely absent

|                     | cleared by keep-5 | kept by keep-5 |
| ------------------- | ----------------: | -------------: |
| failed tool results |    **28 (84.8%)** |              5 |

Median size: **errors 123 chars, successes 1,275 chars (10.4× larger)**.
(n=33 in the keep/clear split, n=61 overall — small, so treat the _ratio_ as directional; the
structural point does not depend on n: the rule provably has no term that could distinguish them.)

**Implementation-relevant discovery.** `is_error` is almost never present in the _stored_ history:
22 of 5,414 tool results in a 250-task probe. Failures actually arrive as structured payloads and
text:

```
{"status":"error","message":"The tool execution failed","error":"..."}   ← most common
{"status":"denied","message":"The user denied this operation."}
Error: anchor_line must be a 1-indexed line number (got 0). …
<error_details> No sufficiently similar match found (88% similar, need …
File: tests/unit/conftest.py Error: ENOENT: no such file or directory …
```

So error classification **must parse content shape**, not just the `is_error` flag. Any design
that trusted `is_error` alone would have been a no-op in practice — this is why the flag is used
as one signal among several in §2.2.

### 1.4 Re-read rate (the review's `reread rate` metric, current baseline)

9,306 read-ish calls, 5,175 distinct targets → **44.4% reread rate**; **11.3% of all reads** are
re-reads of a path last touched more than five tool results earlier — exactly the window the
keep-5 rule clears. This is the baseline the change must not worsen.

### 1.5 Condense reach

Only **21 of 563 tasks (3.7%)** ever produced a summary. Condensation is rare; microcompaction and
truncation carry the load. Consequence for sequencing: the microcompaction policy is where the
quality is won or lost, and the condense-validation work (WS-3) is comparatively low-yield —
correct, but not the priority.

### 1.6 Resume cost (119 events, 68 tasks)

- First request after resume, true context size (`tokensIn + cacheReads + cacheWrites`):
  **median 43,953 tok · p90 134,948 · max 384,004**
- **7.48 M tokens** re-sent purely to restart paused tasks.
- **70 of 78** resumes with a comparable predecessor produced a first request **larger** than the
  last pre-pause request — resuming _grows_ the context; nothing about it is a restart.
- 13 tasks both condensed and resumed.

`resumeTaskFromHistory()` reloads the entire `apiConversationHistory` and appends a resumption
user message. There is no semantic snapshot anywhere in the codebase. The review is right that
checkpoints protect files but not execution state.

---

## 2. Design

### 2.1 One ledger, three consumers

```
                    ┌──────────────────────────────┐
  api history ────► │  buildContextLedger()        │  deterministic, no LLM
  todoList     ───► │  src/core/context-management │
  fileTracker  ───► │  /ledger/                    │
                    └──────────────┬───────────────┘
                                   │ LedgerFact[]
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
 adaptive microcompact      condense fact-check         resume snapshot
 (protect + byte budget)    (critical facts survive)    (versioned, hash-bound)
```

The six fact classes map 1:1 onto the review's list and are all derivable **without a model call**:

| review term         | class         | deterministic source                                                 |
| ------------------- | ------------- | -------------------------------------------------------------------- |
| cel                 | `goal`        | first user message (task text)                                       |
| decyzje             | `decision`    | `Task.todoList` (`update_todo_list` state)                           |
| zmienione pliki     | `file_change` | `write_to_file` / `apply_diff` / `apply_patch` / `edit*` tool inputs |
| nierozwiązane błędy | `open_error`  | failed `tool_result` with no later success on the same target        |
| wyniki walidacji    | `validation`  | `execute_command` results matching test/build/lint shapes            |
| cytowalne artefakty | `artifact`    | file paths read, checkpoint hash, workspace hash                     |

### 2.2 Adaptive microcompaction (replaces keep-5)

Selection becomes a three-term policy over the same encounter-ordered list, evaluated newest-first:

1. **Byte budget, not count.** Keep newest results until a `keepBudgetTokens` cap
   (default derived from the context window, floor `MICROCOMPACT_MIN_KEEP = 2`). Directly fixes
   §1.2: the window's cost is bounded instead of its cardinality.
2. **Reclaim floor.** Never clear a result smaller than `MICROCOMPACT_CLEAR_FLOOR_CHARS`
   (default 2,000 ≈ the placeholder's own length plus headroom). §1.1 says this exempts 55.2% of
   items while forfeiting 6.96% of reclaimable bytes — and the placeholder is 108 chars, so
   clearing a 200-char result reclaims ~0 tokens while destroying a fact.
3. **Importance protection.** A result the ledger marks `open_error` or `validation` is protected
   _while it stays under the floor-scaled cap_ (`MICROCOMPACT_PROTECT_MAX_CHARS`, default 8,000),
   so a 140 KB failing-build log is still clearable but a 123-char failure is not.

Failure mode by construction: every term can only move an item from "cleared" to "kept", so the
worst case is **less reclaim**, never lost data — and storage stays pristine regardless, because
this only chooses ids for the existing non-destructive send-time strip.

Simulation on the corpus (§A4 of `ledger_measure.py`): reclaim ratio moves 93.5% → 76.1% while
**96% of tasks retain more raw working set**. That trade is the point — the residual 17 points
are the small, cheap, high-signal results the current rule throws away for ~7% of the bytes.

### 2.3 Condense critical-fact validation

After `summarizeConversation()` returns, check the summary text against the ledger's critical
facts (`goal`, `open_error`, `file_change`). Missing facts are **appended as a deterministic
addendum**, never a retry or a failure — a weak model that writes a poor summary still gets a
correct one, at zero extra model calls.

### 2.4 Versioned semantic execution snapshot

Written next to the task (`execution_snapshot.json`), bound to `checkpointHash` +
`workspaceHash`, `version`-tagged. `resumeTaskFromHistory()` prefers it when the binding still
holds and falls back to today's behaviour when it does not (stale, missing, or version mismatch)
— the review's "stary snapshot po ręcznych zmianach" risk is handled by invalidation, not by trust.

---

## 3. Workstreams and branches

| WS   | branch                          | content                                                 |
| ---- | ------------------------------- | ------------------------------------------------------- |
| WS-1 | `feat/context-ledger`           | ledger module + tests + this plan (no behaviour change) |
| WS-2 | `feat/adaptive-microcompaction` | byte budget + reclaim floor + protection; telemetry     |
| WS-3 | `feat/condense-fact-validation` | critical-fact addendum on condense output               |
| WS-4 | `feat/resume-semantic-snapshot` | snapshot write at checkpoint, hash-bound resume         |

Stacked in order (they overlap in `context-management/` and `task/`).

## 4. Metrics (the review's own list, wired where they are cheap)

- **reclaim ratio** — `microcompactTokensCleared / pristineTokens`, already computable in
  `TaskContextManager`; expose in the microcompaction telemetry event.
- **reread rate** — baseline 44.4% / 11.3% post-gap (§1.4); re-run `ledger_measure2.py` after a
  week of use.
- **first-turn tokens after resume** — baseline median 43,953 (§1.6).
- **condensation cost vs. saved tokens**, **post-condense regressions** — deferred: at 3.7% task
  reach (§1.5) the sample cannot support a conclusion yet.
