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

### 2.2 Adaptive microcompaction (replaces keep-5) — as implemented

The first draft of this section proposed keeping the newest results up to a fixed
`keepBudgetTokens` cap. That was wrong in a way the implementation exposed: a _fixed_ keep budget
still clears the same bytes whether the turn is 200 tokens over the line or 80,000, so it pays the
full quality cost of the biggest possible strip on every trip over the threshold. What shipped is
**need-adaptive**: the pass computes how far the turn is over the ceiling and clears only enough to
get under it.

1. **Target derived from the actual overage.** `microcompactTargetChars(over)` converts the token
   overage against `min(condense ceiling, allowedTokens)` into a char target,
   `ceil(over × MICROCOMPACT_TARGET_MARGIN × MICROCOMPACT_CHARS_PER_TOKEN)`. `MARGIN = 1.1` buys a
   turn of headroom so the gate does not re-trip immediately. `CHARS_PER_TOKEN = 2.5` is
   **measured, not guessed**: 4,638 tool results across 188 tasks tokenize at an aggregate 3.764
   `o200k_base` chars/token, and the pipeline multiplies raw counts by `TOKEN_FUDGE_FACTOR = 1.5`,
   so 3.764 / 1.5 = 2.509 is the conversion the rest of the stack actually believes.
2. **Oldest-first, as a prefix.** Selection walks the encounter-ordered candidate list from the
   front and stops the moment the target is met, leaving `MICROCOMPACT_MIN_KEEP = 3` newest
   results untouched. Clearing a _prefix_ is what keeps the first differing byte as late in the
   conversation as possible, which is the only shape a provider prompt cache can survive.
3. **Reclaim floor.** Never clear a result smaller than `MICROCOMPACT_CLEAR_FLOOR_CHARS` (2,000).
   §1.1 says this exempts 55.2% of items while forfeiting 6.96% of reclaimable bytes — and the
   placeholder is **112 chars**, so clearing a 200-char result reclaims ~0 tokens while destroying
   a fact. The floor is the one term that is never released.
4. **Importance protection, with an escape hatch.** Pass 1 skips any candidate the ledger marks
   critical (`open_error` / `validation`) while it stays under `MICROCOMPACT_PROTECT_MAX_CHARS`
   (8,000), so a 123-char failure is protected but a 140 KB failing-build log is not. If the target
   is still unmet after pass 1, pass 2 releases protected candidates oldest-first — protection
   must not be able to force a condense, which would cost a model call and lose far more.

Two accounting details the implementation forced:

- **Everything is net of the placeholder.** Selection counts `chars - MICROCOMPACT_PLACEHOLDER_CHARS`
  toward the target, and `microcompactTokensCleared` is `gross - MICROCOMPACT_PLACEHOLDER_TOKENS ×
cleared` (45 tokens each). That net figure is exactly what `nextMicrocompactStrippedTokens()` adds
  back to reconstruct the pristine size, so a gross number there would re-introduce the oscillation
  the previous phase fixed.
- **The cleared set may only ever grow.** `TaskContextManager` replaces `microcompactedToolUseIds`
  wholesale each turn, so a _smaller_ target on a later turn could otherwise re-inflate a result
  that was already stripped — moving the first differing byte backwards and voiding the cache.
  The previous pass's ids are threaded in as `previouslyClearedToolUseIds` and unioned in before
  any policy runs: monotonicity outranks policy.

Failure mode by construction: every term can only move an item from "cleared" to "kept" (or, in
pass 2, back to "cleared" only under budget pressure), so the worst case is **less reclaim**, never
lost data — and storage stays pristine regardless, because this only chooses ids for the existing
non-destructive send-time strip.

Simulation on the corpus (§A4 of `ledger_measure.py`): reclaim ratio moves 93.5% → 76.1% while
**96% of tasks retain more raw working set**. That trade is the point — the residual 17 points
are the small, cheap, high-signal results the current rule throws away for ~7% of the bytes.

**Measured side effect on the oscillation harness.** `microcompact-oscillation.spec.ts` used to
document the pre-fix feedback loop as a >1.3× sawtooth in sent tokens, which only held because
keep-5 dumped everything but five results on every trip. Under the need-adaptive target the strip
is much shallower, so the sawtooth's _magnitude_ disappears while the bug itself does not. Measured
over 10 turns against the real `manageContext` (30k window, 50% ceiling = 15,000 tok):

| run                      | sent tokens per turn                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| buggy (reported size)    | 12245 12738 13232 13725 14219 14712 **13782↓** 15699 **14769↓** 15262 |
| fixed (un-deflated size) | 12245 12738 13232 13725 14219 14712 **13782↓** 14275 14769 **13839↓** |

The bug's real signature is therefore not the swing size but the **breach**: the buggy run un-strips
on turn 8 and puts 15,699 tokens on the wire — above both the last full turn (14,712) and the
15,000-token ceiling the gate exists to enforce — while the fixed run never crosses it once the
strip latches. The spec now asserts that, which is a statement about the invariant rather than
about the old policy's amplitude.

### 2.3 Condense critical-fact validation — as implemented

Before the summary message is assembled, its text is checked against the ledger's critical facts
(`goal`, `open_error`, `file_change`). Missing facts are **appended as a deterministic addendum**,
never a retry and never a failure — a weak model that writes a poor summary still ends up with a
correct one, at zero extra model calls. `src/core/condense/factValidation.ts`.

