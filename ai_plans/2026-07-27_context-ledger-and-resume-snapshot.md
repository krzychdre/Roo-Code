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
 (protect + byte budget)    (critical facts survive)    (recomputed, mtime-bound)
```

The six fact classes map 1:1 onto the review's list and are all derivable **without a model call**:

| review term         | class         | deterministic source                                                               |
| ------------------- | ------------- | ---------------------------------------------------------------------------------- |
| cel                 | `goal`        | first user message (task text)                                                     |
| decyzje             | `decision`    | `Task.todoList` (`update_todo_list` state)                                         |
| zmienione pliki     | `file_change` | `write_to_file` / `apply_diff` / `apply_patch` / `edit*` tool inputs               |
| nierozwiązane błędy | `open_error`  | failed `tool_result` with no later success on the same target                      |
| wyniki walidacji    | `validation`  | `execute_command` results matching test/build/lint shapes                          |
| cytowalne artefakty | `artifact`    | file paths read (paths only — the hashes in the first draft went unused, see §2.4) |

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

### 2.4 Semantic execution snapshot on resume — as implemented

`src/core/context-management/executionSnapshot.ts`, wired into `TaskResumption` as Step 7 of
`resumeTaskFromHistory()` (Step 8 is the existing save). The review asked for a versioned snapshot
**written at checkpoint time and bound to workspace/checkpoint hashes**. Two of those three parts
did not survive contact with WS-1, and the reasons are worth recording because they are the whole
justification for the deviation.

**Why it is recomputed, not persisted.** Writing a snapshot only pays off when producing it is
expensive. After WS-1 it is not: `buildContextLedger()` is a deterministic function of the history
that is already on disk, with no model call. Persisting it would buy a few milliseconds and cost a
second source of truth to keep in sync with `api_conversation_history.json`, a `version` field with
a migration path behind it, and a trust question on every read. Recomputing at resume has none of
those: it cannot drift, cannot be stale relative to the history, and cannot need a migration. The
version constant is still emitted in the rendered header (`## Execution Snapshot (v1)`) so a
transcript says which format produced it — but nothing reads it back, so there is no compatibility
surface to own.

**Why per-file mtimes, not a workspace hash.** The review's risk — "stary snapshot po ręcznych
zmianach" — is real, but it is a property of the _workspace_, not of the snapshot. A repo-wide or
checkpoint hash can only report that _something_ moved, which on a busy repo is almost always true
and therefore almost always discards a good snapshot. `detectStaleFileChanges()` instead stats the
ledger's own `file_change` subjects (deduped, capped at `MAX_STALE_CHECK_FILES = 40`) against the
task's last activity plus `STALE_MTIME_GRACE_MS = 5,000` of slack for our own write flushes. That
is strictly more informative — it names _which_ of our files moved — needs no git, and works when
the checkpoint service is unavailable, which is not an edge case: checkpoints are disabled outright
when git is missing. `ENOENT` is reported as `removed`, because a file we created that is now gone
is precisely the case where "already changed, do not redo" would send the agent the wrong way; any
other stat error stays silent, since a permissions failure says nothing about the content.

**When it applies.** Three gates, each of which returns the input array _by reference_ so that a
declined snapshot is byte-for-byte today's behaviour:

1. `RESUME_SNAPSHOT_MIN_CHARS = 60,000` of effective history (~15k tokens at the stack's own
   2.5 chars/token, comfortably under the §1.6 median of 43,953). Measured in characters so the
   gate stays synchronous and free — no tokenizer, no API handler. Short tasks are never touched.
2. A safe tail boundary from `computeCondenseKeepBoundary(messages, RESUME_KEEP_RECENT_MESSAGES=4)`
   — the existing logic that guarantees a kept tail never splits a `tool_use`/`tool_result` pair.
   Its "no tail" answer (`boundary >= messages.length`) is treated as a **skip, not as more
   aggressive compression**: the single most common resume is an interrupted tool call, and hiding
   the assistant message that holds the pending `tool_use` would leave the resumption's
   `tool_result` with nothing to answer. Four rather than condense's six because the snapshot
   already carries the state; the tail exists only as that anchor.
