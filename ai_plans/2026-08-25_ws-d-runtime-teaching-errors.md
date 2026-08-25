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
  a name. Not all of those became named calls: three of them stay nameless on purpose, see
  "Deliberately out of scope". `presentAssistantMessage.ts:734` (tool-use validation
  rejection) bumped the counter at `:728` but never called `recordToolError` and passed no
  name; `:1125` (unknown-tool fallback) called `recordToolError` but passed no name to
  `toolError`.

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
- A fourth guard, "the block already delivered its result", was added by the post-review
  follow-up commit below; it is what keeps a successful tool from being charged for a failure
  in its own trailing cleanup.

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

1. `toolName` threaded through all 24 tool-side `handleError` calls: 23 in the tools
   themselves (22 files, `CodebaseSearchTool` has two) plus the partial-message catch in
   `BaseTool.ts:120`. Every tool is a `BaseTool` subclass, so all 24 pass `this.name` and no
   literal name had to be repeated. The 25th call site, the custom-tool catch in
   `presentAssistantMessage.ts`, deliberately stays 2-argument (see the audit above).
2. Central accounting in both closures (kept byte-identical, as they were).
3. `BaseTool.handle` safety net around `execute`.
4. Direct `toolError` sites given their name, one by one (three further nameless sites were
   left alone on purpose, see "Deliberately out of scope"):
    - `SearchTaskHistoryTool.ts:128`, the catch-all failure of the search itself.
    - `WebFetchTool.ts:85`, the fetch/extraction failure.
    - `WebSearchTool.ts:74` and `:109`, the backend-construction and search failures.
    - `ReadArtifactTool.ts:242`: the bare string became the envelope, keeping the message
      text and the `didToolFailInCurrentTurn` behaviour.
    - `presentAssistantMessage.ts:734`, the tool-use validation rejection, plus the missing
      `recordToolError`, and `:1125`, the unknown-tool fallback.
5. W-1: the `run_parallel_tasks` minimal example had ONE subtask while the runtime rejects
   fewer than two (`RunParallelTasksTool.ts:78-86`), i.e. the teaching example taught a call
   that always fails. Now two subtasks. Em dashes removed from that error string and from
   the `run_parallel_tasks` schema description.

## Post-review follow-up (second commit on this branch)

An adversarial review of the first commit found one real behaviour bug and a set of
documentation errors. What changed:

### The delivery gate: never charge a tool that already succeeded

`WriteToFileTool.ts:214-223`, `ApplyDiffTool.ts:255-268` and `EditFileTool.ts:473-486` all
push the SUCCESS result and only then run their trailing cleanup (`diffViewProvider.reset()`,
`resetPartialState()`, `processQueuedMessages()`) inside the SAME `try`. A throw in that
cleanup lands in the tool's own catch, which now calls `handleError(..., this.name)`, so the
centralized accounting from the first commit charged a mistake, and set `lastToolErrorName`,
for a tool that had just worked. Worse, the model never learned why: `pushToolResult` drops
the second envelope for the block ("Skipping duplicate tool_result"), so the mistake was
invisible and unexplainable. The same shape reaches the closures through the `BaseTool.handle`
safety net, which forwards anything escaping `execute()`.

Fix: `recordToolFailureAsMistake` takes a fourth argument, and both closures pass the
`hasToolResult` flag they already keep (`presentAssistantMessage.ts:208` and `:551`) at the
moment of the call, before their own `pushToolResult`. A failure reported after a result was
delivered is not counted and not recorded. The two closures stay byte-identical, as they were.

### Only real tool names reach `recordToolError`

`validateToolUse` throws for a hallucinated tool name as well as for a mode rejection, and at
that point `block.name` is an arbitrary model-supplied string. The `as ToolName` cast let it
into `Task.toolUsage` and into the `TaskToolFailed` telemetry event, where every consumer
expects a real `ToolName`. The rejection site (`presentAssistantMessage.ts:806`) now records
only names that pass `isValidToolName`, the same check the dispatcher uses a few hundred lines
above. The counter bump and the error envelope are unchanged, so the model still gets told.
The sibling site in the unknown-tool fallback (`:1170`) has the same cast but is PRE-EXISTING,
untouched by this branch, and guarding it would silence the recording for essentially every
name that reaches that branch; it is listed as follow-up instead.

