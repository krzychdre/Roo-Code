# Implementation plan: adopting DeepSeek Harness ideas in Tumble Code

Date: 2026-08-24
Status: detailed plan, approved analysis in
[2026-08-24_deepseek-harness-inspirations.md](2026-08-24_deepseek-harness-inspirations.md)
Target models: Qwen3.8 27B, DeepSeek V4 Flash (small), GLM-5.2 / GLM-5.3 755B (cache- and
turn-sensitive).

## Conventions for this plan

- One branch per workstream (repo convention). Branch names use the next free `feat/NN` slot at
  the time each branch is cut; the names below use placeholders.
- Workstreams are independent unless marked "stacked on". WS-B and WS-C share the artifact
  store, so WS-C stacks on WS-B.
- Every workstream ends with: unit tests green, `pnpm typecheck` green, changed-behavior tests
  listed in the section, and a commit immediately after the workstream is verified (memory:
  commit before the user rebuilds).
- Prompt-visible changes must state their KV-cache effect in the PR/commit description:
  "prefix-stable" (does not change existing request prefixes) or "append-only" (only adds new
  content after retained history). This convention starts now and is formalized in WS-F.

Recommended order: WS-A, WS-B, WS-C, WS-D, WS-E, WS-F (gated), WS-G.

---

## WS-A: native `web_search` and `web_fetch` tools

Branch: `feat/NN-web-tools`
Goal: give every mode, including text-only small models, a one-parameter way to consult current
documentation, backed by the user's self-hosted SearXNG.

### Design

Two native tools behind a backend seam, mirroring dsh's `@deepseek-ai/dsh-tool-web` (schemas
never change when the backend swaps):

- `web_search`: required `queries` (array of 1-4 strings). Returns, per query, up to K merged
  results as `title\nurl\nsnippet` blocks (K default 5, config). No screenshots, no browser.
- `web_fetch`: required `url`. Fetches the page server-side, converts HTML to readable
  markdown, returns text. Oversized output goes through the WS-B spill once it exists; until
  then, truncate to the existing 50 KB style cap with a truncation notice.

Backend v1: SearXNG JSON API (`GET <base>/search?q=...&format=json`). The seam is one interface
so Tavily/Brave/Google CSE can be added later without schema changes.

### File-level changes

1. `packages/types/src/web-tools.ts` (new): zod schema for settings
   `webToolsEnabled: boolean` (default false), `webSearchBackend: "searxng"`,
   `searxngBaseUrl: string`, `webSearchMaxResults: number` (default 5),
   `webFetchMaxBytes: number` (default 51200). Export merged into global settings the same way
   `codebase-index.ts` is merged (`packages/types/src/provider-settings.ts:4,377` is the
   pattern reference; these are global settings, not per-profile).
2. `src/services/web/` (new): `WebSearchService.ts` (SearXNG client, query merge + dedup by
   URL, timeout 10 s, result cap), `WebFetchService.ts` (fetch with redirect+size limits,
   content-type guard, HTML to markdown conversion; reuse the existing HTML-to-markdown
   dependency already used for @url mentions rather than adding a new one; check
   `src/core/mentions/` for the current converter and share it).
3. `src/core/tools/WebSearchTool.ts`, `src/core/tools/WebFetchTool.ts` (new): extend
   `BaseTool`, param validation via `sayAndCreateMissingParamError`
   (`src/core/task/Task.ts:1334`) for missing params.
4. `src/core/prompts/tools/native-tools/web_search.ts`, `web_fetch.ts` (new): schemas with
   descriptions. The `web_search` description carries the single guidance line (dsh style,
   tool-adjacent, not a rules paragraph):
   "When unsure about an API, a version, or an error message, verify against current
   documentation with web_search / web_fetch before coding from memory."
5. `src/shared/tools.ts`: add both names to `toolNamesMap` and a new group
   `web: { tools: ["web_search", "web_fetch"] }` in `TOOL_GROUPS`
   (`src/shared/tools.ts:303`).
6. `packages/types/src/mode.ts`: add `"web"` to the `groups` arrays of the built-in modes that
   should browse docs (code, architect, ask, debug; NOT the md-only translate-style modes).
   Custom modes opt in by adding the group themselves. The deployed reviewer/vision live YAML
   copies are re-copied after edit (memory: asset yaml is source of truth).
7. Dispatch wiring: wherever native tools are registered/dispatched (follow the pattern of
   `read_command_output` end to end: presentAssistantMessage switch, native tool index,
   `filter-tools-for-mode.ts`).
