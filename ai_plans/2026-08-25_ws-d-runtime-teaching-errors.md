# Runtime tool errors: teaching examples and centralized mistake accounting (WS-D follow-up)

Date: 2026-08-25
Branch: `feat/34-runtime-teaching-errors` (stacked on `feat/33-prune-row-forced-truncation`)
Source: adversarial review of `feat/28-teaching-errors` (commit b9884f018) plus an independent
verification pass at `feat/33` HEAD (a232129bb).

## Problem

`feat/28` gave weak models a teaching error: `formatResponse.toolError(message, toolName)`
attaches `failed_tool` and `minimal_valid_example` so the model can copy a working call
instead of only reading what was wrong (`src/core/prompts/responses.ts:36-45`). The
mistake-limit guidance reads `Task.lastToolErrorName` to name the tool that keeps failing
(`src/core/task/Task.ts:398-402`, `src/core/task/TaskApiLoop.ts:378-421`).

Only the PARSE path was wired up. Every RUNTIME failure (disk error, failed command, diff
apply blowing up, MCP transport error) reached the model as a bare error string with no
`failed_tool`, no example, and without growing `consecutiveMistakeCount`. The two effects
compound: the model gets the least help exactly where the failure is real, and the
consecutive-mistake circuit breaker never trips on a tool that fails every single turn.

## Evidence (call-site census at feat/33 HEAD)

`handleError` is a callback (`HandleError` in `src/shared/tools.ts:19`) with an optional
third `toolName` argument.

- Exactly ONE 3-argument call existed: `src/core/tools/BaseTool.ts:167`, the
  missing-`nativeArgs` parse path.
- 25 two-argument calls: `BaseTool.ts:120` (partial catch), the top-level `execute()`
  catches of 23 tools, and the custom-tool catch in
  `src/core/assistant-message/presentAssistantMessage.ts:1077`. Verified with
  `grep -rn "handleError(" src/core/tools/*.ts src/core/assistant-message/presentAssistantMessage.ts`.
- NO tool rethrows out of `execute()`: every one of the 23 swallows in its own catch. So a
  central try/catch in `BaseTool.handle` alone could NOT fix the tool-side sites; it only
  covers the unprotected prefix region that runs before each tool opens its own `try`
  (real I/O lives there in `WriteToFileTool`, `EditFileTool`, `ReadFileTool`,
  `SearchFilesTool`, `CodebaseSearchTool`, `WebFetchTool`, `WebSearchTool`,
  `AttemptCompletionTool`, `AskFollowupQuestionTool`, `RunSlashCommandTool`,
  `SearchTaskHistoryTool`, `ReadArtifactTool`, `accessMcpResourceTool`).
- The two `handleError` closures (`presentAssistantMessage.ts:252-266` MCP path and
  `:658-674` main path) are byte-identical. Both only `say("error", ...)` and
  `pushToolResult(formatResponse.toolError(errorString, toolName))`. Neither touches
  `consecutiveMistakeCount` nor `recordToolError`.
- Sites that bypass `handleError` entirely: `ReadArtifactTool.ts:240` pushed a bare string,
  `SearchTaskHistoryTool.ts:90/127` called `toolError` without a name, `WebFetchTool.ts:87`
  and `WebSearchTool.ts:58/78/110` bumped the counter locally but called `toolError` without
  a name. `presentAssistantMessage.ts:734` (tool-use validation rejection) bumped the
  counter at `:728` but never called `recordToolError` and passed no name; `:1125`
  (unknown-tool fallback) called `recordToolError` but passed no name to `toolError`.

## Design decisions

### Where mistake accounting lives, and why

In the two `handleError` closures, not in `BaseTool` and not in each tool.

1. Both closures already own the "a tool failed, tell the model" contract: they say the
   error to the UI and push the error envelope. Counting there means one rule for all 25
   call sites, and any new tool that calls `handleError` inherits it for free.
2. `BaseTool.handle` cannot do it: 23 tools never let the exception escape `execute()`, so
   a wrapper there sees almost nothing (the census above). Making every tool rethrow would
   be a far larger, riskier change to control flow (`didAlreadyUseTool`, diff-view state).
3. Counting is gated on a `toolName` being supplied, so a caller that deliberately keeps
   the 2-argument form (the custom-tool catch, which already bumps and records locally)
   is not double counted. The gate is a positive opt-in rather than a blocklist.

Guards, matching what the closures already do and what abort handling requires:

- `AskIgnoredError` is an internal control-flow signal (a newer ask superseded an older
  one), never a model mistake. The closures already early-return on it, before the new
  accounting.
- `task.abort` / `task.abandoned`: a user cancel tears tools down mid-flight and would
  otherwise be charged to the model. `presentAssistantMessage.ts:89-90` already throws on
  `cline.abort`, so an aborted turn can produce spurious errors.

### Double-counting audit

Method: `grep -rn 'consecutiveMistakeCount++' src/core --include='*.ts'` (86 sites outside
tests), then for each of the 25 `handleError` call sites, read the enclosing `catch` and the
lines before it.

- No tool bumps the counter in the `catch` that calls `handleError`. Checked mechanically
  (an `awk` pass looking for a `throw` within 6 lines of every bump found none) and by
  reading each catch: the only lines before the `handleError` call are `console.error`,
  `diffViewProvider.reset()` and similar. So the central bump is the FIRST bump for that
  error.