**Why lexical, not semantic.** A semantic check needs a model call, which reintroduces exactly the
failure mode it is meant to guard against (§0). The check is token overlap: a fact counts as
retained when ≥ `FACT_COVERAGE_THRESHOLD` (0.5) of its _distinctive_ tokens — length ≥ 4, minus a
~50-word stopword set — appear in the summary. Half tolerates paraphrase and word-form drift
(`failed`/`failing`) while still rejecting a summary that merely name-drops a path.

**One rule, different probe text per class.** This is what makes a single threshold produce the
right strictness everywhere:

| class         | probe                           | effect                                                                                              |
| ------------- | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `goal`        | the request prose               | 50% overlap answers "is this summary about this task"                                               |
| `file_change` | the **file name only**          | one token, so it must be present; the directory prefix is noise a summary is entitled to drop       |
| `open_error`  | file/command **+ failure text** | a summary that mentions `pnpm test` but drops "3 assertions failed" lands under 0.5 and is restored |

**What survives the condense is not re-stated.** The kept raw tail is evidence too, but the two
kinds of evidence are not equally strong, and mixing them was a real bug caught by the integration
test: a `file_change` probe is a _single_ token, so matching it against a large raw tail suppresses
the fact whenever anything in the tail happens to mention the file — including a message about
something else entirely (a lint error naming `openrouter.ts` silently cancelled "openrouter.ts was
already rewritten"). So:

- a fact **derived from a tool result** is settled by `tool_use_id`: retained iff that exact result
  is still in the tail. Unfakeable, and it composes with WS-2 — those ids are precisely
  `criticalToolUseIds`, which microcompaction protects from stripping.
- a fact with **no id of its own** (`goal`, plan items) falls back to token coverage over summary +
  tail text.

**Failure modes all degrade to silence.** A fact with no distinctive tokens (`"do it now"`) is
skipped rather than guessed at; no ledger means the pass is a no-op; the addendum is capped at
`MAX_ADDENDUM_FACTS` (20) with an explicit `- (N further facts omitted for length)` line, because a
hidden cap reads as "everything was carried over". The pass can only ever ADD text.

**Shape, for a weak reader** — one heading, one instruction sentence, one fact per line, each line
prefixed with an explicit label (`GOAL`, `STILL BROKEN`, `ALREADY CHANGED`), ordered by cost of loss
(task statement → unresolved failure → completed change). No nesting, no prose to parse:

```
<system-reminder>
## Facts Carried Over From The Condensed History
The summary above did not mention the following. They are still true — treat them as part of the
summary and do not redo or contradict them.

- GOAL: Add exponential backoff to the openrouter provider
- STILL BROKEN: execute_command failed on pnpm test: Error: 3 assertions failed in backoff.spec.ts
- ALREADY CHANGED: src/api/providers/openrouter.ts (write_to_file)
</system-reminder>
```

`SummarizeResponse` now carries `factsChecked` / `factsRecovered`, so the review's "regresje po
kondensacji" metric has a cheap leading indicator: a persistently high recovered/checked ratio means
the condense prompt is losing facts, not that the validator is noisy.

### 2.4 Versioned semantic execution snapshot

Written next to the task (`execution_snapshot.json`), bound to `checkpointHash` +
`workspaceHash`, `version`-tagged. `resumeTaskFromHistory()` prefers it when the binding still
holds and falls back to today's behaviour when it does not (stale, missing, or version mismatch)
— the review's "stary snapshot po ręcznych zmianach" risk is handled by invalidation, not by trust.

---

## 3. Workstreams and branches

| WS   | branch                          | content                                                      | status |
| ---- | ------------------------------- | ------------------------------------------------------------ | ------ |
| WS-1 | `feat/context-ledger`           | ledger module + tests + this plan (no behaviour change)      | done   |
| WS-2 | `feat/adaptive-microcompaction` | need-adaptive target + reclaim floor + protection; telemetry | done   |
| WS-3 | `feat/condense-fact-validation` | critical-fact addendum on condense output                    | done   |
| WS-4 | `feat/resume-semantic-snapshot` | snapshot write at checkpoint, hash-bound resume              | todo   |

Stacked in order (they overlap in `context-management/` and `task/`).

## 4. Metrics (the review's own list, wired where they are cheap)

- **reclaim ratio** — shipped in WS-2 as `Context Microcompacted`
  (`reclaimRatio = microcompactTokensCleared / prevContextTokens`, alongside `candidates`,
  `cleared`, `protectedResults`, `releasedProtected`). `releasedProtected > 0` is the signal that
  the protection cap is set too generously for real workloads.
- **reread rate** — baseline 44.4% / 11.3% post-gap (§1.4); re-run `ledger_measure2.py` after a
  week of use.
- **first-turn tokens after resume** — baseline median 43,953 (§1.6).
- **critical facts recovered** — shipped in WS-3 as `factsChecked` / `factsRecovered` on
  `SummarizeResponse`. A persistently high ratio means the condense prompt is losing facts; a ratio
  near zero across many condenses means the addendum is dead weight and the threshold can rise.
- **condensation cost vs. saved tokens**, **post-condense regressions** — deferred: at 3.7% task
  reach (§1.5) the sample cannot support a conclusion yet.