8. `webview-ui`: one settings card (enable toggle, base URL field, max results). Follow the
   codebase-index settings card as the template.

### Behavior details

- Both tools are auto-approvable read-only operations; wire them into the existing
  auto-approve category for browser/read operations so small models do not stall on approvals.
- `web_search` merges 1-4 queries in one call (dsh pattern) so a weak model gets breadth in a
  single turn instead of four turns (GLM decode x turns bottleneck).
- Errors (backend down, non-2xx, timeout) return as tool errors with the corrective text
  "web_search backend unreachable at <url>; tell the user or continue without web data", never
  end the turn.
- When `webToolsEnabled` is false the group resolves to no tools and no prompt text (zero
  cache impact for users who keep it off; prompt effect is prefix-stable for them).

### Tests

- `WebSearchService` unit tests with mocked fetch: merge, dedup, cap, timeout, non-JSON reply.
- `WebFetchTool` test: HTML to markdown, size cap + notice, bad content type.
- `filter-tools-for-mode` test: group off means tools absent from advertised set.
- One prompt snapshot updated (group advertised in modes that include it).

### Acceptance

Ask mode on the Qwen 27B profile can answer "what changed in <library> 2.x" by calling
web_search then web_fetch, with both calls well-formed on the first try in the PTY smoke run.

---

## WS-B: generic artifact spill for oversized tool results

Branch: `feat/NN-artifact-spill`
Goal: no tool result floods the context, and nothing large is irrecoverably truncated. This
generalizes the existing command-only interceptor to every tool result.

### Design

dsh's `spill-policy` at the single choke point where a tool result becomes conversation
content. Policy: if a tool result's text exceeds `maxInlineToolResultBytes` (default 24 KB,
setting), persist the full text as a task artifact, replace the inline content with:

```
[Tool result: 412 KB, showing first 60 and last 60 lines. Full output saved as artifact
"srch-1724499999.txt". Use read_artifact (search/offset/limit) to inspect the rest.]
<head lines>
...
<tail lines>
```

Best-effort like dsh: if the artifact write fails, keep the full inline result (never turn a
success into an error). Append-only cache effect.

### File-level changes

1. `src/core/artifacts/ArtifactStore.ts` (new): extract and generalize the persistence half of
   `src/integrations/terminal/OutputInterceptor.ts`: `save(taskId, kind, text) -> { id, bytes,
path }`, files under `getTaskDirectoryPath(...)/artifacts/<kind>-<ts>.txt`. Kinds: `cmd`
   (existing), `tool` (new), `prune` (WS-C), `fetch` (WS-A).
2. `OutputInterceptor.ts`: refactor to use `ArtifactStore` for persistence; command flow and
   its artifact id format stay byte-compatible (`cmd-<ts>.txt`) so old prompts keep working.
3. Choke point: the helper that converts a tool's result string into the user-message content
   block pushed to API history (locate the single formatter used by `BaseTool` result
   handling; if there are several, normalize on one). Insert the spill policy there, with an
   allowlist of tools that bypass it: `attempt_completion`, `ask_followup_question`,
   `update_todo_list`, `switch_mode`, `new_task` (their outputs are protocol, not data), and
   `read_artifact` itself windows its own output.
4. `src/core/tools/ReadCommandOutputTool.ts`: generalize into `ReadArtifactTool` with tool name
   `read_artifact` (params unchanged: `artifact_id`, `search`, `offset`, `limit`). Register
   `read_command_output` in `TOOL_ALIASES` (`src/shared/tools.ts`) pointing at `read_artifact`
   so existing histories and small-model habits keep working. Update the `command` group and
   prompt schema names.
5. Settings: `maxInlineToolResultBytes` in global settings (same file as WS-A settings or the
   context-management settings group, wherever `maxWorkspaceFiles` style knobs live), UI slider
   optional (defer).

### Tests

- Policy unit tests: under limit passthrough, over limit spills with correct head/tail and
  hint, write failure keeps inline, bypass list respected.
- `ReadArtifactTool`: reads `cmd` and `tool` kinds, search/offset/limit, unknown id error text
  contains corrective guidance.
- Regression: existing `read_command_output` tests pass against the alias.

### Acceptance

`search_files` over a vendored directory returning 300 KB lands as a preview + artifact, and a
follow-up `read_artifact` with `search` finds a line beyond the preview.

---

## WS-C: deterministic pruning before LLM condense (stacked on WS-B)

Branch: `feat/NN-prune-before-condense` (stacked on `feat/NN-artifact-spill`)
Goal: make the cheap, lossless-for-decisions reduction run first, and the lossy LLM summary
run last, mirroring dsh compaction-basic + its tool-result pruner.

