# Fix handoffs.ts `rename` mock-load crash (13 unit-test suites)

**Date:** 2026-08-25
**Status:** Complete — all 13 previously-failing `src` suites green; agent-interchange suite green
**Branch:** `fix/handoffs-lazy-rename`

## Problem

`cd src && npx vitest run` reported **13 failed suites** (7304 tests passed, but
the suites never ran their bodies). Every failure shared one error:

```
[vitest] No "rename" export is defined on the "fs/promises" mock.
❯ ../packages/agent-interchange/src/handoffs.ts:123:51
   const defaultIo: HandoffIo = { rename: fsPromises.rename, syncDirectory }
```

## Root cause (proven with evidence)

[`packages/agent-interchange/src/handoffs.ts:123`](packages/agent-interchange/src/handoffs.ts:123)
captures `fsPromises.rename` **at module load time** into a module-level
constant `defaultIo`.

The import chain that drags this module into `src` tests:

```
src/core/config/ContextProxy.ts
  → src/core/memory/paths.ts:4   (import { ... } from "@roo-code/agent-interchange")
    → packages/agent-interchange/src/index.ts:28
      → packages/agent-interchange/src/handoffs.ts:123   ← reads fsPromises.rename
```

13 test files mock `fs/promises` with a **partial factory** that lists only the
methods they need (`mkdir`, `writeFile`, `readFile`, …) and omits `rename`:

- `src/__tests__/task-resume-ui.spec.ts:136`
- `src/core/task/__tests__/grounding-sources.test.ts:101`
- `src/core/task/__tests__/reasoning-preservation.test.ts:101`
- `src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts:13`
- `src/core/webview/__tests__/ClineProvider.lockApiConfig.spec.ts:216`
- `src/core/webview/__tests__/ClineProvider.spec.ts:37`
- `src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:185`
- `src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:186`
- `src/core/webview/__tests__/ClineProvider.taskHistory.spec.ts:19`
- `src/core/webview/__tests__/webviewMessageHandler.readFileContent.spec.ts:23`
- `src/core/webview/__tests__/webviewMessageHandler.spec.ts:127`
- `src/api/providers/fetchers/__tests__/modelCache.spec.ts:28`
- `src/core/tools/__tests__/editTool.spec.ts:12`

Under those mocks `fsPromises.rename` is `undefined` at load, so vitest throws
before any `it()` body executes.

**Note:** [`src/__mocks__/fs/promises.ts:137`](src/__mocks__/fs/promises.ts:137)
(the manual automock) _does_ define `rename`. The 13 failures all use explicit
`vi.mock("fs/promises", () => ({ … }))` factories that override the automock
and happen to omit `rename`. There are 67 such factories across the repo; only
13 omit `rename` _and_ transitively load `ContextProxy`. Patching each factory
would be fragile — any future test mocking `fs/promises` would have to remember
`rename`. The source fix is one line and removes the class of failure.

## Fix

### 1. Defer `rename` capture to call time (source fix)

[`packages/agent-interchange/src/handoffs.ts:123`](packages/agent-interchange/src/handoffs.ts:123)
changed from capturing the binding eagerly to a closure that resolves it on
first use:

```ts
// before
const defaultIo: HandoffIo = { rename: fsPromises.rename, syncDirectory }

// after
const defaultIo: HandoffIo = {
	rename: (source, destination) => fsPromises.rename(source, destination),
	syncDirectory,
}
```

`fsPromises` is a live module-namespace binding, so reading `.rename` inside
the closure resolves against the fully-populated module at call time. None of
the 13 tests call `createHandoff`/`updateHandoff`/`atomicWrite`, so the closure
is never invoked under those mocks — the module loads cleanly.

The agent-interchange package's own spec passes an explicit `io` with
`rename: fs.promises.rename` ([`handoffs.spec.ts:430`](packages/agent-interchange/src/__tests__/handoffs.spec.ts:430)),
so `defaultIo` is bypassed there; the change is transparent to it.

### 2. Fix unmasked `editTool` assertion drift

The `rename` crash had been hiding a second failure: [`editTool.spec.ts:411`](src/core/tools/__tests__/editTool.spec.ts:411)
asserted `handleError("edit", error)` (2 args), but the merged WS-D
teaching-errors stack ([`Feat/34 runtime teaching errors (#143)`](src/core/tools/EditTool.ts:245))
added a 3rd `toolName` arg to all 24 `handleError` call sites, matching the
[`HandleError`](src/shared/tools.ts:19) type
`(action, error, toolName?)`. [`EditTool.ts:245`](src/core/tools/EditTool.ts:245)
passes `this.name` (`"edit"`). The test expectation was stale; production is
correct. Updated the assertion to `("edit", expect.any(Error), "edit")`.

## Verification

- `cd src && npx vitest run <13 files>` → **13 passed, 247 tests passed**.
- `cd packages/agent-interchange && npx vitest run --exclude '**/mcp-server.spec.ts'`
  → **6 passed, 95 tests passed** (incl. `handoffs.spec.ts` 34 tests that
  exercise `defaultIo` with real `fs.promises.rename` and the explicit-`io`
  serial-update / crashed-writer paths).

## Out of scope

`packages/agent-interchange/src/__tests__/mcp-server.spec.ts` has one failing
test ("only permits cross-workspace listing after a server startup opt-in",
line 187). It fails identically on `main` (verified by stashing this branch's
changes and re-running) and is unrelated to the `rename` crash — it's a
cross-workspace session-listing opt-in behaviour issue. Left for a separate
investigation.