- Validation-style bumps inside tools (`ApplyDiffTool.ts:38-83`, `UseMcpToolTool.ts:116-249`,
  `SearchReplaceTool.ts:34-128`, ...) all `pushToolResult(...); return` and never throw, so
  they cannot reach the enclosing catch. One residual edge case: those paths bump and then
  `await task.say("error", ...)`; if `say` itself threw, the catch would count a second time.
  `say` does not throw `AskIgnoredError` (that comes from `ask`), and a throwing `say`
  already means the UI channel is broken, so this is accepted and recorded here rather than
  guarded with a flag.
- Parse path (`BaseTool.ts:160-171`, the pre-existing 3-argument call): nothing else counts
  it. `BaseTool.handle` returns after `handleError` and `presentAssistantMessage` does not
  bump on return. Before this change the parse path was NOT counted at all; after it, it is
  counted exactly once. That is the intended fix, not a regression.
- `WebFetchTool` / `WebSearchTool` bump locally and never call `handleError`, so they are
  untouched by the central rule.
- Custom-tool catch (`presentAssistantMessage.ts:1074-1077`) bumps and records locally with
  the static `"custom_tool"` bucket; it deliberately stays 2-argument so the central rule
  does not fire. `getToolMinimalExample` returns `undefined` for dynamic tools anyway.
- `presentAssistantMessage.ts:728` bumps for a validation rejection and does not reach
  `handleError`; the missing `recordToolError` is added there without a second bump.

### Safety net in `BaseTool.handle`

`await this.execute(...)` is wrapped in try/catch which forwards to
`callbacks.handleError("executing <name>", error, this.name)`. Two reasons: the unprotected
prefix regions listed above, and unhandled promise rejections (`presentAssistantMessage` is
invoked un-awaited from `TaskStreamProcessor` and `TaskApiLoop`, so an escaping rejection
has no owner). The wrapper deliberately does NOT set `didToolFailInCurrentTurn`:
`AttemptCompletionTool.ts:45` refuses to run when that flag is set, and flipping it centrally
would change behaviour beyond error reporting. `AskIgnoredError` needs no special case here
because the closure already early-returns on it.

## Change list

1. `toolName` threaded through all 24 tool-side `handleError` calls (`this.name` inside a
   `BaseTool` subclass, the literal name in the standalone-function tools).
2. Central accounting in both closures (kept byte-identical, as they were).
3. `BaseTool.handle` safety net around `execute`.
4. Direct `toolError` sites given their name: `SearchTaskHistoryTool`, `WebFetchTool`,
   `WebSearchTool`, `ReadArtifactTool` (bare string replaced by the envelope, keeping the
   message text and the `didToolFailInCurrentTurn` behaviour),
   `presentAssistantMessage.ts:734` (plus the missing `recordToolError`) and `:1125`.
5. W-1: the `run_parallel_tasks` minimal example had ONE subtask while the runtime rejects
   fewer than two (`RunParallelTasksTool.ts:78-86`), i.e. the teaching example taught a call
   that always fails. Now two subtasks. Em dashes removed from that error string and from
   the `run_parallel_tasks` schema description.

## Test plan

- `examples.spec.ts`: hand-rolled recursive conformance checker validating each example
  value against the real advertised schema (type, union types with `"null"`, arrays with
  scalar or object items, one level of object nesting with `required` and
  `additionalProperties: false`, `enum`). No new dependency: `ajv` is only a devDependency of
  `packages/types` and is not importable from `src`. A negative self-test feeds the checker a
  deliberately wrong value so the checker itself is covered.
- `baseTool.spec.ts`: partial-catch expectation updated to 3 arguments; new tests for the
  safety net (execute throws, sync throw, `AskIgnoredError` still forwarded).
- New `presentAssistantMessage-runtime-errors.spec.ts`: a runtime `handleError` with a tool
  name bumps `consecutiveMistakeCount`, calls `recordToolError`, and produces an envelope
  with `failed_tool` + `minimal_valid_example`; `AskIgnoredError` does neither; an aborted
  task does not count.
- All pre-existing WS-D specs stay green.

## Results

- Branch `feat/34-runtime-teaching-errors`, two commits:
  `4b962e02c` (main fix) and `95ba9a8c1` (plan doc results).
- WS-D suite baseline before the change: 7 files, 99 tests, all passing.
- After the change: 8 files, 122 tests, all passing
  (`teaching-errors`, `examples`, `baseTool`, `presentAssistantMessage-minimal-example`,
  `presentAssistantMessage-runtime-errors`, `TaskApiLoop.mistake-limit-example`, `rules`,
  `objective`).
- Regression sweep over the touched tools (`web-tools`, `search-task-history`,
  `read-artifact`, `run-parallel-tasks`, `applyDiffTool`, `writeToFileTool`,
  `executeCommandTool`, `presentAssistantMessage*`): 22 files, 356 tests passing.
- `pnpm check-types` in `src/` (`tsc --noEmit`): clean.

## Deliberately out of scope

- `ReadFileTool` per-file error results keep their own per-file granularity; wrapping them
  in a single tool-level envelope would lose which file failed.
- `SearchTaskHistoryTool`'s catch still does not bump the counter (only sets
  `didToolFailInCurrentTurn`); this round only gives it the tool name, matching the
  instruction not to change counting behaviour there.
- Making tools rethrow instead of swallowing, so a single central catch could own
  everything. Correct end state, much larger blast radius, needs its own branch.