### Design

On context pressure (the trigger that currently leads to `summarizeConversation`):

1. **Prune pass**: walk API history oldest-first, excluding the protected recent tail (reuse
   `computeCondenseKeepBoundary`, `src/core/condense/index.ts:782`). For each tool-result
   content block whose text exceeds `pruneToolResultBudget` (default 4 KB):
    - save the full original text to the ArtifactStore (`kind: "prune"`),
    - replace the block in-place with first 20 + last 20 lines plus
      `[pruned N KB; full text: artifact "prune-<ts>.txt", use read_artifact]`.
      Results already spilled by WS-B are skipped (they are small already). User and assistant
      text blocks are NEVER touched. Tool-call/result pairing is untouched because only result
      content shrinks, no messages are removed.
2. **Remeasure** with the existing token estimator. If below the pressure threshold: stop.
   No LLM call this round (dsh: "advance the surface without a summary").
3. **Fallback**: still over threshold: run the existing `summarizeConversation`
   (`src/core/condense/index.ts:392`) unchanged. Its input is now smaller and cheaper, and the
   folded-file-context path keeps working.

Prune replacements are persisted in API history like any other mutation (they must survive
resume and mode switches; transient recompute is not possible here because the original is
moved to disk, which is exactly why the artifact citation is mandatory).

### File-level changes

1. `src/core/condense/toolResultPruner.ts` (new): pure function
   `pruneToolResults(messages, { keepBoundary, budgetBytes, headLines, tailLines, store })`
   returning `{ messages, prunedCount, bytesSaved, artifacts }`. Deterministic, no model.
2. `src/core/context-management/index.ts` and/or `src/core/task/TaskContextManager.ts`: insert
   the prune + remeasure step in front of the summarize call (there is a single pressure
   decision point; keep it single).
3. Telemetry: extend the existing condense telemetry event with
   `{ prunedCount, bytesSaved, summarySkipped }` so the metrics page can show how often the
   LLM summary was avoided.
4. Settings: `pruneBeforeCondense: boolean` (default true), `pruneToolResultBudget` (default
   4096). Escape hatch first release: setting visible in advanced settings.

### Tests

- Pruner unit tests: boundary respected, budget respected, head/tail exact, artifact cited,
  idempotent on already-pruned blocks, never touches user/assistant text.
- Integration test: pressure with large old tool results resolves without calling the
  summarizer (spy) and token estimate drops.
- Resume test: pruned history reloads and `read_artifact` recovers a pruned original.

### Acceptance

A long GLM session that used to condense twice per hour condenses at most once, and the
condense telemetry shows `summarySkipped: true` rounds. No assistant decision text lost.

---

## WS-D: micro-guidance and teaching errors

Branch: `feat/NN-teaching-errors`
Goal: replace paragraph-style exhortations with dsh-style one-liners next to the tool, and
make every malformed call come back with a minimal correct example.

### Part 1: tool-adjacent one-liners

1. Add to `execute_command`'s schema description
   (`src/core/prompts/tools/native-tools/execute_command.ts`):
   "Check the exit code on every result; investigate failures before moving on."
2. Audit `src/core/prompts/sections/rules.ts` and `objective.ts`: every sentence that concerns
   exactly one tool moves into that tool's description (or is deleted if the tool description
   already covers it). Target: measurable reduction of the rules section for all models.
   Deliverable of the audit: a table in the PR description (sentence, verdict: moved/kept/
   deleted, where).
3. Cache effect: prompt text changes are a one-time prefix invalidation; note it in the PR.

### Part 2: minimal-example validation errors

1. `src/core/prompts/tools/native-tools/examples.ts` (new): static map
   `TOOL_MINIMAL_EXAMPLES: Record<ToolName, string>` with one smallest-valid invocation per
   tool, in the wire format the model actually uses (native tool-call JSON arguments).
2. `AskSay.sayAndCreateMissingParamError` (reached via `src/core/task/Task.ts:1334`) and the
   invalid-parameter error paths in `BaseTool`: append
   `"Minimal valid example:\n<example>"` from the map.
3. Same map reused by the tool-repetition and mistake-limit messages so all corrective texts
   converge on one vocabulary.

### Tests

- Unit: every `ToolName` present in the examples map (compile-time exhaustiveness via
  `satisfies`), error text contains the example.
- agent-bench A/B (existing harness, memory: agent-bench exists): malformed-call recovery rate
  on the Qwen 27B profile before/after; expectation: fewer repeated malformed calls.

