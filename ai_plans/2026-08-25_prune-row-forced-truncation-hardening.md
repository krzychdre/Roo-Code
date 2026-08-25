# Prune row on the forced-truncation path (feat/27 review hardening)

Date: 2026-08-25
Branch: `feat/33-prune-row-forced-truncation` (stacked on `feat/32-search-task-history-hardening`, same pattern as the feat/31 -> feat/32 hardening round)
Source: adversarial GLM review of `feat/27-prune-before-condense` (commit 18f7f47bf)

## Verified root cause (evidence)

The prune-only outcome of `manageContext` returns `summarySkipped: true` plus
`prunedCount` and no `summary`/`truncationId`
(`src/core/context-management/index.ts:570-583`). Two callers persist that
result:

- `manageContextIfNeeded` announces it: the third branch
  `else if (truncateResult.summarySkipped && truncateResult.prunedCount)`
  emits a `context_pruned` chat row
  (`src/core/task/TaskContextManager.ts:731-757`).
- `handleContextWindowExceededError` persists the rewritten history
  (`overwriteApiConversationHistory`, line 473) but announces only
  `condense_context` or `sliding_window_truncation`
  (lines 476-508). The third branch is absent.

So on the forced path (context window already exceeded, the most likely
real-world trigger) a prune-only round moves originals into `prune-*.txt`
artifacts, rewrites the stored transcript to previews, and says nothing.
That is exactly the silent rewrite the feat/27 commit message forbids.
Review verdict CONFIRMED by direct code read; no test covers any
announcement branch of `handleContextWindowExceededError`.

## Scope of this round

### 1. Critical fix: emit `context_pruned` on the forced path

In `handleContextWindowExceededError`, after the existing
`else if (truncateResult.truncationId)` branch, add the same
`else if (truncateResult.summarySkipped && truncateResult.prunedCount)`
branch as in `manageContextIfNeeded`: build a `ContextPrune`
(`prunedCount`, `bytesSaved: prunedBytesSaved ?? 0`, `prevContextTokens`,
`newContextTokens: newContextTokens ?? 0`) and
`say("context_pruned", ...)` with the same positional-argument shape
(contextPrune is the 10th argument). Keep the comment style consistent
with the sibling branch. The spinner teardown in `finally` already
dismisses the in-progress indicator, so the row is purely additive.

### 2. Regression test for the forced path

New spec `src/core/task/__tests__/TaskContextManager.forced-prune-row.spec.ts`
mirroring `TaskContextManager.prune-row.spec.ts` but driving
`handleContextWindowExceededError`:

- prune-only outcome (mock `manageContext` to return
  `{ summarySkipped: true, prunedCount > 0, no summary, no truncationId }`):
  asserts `overwriteApiConversationHistory` was called AND a
  `context_pruned` say-row was emitted with the right `ContextPrune` payload.
- summary outcome: asserts `condense_context` row and NO `context_pruned` row.
- truncation outcome: asserts `sliding_window_truncation` row and NO
  `context_pruned` row.

This closes the review's "no test exercises the forced path's announcement
branches at all" gap, not just the new branch.

### 3. Telemetry test tightening

`src/core/condense/__tests__/condense-prune-telemetry.spec.ts`: in the
no-prune case, assert `captureContextCondensed` receives exactly 3
positional arguments (no `pruneStats` at all), so a regression that always
attaches a zeroed `pruneStats` object fails the suite.

### 4. Idempotency test note (suggestion-level)

`prune-before-condense.spec.ts` "is idempotent across rounds" proves
idempotency only against a no-op summarizer. Add a comment stating that
limitation explicitly (the mocked `summarizeConversation` returns
`options.messages` verbatim), or extend with a summarizer that rewrites the
history if cheap to do. Do not weaken the existing assertions.

### 5. Cleanup

Delete the empty review leftovers (both 0 bytes, untracked):

- `src/core/task/__tests__/TMP_handleContextWindowExceeded-prune-row.spec.ts`
- `src/services/web/__tests__/_tmp_review_repro.spec.ts`

## Explicitly out of scope

- The mode-switch prune-leak suspicion (destructive prune persisted under a
  small-context mode, visible to a later wide-context mode). Unverified,
  non-blocking per the review; needs its own trace of the mode-switch flow
  and possibly a restore-from-artifact pass. Tracked in memory
  (`project_search_task_history_redos.md` records the same "own branch"
  convention for deferred hardening).
- ReadArtifactTool hardening (already tracked as its own future branch).
- Spill-vs-prune notice wording conflation (low risk, opener is the
  discriminator; revisit only if a weak model is observed misreading it).

## Gates

- `npx vitest run src/core/task/__tests__/TaskContextManager.forced-prune-row.spec.ts src/core/task/__tests__/TaskContextManager.prune-row.spec.ts src/core/context-management/__tests__/prune-before-condense.spec.ts src/core/condense/__tests__/condense-prune-telemetry.spec.ts` (from `src/`)
- Type check of the touched package.
- Commit immediately after gates pass (user rebuilds mid-session).
