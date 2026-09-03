# Fix: Windows CI Task.spec.ts timeouts (singleFork starvation)

Date: 2026-08-26
Branch: `fix/task-spec-windows-ci-timeouts` (off `main`)

## Symptom

Recurring Windows CI (`platform-unit-test (windows-latest)`) failure:

- 11 tests in `src/core/task/__tests__/Task.spec.ts` fail with
  `Test timed out in 20000ms` (plus raised 10s/15s variants).
- One vitest-internal unhandled error: `[vitest-worker]: Timeout calling
"onTaskUpdate"` - the worker did not answer the orchestrator RPC for over
  a minute.
- Log noise repeated 4x: `[memory] autoDream trigger failed: [vitest] No
"getStorageBasePath" export is defined on the "../../../utils/storage"
mock.`
- Whole `tumble-code#test` run: 479s for the last shard, exit 1.

## Root cause (with evidence)

### 1. The timeouts: `singleFork` runs ~500 test files in ONE process with no isolation

`src/vitest.config.ts` sets, for Windows CI only:

```ts
poolOptions: {
	forks: {
		singleFork: true
	}
}
```

added in `e7b160225` (June 2026, port of upstream Zoo PR #43) to stop
cross-worker flakes. `singleFork` means: one child process for the entire
suite, sequential files, **no per-file isolation**. State accumulates for
the whole run.

Decisive evidence that the failing tests are victims, not culprits:

- The Windows failure list includes
  `should keep MultiSearchReplaceDiffStrategy when experiments are undefined`
  (`Task.spec.ts:1247`): it constructs a Task with `startTask: false` on a
  plain-object provider and awaits a **10 ms `setTimeout`** - and still blew
  a 20 s timeout. Only a starved/frozen event loop does that.
- `Timeout calling "onTaskUpdate"` requires the worker to be unresponsive
  for >60 s.
- Reproduced on Linux by forcing the same pool shape
  (`npx vitest run --poolOptions.forks.singleFork=true`, worktree of `main`,
  after `pnpm pretest`): 61 test failures across 6 files that are green in
  the default (isolated, parallel) pool. Failure kinds observed:
    - `api/providers/__tests__/openai-native-{usage,tools}.spec.ts` (37):
      ``Error: `fetch` is not defined as a global`` - an earlier file removed
      `globalThis.fetch` and without isolation it never came back.
    - `core/task-persistence/__tests__/TaskHistoryStore.migrationAndInit.spec.ts`
      (15), `CustomModesManager.spec.ts`, `openrouter.spec.ts` - order/state
      dependent failures, plus one hard 20 s timeout mid-run with the fork's
      RSS frozen at ~1.35 GB for 2+ minutes (stuck, not computing).
    - Fork RSS grew unbounded through the run (sampled 0.8 -> 1.9 -> 2.9 GB);
      `ClineProvider.activeInstances` (a static `Set`) alone pins every
      provider ever constructed by 13 spec files, with their watchers and
      stores.

Which file gets hit depends on ordering, timing and heap pressure - on
GitHub's windows-latest it is reliably `Task.spec.ts` (it ran ~464 s into
the fork's life per the logger timestamp `t:464424`). That is why the
problem recurs and why per-test timeout bumps never fixed it.

### 2. The log noise: real ClineProvider + incomplete `utils/storage` mock

`Task.spec.ts` uses a **real** `ClineProvider` as `mockProvider`
(`Task.spec.ts:251`). Aborting a task fires the real
`TaskLifecycle.triggerMemoryBackgroundWriters()`, whose autoDream branch
calls `provider.getTaskHistory()` -> `TaskHistoryStore` -> the mocked
`../../../utils/storage`, which lacks `getStorageBasePath` -> the rejection
is logged by the writer-failure handler. 4 abort-path tests -> 4 log lines.

Non-obvious constraint discovered while fixing: **completing the mock is
wrong**. With `getStorageBasePath` mocked, `TaskHistoryStore.acquire()` in
the ClineProvider constructor succeeds and starts fs watchers plus a
self-rescheduling reconcile timer for every constructed provider; the two
fake-timer condense tests (`Queued message processing after condense`) then
hang in `runAllTimers` and time out. The incomplete mock's fail-fast is
load-bearing; it must stay incomplete, and the noisy _call_ has to go away
instead.

## Fix

1. `src/vitest.config.ts`: replace `singleFork: true` with
   `maxForks: 1, minForks: 1` for Windows CI. Files still run one at a time
   (preserves the June cross-worker-flake fix) but each file gets vitest's
   default fresh-process isolation, so nothing accumulates or leaks across
   files. Verified on Linux: full suite with
   `--poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1` is green
   (see Verification).
2. `src/core/task/TaskLifecycle.ts`: `triggerMemoryBackgroundWriters()` now
   bails on `!isAutoMemoryEnabled()` before doing any prep work
   (`renderTranscript` + the `getTaskHistory` round-trip). Both writers
   already hard-gate on this internally; the early return just stops paying
   for prep when memory is off.
3. `src/core/task/__tests__/Task.spec.ts`: file-scope `beforeAll`/`afterAll`
   sets `ROO_DISABLE_AUTO_MEMORY=1` (save/restore, because a shared fork
   shares `process.env`). With (2) this kills the autoDream noise AND ~10 s
   of real memory-writer/TaskHistoryStore work per run (file's test time
   dropped 11.45 s -> ~0.9 s). Comment added explaining why
   `getStorageBasePath` must NOT be added to the storage mock.
4. `src/core/task/__tests__/TaskLifecycle.abort-memory-writers.spec.ts`:
   its `../../memory` mock now exports `isAutoMemoryEnabled: () => true` so
   the new gate stays open for the writer-spy assertions. (Found by the
   Linux singleFork run: without it the gate threw the missing-export error
   into prepareAbort's try/catch and 8 tests failed.)

## Alternatives considered

- `--max-old-space-size` bump + keep singleFork: treats only the heap part;
  the `fetch` deletion and timer leakage stay. Rejected.
- Mock `TaskHistoryStore` wholesale in Task.spec.ts: bigger diff, does not
  help the other 12 spec files constructing real providers. Rejected.
- Per-polluter cleanup (restore `globalThis.fetch` etc.): whack-a-mole;
  isolation solves the class. Rejected.

## Verification

- `Task.spec.ts` + `TaskLifecycle.abort-memory-writers.spec.ts`: 59/59 pass,
  no autoDream noise.
- Full src suite, sequential isolated forks (the new Windows CI shape),
  on Linux: green - see final run numbers in the commit message.
- Cost: sequential isolated forks pay one process spawn per file. On Linux
  the full sequential run is comparable to the singleFork one (spawn cost
  amortized by not degrading); Windows CI wall-clock to be observed on the
  first CI run of this branch.

## Residual risk

- Windows CI duration may increase somewhat (497 process spawns). If it
  does, tune with `maxForks: 2` only after confirming the original
  cross-worker flakes stay quiet, or reintroduce `singleFork` per-shard.
- The one-process-per-file model is what non-Windows CI and local runs
  always used, so no new behavior class is introduced.

## Historia

- 2026-08-26: analiza i poprawka na gałęzi `fix/task-spec-windows-ci-timeouts` (commit
  `ea964730f`, 5 commitów za `main`, nigdy nie wypchnięta).
- 2026-09-03: użytkownik najpierw poprosił o usunięcie zadania Windows z CI (gałąź
  `ci/drop-windows-unit-test-job`, zostaje lokalnie, niewypchnięta), a po przeczytaniu tej
  analizy zmienił decyzję: zadanie zostaje, poprawka ma wejść. Commit przeniesiony
  (cherry-pick) na świeżą gałąź `fix/windows-ci-sequential-isolated-forks` od aktualnego
  `origin/main`, dodany changeset, gałąź wypchnięta.