---

## WS-E: slim toolset per API profile

Branch: `feat/NN-slim-toolset`
Goal: dsh's `ToolRestriction` idea: fewer choices for small models, hidden per profile, so
strong-model profiles lose nothing and mid-task mode/model switches stay safe.

### Design

A boolean on the API profile (profiles already follow modes through `modeApiConfigs`, so the
restriction automatically follows every mode switch: transient recompute, no persisted task
state, per the mode-switching design rule):

`slimToolset: boolean` (default false) in `packages/types/src/provider-settings.ts`.

When the ACTIVE profile has `slimToolset`, the advertised tool set is intersected with:

- read: `read_file`, `search_files`, `list_files`, `codebase_search`
- edit: `apply_diff`, `write_to_file` (hide `edit`, `search_replace`, `edit_file`,
  `apply_patch`, `generate_image`)
- command: `execute_command`, `read_artifact`
- web (if WS-A landed and enabled): both tools
- always-available protocol tools stay (`ask_followup_question`, `attempt_completion`,
  `switch_mode`, `new_task`, `update_todo_list`, `skill`, `tools_load`); `run_parallel_tasks`
  and `run_slash_command` are hidden (weak models misuse them; orchestrator modes run on
  strong profiles anyway)
- MCP: governed by a second flag `slimHidesMcp` (default true) because MCP schemas are the
  single largest tool-prompt cost; the deferred-tools catalog stays available through
  `tools_load` if the flag is false.

`TOOL_ALIASES` keeps resolving hidden names, so a model that habitually calls `edit_file`
still executes `apply_diff` semantics via alias resolution instead of failing.

### File-level changes

1. `packages/types/src/provider-settings.ts`: add `slimToolset`, `slimHidesMcp` to the base
   provider schema (plain booleans, optional, so exclude_none serialization stays clean;
   memory: self-hosted settings client rejects null).
2. `src/core/prompts/tools/filter-tools-for-mode.ts`: apply the intersection after mode-group
   resolution; single function `applySlimToolset(tools, settings)` with the allowlist above as
   a named constant.
3. The prompt side: capabilities/deferred-tools sections must consume the SAME filtered list
   (they already take the allowlist path, see `src/core/prompts/system.ts:103-116`; verify no
   second source of truth).
4. `webview-ui`: checkbox on the API profile editor ("Slim toolset (small models)"), tooltip
   explaining what gets hidden.

### Tests

- Filter unit tests: intersection per group, aliases still resolve, MCP flag behavior,
  protocol tools survive.
- Prompt snapshot for a slim profile: hidden tools appear nowhere (schema list, capabilities,
  deferred catalog).
- Mode-switch test: switching from a slim-profile mode to a full-profile mode mid-task
  re-advertises the full set on the next request (transient recompute).

### Acceptance

On the Qwen 27B profile with slim on, the advertised tool count drops to about 15, and the
edit-verb confusion cases from the bench (wrong editor picked, malformed patch format) drop.

---

## WS-F: prefix-stable system prompt ordering + KV-cache contract

Branch: `feat/NN-prompt-prefix-stability`
GATE: run the Z.ai cache probe and an agent-bench baseline FIRST (memory: probe before WS-7/8
of the efficiency stack; this workstream is that work). If the GLM endpoint shows no
prefix-cache reward, implement only the documentation contract and the snapshot tests, skip
the reorder.

### Design

Today `roleDefinition` (mode-specific) opens the prompt (`src/core/prompts/system.ts:124`), so
a mode switch invalidates the provider prefix cache from token 1. Reorder to:

1. Stable opener (new, byte-identical for all modes):
   "You are Tumble Code, an AI coding agent. Your current mode, its role, and its rules are
   defined in the MODE section at the end of this prompt."
2. `markdownFormattingSection`
3. `getSharedToolUseSection` + `getToolUseGuidelinesSection`
4. `getOutputEfficiencySection`
5. `getCapabilitiesSection` (mode-independent parts; MCP server list varies per mode allowlist
   and moves to the variable tail if it differs between modes)
6. `getSystemInfoSection`
7. memory section + memory index
8. VARIABLE TAIL: deferred-tools catalog (per-mode allowlist), modes section, skills section,
   rules (mode-scoped parts), `roleDefinition`, mode custom instructions, global custom
   instructions.

Within one mode nothing changes across turns (already true). Across modes, the shared prefix
now covers sections 1-7.

### File-level changes

1. `src/core/prompts/system.ts`: reorder `basePrompt` assembly; extract the stable opener as a
   constant.