3. A ledger with at least a goal or one fact — otherwise hiding history is a pure loss.

**How it applies.** Non-destructively, reusing the condense tagging: hidden messages get a
`condenseParent` (an existing parent is never overwritten), the snapshot is a `user` message with
`isSummary` + `condenseId`, and `getEffectiveApiHistory()` does the filtering at send time. Nothing
is deleted, so rewind and the UI transcript are unaffected — the full history remains reachable,
which is the "z możliwością sięgnięcia do pełnej historii" half of the recommendation.

**Shape, for a weak reader** — flat headings, one item per line, and the instruction sitting next
to the facts it governs rather than in a preamble, so a model that only skims headings still comes
away with the two things that change its next action:

```
## Execution Snapshot (v1)

This task was interrupted and has now been resumed. …Continue the task from here; do not start it over.

### Goal
This is what the user originally asked for. It has not changed.
Add exponential backoff to the openrouter provider

### Already changed
These edits are already on disk. Do NOT make them again.
- src/api/providers/openrouter.ts (write_to_file)

### Still broken
These failures had no later success. The task is not finished while they stand.
- execute_command failed on pnpm test: Error: 3 assertions failed in backoff.spec.ts

### Changed outside this task while it was paused
These files no longer match what this task left on disk, …re-run the validations above rather than trusting their results.
- src/api/providers/openrouter.ts (modified)
```

Empty sections are omitted; overflow past `MAX_SNAPSHOT_SECTION_ITEMS = 20` is reported as
`- (N more, omitted for length)` rather than silently truncated, for the same reason as WS-3.

**Failure modes.** Every one degrades to a full replay, never to lost history. A staleness check
that throws costs only the warning section — the snapshot still applies (a broken `cwd` must not
cost the optimisation); anything else throwing inside Step 7 returns the untouched history and the
resume proceeds exactly as before. Both paths are pinned by tests in
`core/task/__tests__/TaskResumption.snapshot.spec.ts`.

---

## 3. Workstreams and branches

| WS   | branch                          | content                                                      | status |
| ---- | ------------------------------- | ------------------------------------------------------------ | ------ |
| WS-1 | `feat/context-ledger`           | ledger module + tests + this plan (no behaviour change)      | done   |
| WS-2 | `feat/adaptive-microcompaction` | need-adaptive target + reclaim floor + protection; telemetry | done   |
| WS-3 | `feat/condense-fact-validation` | critical-fact addendum on condense output                    | done   |
| WS-4 | `feat/resume-semantic-snapshot` | snapshot recomputed at resume, mtime-bound staleness warning | done   |

Stacked in order (they overlap in `context-management/` and `task/`).

## 4. Metrics (the review's own list, wired where they are cheap)

- **reclaim ratio** — shipped in WS-2 as `Context Microcompacted`
  (`reclaimRatio = microcompactTokensCleared / prevContextTokens`, alongside `candidates`,
  `cleared`, `protectedResults`, `releasedProtected`). `releasedProtected > 0` is the signal that
  the protection cap is set too generously for real workloads.
- **reread rate** — baseline 44.4% / 11.3% post-gap (§1.4); re-run `ledger_measure2.py` after a
  week of use.
- **first-turn tokens after resume** — baseline median 43,953 (§1.6). WS-4 logs the delta it
  achieved on each applied resume (`hiddenMessages`, `charsBefore -> charsAfter`, and whether any
  file moved during the pause), so the next re-run of the corpus script has a per-event ground
  truth to check the aggregate against rather than only the before/after distribution.
- **resume success rate / necessary re-reads** — no new instrumentation; the §1.4 reread-rate
  script already measures the behaviour the snapshot could plausibly regress (an agent that
  re-reads a file the snapshot claimed to have changed), so this rides on the same re-run.
- **critical facts recovered** — shipped in WS-3 as `factsChecked` / `factsRecovered` on
  `SummarizeResponse`. A persistently high ratio means the condense prompt is losing facts; a ratio
  near zero across many condenses means the addendum is dead weight and the threshold can rise.
- **condensation cost vs. saved tokens**, **post-condense regressions** — deferred: at 3.7% task
  reach (§1.5) the sample cannot support a conclusion yet.
