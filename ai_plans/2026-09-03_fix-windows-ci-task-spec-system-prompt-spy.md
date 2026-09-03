# Fix: Windows CI, Task.spec.ts timeouts (the system-prompt spy that stubs nothing)

Date: 2026-09-03
Branch: `fix/windows-ci-task-spec-system-prompt-spy` (off `main` at c09c6494c)
Sibling: `ai_plans/2026-09-03_fix-windows-ci-path-assertions.md` covers the other
14 failures. Predecessor: `ai_plans/2026-08-26_fix-windows-ci-task-spec-timeouts.md`
(PR #160, per-file isolation), which fixed the cross-file starvation but not this.

## Symptom

After PR #160 the Windows leg of `code-qa.yml` still reports 8 failures in
`src/core/task/__tests__/Task.spec.ts`:

- 7 x `Test timed out in 20000ms` (raised 10 s / 15 s variants included) in
  "API conversation handling" (strip non-protocol fields, shape image blocks,
  retry with countdown, no double retry delay) and "Subtask Rate Limiting".
- 1 x `expected 10 to be 5` in "should enforce rate limiting across parent and
  subtask": the mocked `delay` was called twice as often as the test expects.

The same file passes on Linux in 0.9 s of test time (slowest test 300 ms).

## Root cause (with evidence)

### 1. The spy targets a method the API loop never calls

Every test in those two describes does

```ts
vi.spyOn(cline as any, "getSystemPrompt").mockResolvedValue("mock system prompt")
```

and then drives `cline.attemptApiRequest(0)`. Since the Phase 2A split of
`Task.ts` (`31f5b8145`, "extract 5 modules from Task.ts monolith", PR #11):

- `Task.attemptApiRequest` is `yield* this.apiLoop.attemptApiRequest(...)`
  (`Task.ts`).
- `TaskApiLoop.attemptApiRequest` calls `this.getSystemPrompt()` on the
  **TaskApiLoop** instance (`TaskApiLoop.ts:1067`), which is
  `this.apiRequestBuilder.buildSystemPrompt()`.
- `Task.getSystemPrompt` (`Task.ts:1614`) is only a delegating wrapper used by
  `TaskContextManager` (condense path). Nothing on the request path calls it.

So the spy sits on a method that is never invoked, and `attemptApiRequest`
builds the real system prompt. Proof, obtained by logging the first argument
that reaches the `createMessage` spy in "should strip non-protocol fields" on
Linux:

```
before: PROBE systemPrompt length=15665 isMock=false head="You are Tumble Code, an AI coding agent. Your mode is defined later in this prom"
after:  PROBE systemPrompt length=18 isMock=true head="mock system prompt"
```

"before" is the file as committed on `main` (spy on the Task); "after" is the
same test with the spy moved to `cline.apiLoop`. The probe was a temporary
`fs.writeFileSync` of `createMessageSpy.mock.calls[0][0]` and is not committed.

The same file already contains the correct form, in the AP-7 tests added
later: `vi.spyOn(cline.apiLoop, "getSystemPrompt")` (`Task.spec.ts:2297`).
Those two tests are not in the Windows failure list.

### 2. What the real prompt build does on Windows that it does not do on Linux

The real path is `ApiRequestBuilder.buildSystemPrompt` ->
`McpServerManager.getInstance` (real provider tests only) -> `SYSTEM_PROMPT`
-> `getSystemInfoSection(cwd)` -> `osName()` from the `os-name` package.

`os-name@6.1.0` on win32 calls `windows-release@6.1.0`, whose source is:

```js
if ((!release || release === os.release()) && ['6.1', '6.2', '6.3', '10.0'].includes(ver)) {
	let stdout;
	try {
		stdout = execaSync('wmic', ['os', 'get', 'Caption']).stdout || '';
	} catch {
		stdout = execaSync('powershell', ['(Get-CimInstance -ClassName Win32_OperatingSystem).caption']).stdout || '';
	}
	...
```

GitHub's `windows-latest` reports `os.release()` = `10.0.x`, so this branch
runs on every call. `wmic` is gone from current Windows Server images, so the
call falls through to a **synchronous** PowerShell start plus a CIM query. That
is several seconds per call on a CI runner (WMI service warm-up on the first
call is often far more), during which the event loop is frozen: vitest's
timeout timer cannot fire, the test's own awaited promises cannot progress, and
the run only resumes when PowerShell exits. Nothing memoizes the result, so
every system prompt build, i.e. every test in those describes (two per
rate-limit test: parent and child), pays it again.

Why the `execa` mock in `Task.spec.ts` (`vi.mock("execa", () => ({ execa: vi.fn() }))`)
does not neutralize it: `windows-release` and `os-name` are ESM packages in
`node_modules` (`"type": "module"`), which vitest externalizes; the mock only
applies to the project's own module graph, so the package binds the real
`execaSync`. On Linux `os-name` takes the `linux` branch, which never spawns,
which is why the file is fast there and why nobody noticed the spy was inert.

### 3. The "expected 10 to be 5"

A timed-out vitest test body keeps running after the failure is recorded. The
previous test in that describe (rate-limit parent + child, 5 s of mocked
`delay(1000)` countdown each) kept calling the file-level `delay` mock while the
next test was already counting its own calls, so the next test saw 10 calls
instead of its 5. It is a consequence of (1) and (2), not a separate defect.

### 4. Why PR #160 did not help

Per-file isolation removed cross-file heap growth and leaked globals. This
failure is inside one file and is a synchronous external process, which
isolation cannot shorten.

## Fix

1. `src/core/task/__tests__/Task.spec.ts`: the 15 spies in "API conversation
   handling" and "Subtask Rate Limiting" now target `cline.apiLoop`
   (`vi.spyOn(task.apiLoop, "getSystemPrompt")`), the method the request path
   calls. With the stub in place the tests skip McpHub construction, the rules
   and skills scans and `osName()` entirely, which is what they were written to
   do. The two condense tests keep their Task-level spy: `condenseContext` goes
   through `TaskContextManager`, whose access object is the Task itself, so that
   spy is effective there.
2. `src/core/prompts/sections/system-info.ts`: `osName()` is resolved once per
   process (`resolveOsInfo()` memo) instead of on every prompt build. On
   Windows this turns a per-request synchronous shell-out into a one-time cost.
   `resetOsInfoCacheForTests()` lets `system-info.spec.ts` observe a fresh
   `os-name` behavior per test. The other four spec files that mock `os-name`
   return one constant per file, so the memo is transparent to them.

## Verification

- `Task.spec.ts` on Linux: all 47 pass; the probed prompt is now the stub.
- `system-info.spec.ts`: 4 pass, including the new once-per-process test.
- Platform confirmation is the Windows CI run of this branch.

## Residual

- With the spies fixed, the tests with a non-empty history still fall through
  to `api.countTokens` (AP-7 fallback), which tries the `workerpool` worker at
  `src/utils/workers/countTokens.js` (absent under vitest), fails, and uses the
  in-process tiktoken encoder. That is a one-time encoder construction per
  process; observed fast on Linux and not Windows-specific. If Windows CI still
  shows a slow first test in this file, stub `countTokens` there next.

## Historia

- 2026-09-03: analiza i poprawka.