2. Snapshot tests (`src/core/prompts/__tests__/`):
    - byte-stability: same mode, two consecutive assemblies, identical output;
    - common-prefix: code vs ask mode prompts share a prefix of at least the length of
      sections 1-7 (compute the split point, assert prefix equality);
    - the existing per-mode snapshots get regenerated once (expected churn, called out in PR).
3. `CONTRIBUTING.md` (or the PR template if one exists): add the one-line KV Cache effect
   requirement for any PR touching model-visible text.
4. Bench: rerun agent-bench on GLM-5.3 and Qwen 27B profiles; compare task success and
   time-to-first-token after mode switches (orchestrator flows switch modes constantly, so
   the cache win shows up there).

### Risks

- "Role at the end" may weaken weak-model persona adherence. Mitigation: the stable opener
  explicitly points at the MODE section; A/B on the bench before merging; revert is a pure
  reorder.

---

## WS-G: `search_task_history` tool

Branch: `feat/NN-search-task-history`
Goal: after condense/prune, the model can verify "I knew this earlier" instead of
confabulating (dsh session-query family, minimal port).

### Design

One tool, `search_task_history`: params `query` (required string, treated as regex with
literal fallback), `max_results` (optional, default 10, cap 50). Searches the task's stored
FULL history: `api_conversation_history.json` plus WS-C prune artifacts, i.e. content the
model can no longer see inline. Returns matched snippets with role, message index, and a
2-line context window, newest first. Read-only, auto-approvable, always-available group is NOT
granted: add it to the `read` group so md-only modes get it too.

### File-level changes

1. `src/core/tools/SearchTaskHistoryTool.ts` (new): loads history via
   `getTaskDirectoryPath` + the existing history reader used by resume
   (`src/core/task/TaskLifecycle.ts` has the read path), searches, formats, caps output (its
   own result also subject to WS-B spill).
2. `src/core/prompts/tools/native-tools/search_task_history.ts` (new): schema with the
   guidance line "Use this when you need something said earlier in this task that is no longer
   visible in the conversation."
3. `src/shared/tools.ts`: name map + `read` group entry.

### Tests

- Finds text that exists only before the last condense summary boundary.
- Finds text that exists only in a prune artifact (with WS-C landed; otherwise skipped test).
- Regex fallback to literal on invalid pattern, result cap respected.

---

## Explicitly out of scope (from the analysis, restated for this plan)

Cordis-style plugin runtime, Code Mode (`run_code`), agent teams, self-modification tools,
Ralph loop tool, dsh plan mode. The transferable subtask idea (only a bounded structured
report crosses rounds; the workspace is the memory) should inform any future rework of
`new_task` report formats but gets no branch now.

## Dependency and rollout summary

| Order | WS                         | Branch                          | Depends on                                           | Gate                                     |
| ----- | -------------------------- | ------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| 1     | WS-A web tools             | feat/NN-web-tools               | none                                                 | unit + PTY smoke                         |
| 2     | WS-B artifact spill        | feat/NN-artifact-spill          | none                                                 | unit + regression on read_command_output |
| 3     | WS-C prune-before-condense | feat/NN-prune-before-condense   | stacked on WS-B                                      | integration + resume test                |
| 4     | WS-D teaching errors       | feat/NN-teaching-errors         | none                                                 | agent-bench A/B (Qwen 27B)               |
| 5     | WS-E slim toolset          | feat/NN-slim-toolset            | better after WS-A/B (allowlists include their tools) | prompt snapshots + bench                 |
| 6     | WS-F prefix stability      | feat/NN-prompt-prefix-stability | none                                                 | Z.ai cache probe FIRST, then bench A/B   |
| 7     | WS-G search_task_history   | feat/NN-search-task-history     | better after WS-C                                    | unit                                     |

Merge order follows the table; WS-C merges only after WS-B. Each merged workstream needs the
VSIX rebuild before it is live in the installed build (memory: installed build vs main skew).

## Open questions (carry-over, decisions needed before the affected WS starts)

1. WS-A: SearXNG base URL default: point at the existing self-hosted instance, or ship empty
   and require explicit configuration? (Proposal: ship empty, the settings card links nothing;
   the user's instance URL is machine-specific.)
2. WS-E: `slimHidesMcp` default true, confirmed?
3. WS-F: if the Z.ai probe shows no prefix-cache reward, do we still reorder for llama.cpp
   local runs (which always reward prefix stability), or keep the current order and only add
   the tests + contract? (Proposal: reorder anyway; local llama.cpp is a daily target.)