### Residual edge: a throwing `say` on the missing-parameter path

`WebFetchTool.ts:32-37`, `WebSearchTool.ts:40-45` and `ReadFileTool.ts:92-96` / `:678-682`
bump `consecutiveMistakeCount` locally and then call `task.sayAndCreateMissingParamError`.
Order of operations there (`TaskAskSay.ts:650-658`): it `await`s `say("error", ...)` FIRST and
only RETURNS the envelope, which the tool then hands to `pushToolResult`. So if `say` throws,
the throw happens BEFORE any result is pushed: `hasToolResult` is still false and the delivery
gate does NOT cover this case. The safety net added in the first commit now catches that throw
(it used to be an unhandled rejection), routes it to `handleError` with the tool name, and the
failure is counted a second time. This is the same accepted class as the throwing-`say` edge
recorded in the double-counting audit above: a throwing `say` already means the UI channel is
broken, and guarding it properly needs a per-call "already counted" flag threaded through
every tool, which is not worth the machinery. Recorded, not fixed.

## Test plan

- `examples.spec.ts`: hand-rolled recursive conformance checker validating each example
  value against the real advertised schema (type, union types with `"null"`, arrays with
  scalar or object items, one level of object nesting with `required` and
  `additionalProperties: false`, `enum`). No new dependency: `ajv` is only a devDependency of
  `packages/types` and is not importable from `src`. A negative self-test feeds the checker a
  deliberately wrong value so the checker itself is covered.
  The follow-up commit adds one more check of a different kind: the `run_parallel_tasks`
  example is fed to the PRODUCTION validator (`validateParallelParams`), because the rule it
  broke (at least two subtasks) is a runtime rule the JSON Schema cannot express, so schema
  conformance alone would never have caught it.
- `baseTool.spec.ts`: partial-catch expectation updated to 3 arguments; new tests for the
  safety net (an `Error` escaping `execute`, a non-`Error` throw normalized into one,
  `didToolFailInCurrentTurn` left alone, a successful `execute` untouched, and, added by the
  follow-up commit, an `AskIgnoredError` forwarded unchanged with the tool name, since the
  closure recognizes it by `instanceof` and the safety net must not transform it).
- New `presentAssistantMessage-runtime-errors.spec.ts`: a runtime `handleError` with a tool
  name bumps `consecutiveMistakeCount`, calls `recordToolError`, and produces an envelope
  with `failed_tool` + `minimal_valid_example`; `AskIgnoredError` does neither; an aborted
  task does not count. The follow-up commit adds the delivery gate (a tool that pushed its
  result and then fails in cleanup is not charged, and keeps its success result) and the two
  validation-rejection cases (a real name is recorded, a hallucinated one is not).
- All pre-existing WS-D specs stay green.

## Results

Branch `feat/34-runtime-teaching-errors`, commits `c93bf8cae` (implementation), `d032b916d`
(this doc) and the post-review follow-up commit described above.

Test counts, all measured file by file rather than estimated. The base for every "from" number
is `feat/33` HEAD (`a232129bb`), obtained by running the base version of the same spec:

- `examples.spec.ts`: 62 tests on the base, 94 after the first commit (32 added: 26 per-tool
  schema-type conformance cases plus 6 negative self-tests of the checker), 95 after the
  follow-up commit adds the real-validator check. An earlier version of this doc said
  "86 to 94"; 86 was the base file's LINE count, not its test count.
- `baseTool.spec.ts`: 4 tests on the base, 8 after the first commit, 9 after the follow-up
  commit adds the `AskIgnoredError` case. That case was listed in this doc before it existed;
  it exists now.
- `presentAssistantMessage-runtime-errors.spec.ts`: new file, 6 tests in the first commit,
  9 after the follow-up commit.
- Full gate run after the follow-up commit,
  `npx vitest run core/tools/__tests__/ core/prompts/ core/assistant-message/__tests__/
core/task/__tests__/TaskApiLoop.mistake-limit-example.spec.ts` from `src/`:
  64 files, 1070 tests, all passing, plus the one pre-existing collection failure below.
- Pre-existing failure NOT caused by this branch: `core/tools/__tests__/editTool.spec.ts`
  fails at COLLECTION with `[vitest] No "rename" export is defined on the "fs/promises"
mock`, thrown from `packages/agent-interchange/src/handoffs.ts:122` via
  `core/memory/paths.ts` and `core/config/ContextProxy.ts`. Verified identical on
  `feat/33-prune-row-forced-truncation` by checking the base branch out and running the same
  file. Not touched here; it needs the spec's `fs/promises` mock extended, which belongs to
  whoever owns that import chain.
- 13 assertions across 9 pre-existing tool specs were updated from the 2-argument to the
  3-argument `handleError` shape: `askFollowupQuestionTool` 2, `editFileTool` 1,
  `listFilesTool` 2, `runSlashCommandTool` 1, `searchReplaceTool` 1, `skillTool` 1,
  `switchModeTool` 2, `useMcpToolTool` 1, `writeToFileTool` 2. Recounted from
  `git diff a232129bb` per file. An earlier version of this doc said "12 assertions in 8
  specs" while listing nine file names. Three `RunParallelTasksTool.spec.ts` assertions
  followed the em-dash removal in the subtask report heading.
- `pnpm check-types` from the repo root: 14 tasks successful (includes `tsc --noEmit` in
  `src/`), re-run after the follow-up commit's edits. `pnpm lint` ran through the pre-commit
  hook: clean.

## Deliberately out of scope / follow-up

- Three `toolError` sites keep NO tool name on purpose, so no minimal valid example is
  attached to them: `WebSearchTool.ts:57-64` and `WebFetchTool.ts:47-54` (the "tool is
  disabled" branches) and `SearchTaskHistoryTool.ts:83-90` (task storage unreachable on this
  machine). An example is an invitation to retry the same call, and retrying is exactly the
  wrong move here: the first two are administratively blocked until the user enables web tools
  in Settings, the third is an environment problem the model cannot fix by rewriting its
  arguments. The message already tells the model what to do instead (ask the user, or continue
  without the data). The neighbouring RUNTIME failures in the same three tools DO carry the
  name, because those are the calls worth retrying.
- Validation-failure `toolError` sites that still carry no name, so a rejected call gets the
  reason but not a copyable example: `UpdateTodoListTool`, `SwitchModeTool`, `NewTaskTool`,
  `EditTool`, `ApplyPatchTool`, `GenerateImageTool`, `AskFollowupQuestionTool`. These are the
  same class the WS-D work is meant to cover and they are worth a follow-up round; they were
  left out of this one to keep the blast radius at "runtime failures".
- The unknown-tool fallback (`presentAssistantMessage.ts:1170`) still casts a model-supplied
  string with `as ToolName` before `recordToolError`. Pre-existing, untouched by this branch.
  The one-line `isValidToolName` guard used at the validation-rejection site does not transfer
  cleanly: nearly every name that reaches that branch is invalid by construction, so the guard
  would silence the recording entirely rather than filter it. Deciding what that path should
  record (a static `unknown_tool` bucket, most likely) is its own change.
- The double-count edge on the missing-parameter path (a throwing `say`) analysed above:
  recorded, not fixed.
- `ReadFileTool` per-file error results keep their own per-file granularity; wrapping them
  in a single tool-level envelope would lose which file failed.
- `SearchTaskHistoryTool`'s catch still does not bump the counter (only sets
  `didToolFailInCurrentTurn`); this round only gives it the tool name, matching the
  instruction not to change counting behaviour there.
- Making tools rethrow instead of swallowing, so a single central catch could own
  everything. Correct end state, much larger blast radius, needs its own branch.
