# DeepSeek Harness (dsh) analysis: what Tumble Code should adopt for small and cache-sensitive models

Date: 2026-08-24
Status: analysis / proposal, no code changes yet
Source analyzed: https://github.com/deepseek-ai/deepseek-harness (shallow clone at /tmp/deepseek-harness, master as of today)

## Goal

Pick the elements of DeepSeek Harness that would measurably help Tumble Code when driven by:

- small, not-very-smart models (Qwen3.8 27B, DeepSeek V4 Flash),
- large but cache- and turn-sensitive models (GLM-5.2, GLM-5.3 755B),

with two axes of improvement: faster task execution (fewer tokens, fewer turns, more KV-cache
reuse) and better quality (truth-seeking, critical thinking, verification, more willing use of
web documentation). Also: name what NOT to adopt, and what in Tumble Code could be removed or
hidden because it hurts weak models.

## What dsh actually is

An agent harness where literally everything is a plugin (Cordis framework): the model adapter,
the tool registry, the session log, and the agent loop itself are replaceable rows in a config
tree. That architecture itself is not portable to Tumble Code and is not proposed here. What IS
portable is a set of design disciplines that dsh enforces because of that architecture.

### Key observed facts (with sources)

1. **The system prompt is nearly empty.** Harness identity is one sentence
   ("You are an AI agent powered by DeepSeek Harness.", `packages/core/system-prompt/src/index.ts:361`).
   The whole shipped coding persona is one sentence
   ("You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.",
   `packages/bundle/web-app/cordis.patch.yml:18`). Everything else is contributed as small
   ordered sections BY THE TOOL PACKAGES that need them (tool guidance renders at order 100-199).
   Example: the entire cross-call guidance for bash is one line:
   "Check the [exit code: N] marker on every bash result; investigate failures before moving on."
   (`packages/shell/tool-bash/src/index.ts:236-240`).

2. **KV-cache impact is a documented, reviewed contract.** Every package README has a
   "KV Cache effect" section classifying each model-visible surface as either
   "prefix-stable while X unchanged" or "append-only" (grep "KV Cache effect" across
   `packages/*/README.md`). Dynamic context is NOT re-rendered into the prompt every turn:
   `PromptContext` snapshots are logged after retained history "only when it changed or
   compaction removed it" (`docs/subsystems/system-prompt.md`). Cache reuse is treated as a
   correctness-adjacent invariant, not an optimization afterthought.

3. **Oversized tool output spills to a file, generically.** A `tools/post-execute` policy
   (`packages/spill/spill-policy`) replaces ANY over-limit plain-text tool result with a
   head/tail preview plus a locator (a file path) and a retrieval hint telling the model to
   `read` or `grep` that path. Best-effort: if the save fails the inline result is kept
   (`docs/subsystems/spill.md`). Full data stays recoverable; context stays small.

4. **Compaction prunes deterministically before it summarizes.** Under context pressure,
   compaction first runs an optional deterministic tool-result pruner (head/middle/tail slice of
   over-budget tool results, by Unicode code point), remeasures, and "can advance the surface
   without a summary" (`docs/subsystems/compaction.md`). The expensive, lossy LLM summarization
   is the last resort, not the first response to pressure. Pruning boundaries preserve
   tool-call/result pairing but not whole turns.

5. **Tool schemas are aggressively minimal.** `web_fetch` takes one parameter (`url`);
   `web_search` takes one (`queries`, 1-4 strings); `skill` takes one (`name`)
   (`docs/tool-catalog.md`). Provider selection hides behind a seam so schemas never change when
   the backend swaps. Weak models rarely fumble a one-parameter call.

6. **Errors teach instead of ending the turn.** Argument mismatch, unknown tool, thrown tools:
   all become structured tool errors on the normal result path, "so the call fails without
   ending the turn" (`docs/subsystems/tools.md`). Policy can `block` a result, turning
   corrective feedback into an error the model must react to. Plan rejection is "a failed call
   carrying the user's feedback, so the model revises and presents again"
   (`docs/subsystems/plan.md`). One uniform protocol: wrong move -> error with instructions ->
   retry, all inside the turn.

7. **Tools can be restricted per scope.** `ToolRestriction` (allow/deny lists over inherited
   tools) lets one composition give an agent a smaller tool set without forking anything
   (`docs/subsystems/tools.md`).

8. **The model can query its own session log.** A `session_event_search` / `session_event_read`
   tool family lets the model recover details that compaction shadowed (`docs/tool-catalog.md`,
   `@deepseek-ai/dsh-tool-session-query`).

9. **Parallel tool calls are opt-in per tool.** `isConcurrencySafe(args)` classifies each call;
   the loop forms "exclusive barriers and rolling-pool parallel runs". Fail-closed: anything
   unknown or throwing is exclusive (`docs/subsystems/tools.md`).

10. **Ralph loop / goals.** A `ralph` tool runs bounded fresh-agent rounds toward one immutable
    objective; only a structured report crosses rounds and the workspace is the long-term
    memory. Goals have durable phases and round caps (`docs/tool-catalog.md`,
    `docs/subsystems/goal.md`).

## What Tumble Code already has (do not duplicate)

Verified on main today:

- Changed-only environment details with full emission at task/resume/subtask starts
  (`src/core/environment/getEnvironmentDetails.ts:56-110`); time and cost blocks are opt-in.
- Command-output spill: `OutputInterceptor` persists truncated output and `read_command_output`
  reads/searches/paginates it (`src/core/tools/ReadCommandOutputTool.ts`).
- Exit-code reporting on command results (`src/core/tools/ExecuteCommandTool.ts:556-607`).
- Folded file context during condense (tree-sitter definitions instead of full bodies,
  `src/core/condense/foldedFileContext.ts`).
- Tools catalog moved out of the system prompt; deferred-tools section
  (`src/core/prompts/system.ts:100-116`).
- Parallel subtasks (`RunParallelTasksTool`), orchestrator/new_task, per-mode model pinning.

So dsh's ideas 3 (partially), and the env-details half of 2, are already in. The proposals
below are the deltas.

## Proposals, prioritized

### P1. Prefix-stable system prompt ordering (speed, GLM cache reuse)

Today `roleDefinition` (mode-specific) is the FIRST text of the system prompt
(`src/core/prompts/system.ts:124`). Every mode switch therefore changes the request from token 1
and invalidates any provider-side prefix cache for the entire prompt AND the replayed history
derivation point. dsh orders: stable harness identity first, persona later, tool guidance last.

Proposal:

- Reorder the assembled prompt so byte-identical shared sections (markdown formatting, shared
  tool-use protocol, output efficiency, capabilities minus mode-varying parts, rules that do not
  depend on mode, system info) come first, and mode-varying text (role definition, mode custom
  instructions) comes last.
- Add a snapshot test asserting: (a) the prompt is byte-stable across turns within a mode;
  (b) two modes with the same tool groups share a maximal common prefix.
- Adopt dsh's documentation contract: any PR touching model-visible text must state its cache
  effect ("prefix-stable" vs "append-only") in the description. One line in CONTRIBUTING /
  PR template.

Prerequisite (per project memory): run the Z.ai cache probe and agent-bench first to confirm
provider-side prefix caching actually rewards this on GLM endpoints; llama.cpp locally does
reward it (prompt reprocessing time is directly proportional to the first differing token).

Risk: "You are X" first is classic prompt engineering; moving the role later could shift weak
model behavior. Mitigate with a short stable opener ("You are Tumble Code, an AI coding agent.
Your current mode and its rules are defined at the end of this prompt.") and A/B on the bench.

### P2. Generalize spill beyond execute_command (small-model context, truth-seeking)

The OutputInterceptor pattern exists but only for command output. Any other oversized text
result (huge read_file, big search_files result, MCP tool result, browser_action dump) still
either floods the context or gets truncated irrecoverably.

Proposal:

- One post-execution policy at the tool-result boundary: if a text result exceeds N bytes
  (config, default around 16-32 KB), persist the full text to the task directory, return
  head/tail preview + artifact id + one-line retrieval hint.
- Generalize `read_command_output` into `read_artifact` (same parameters: artifact_id, search,
  offset, limit) or teach it to read all artifact kinds; keep the old name as an alias for
  compatibility with existing prompts.
- Best-effort like dsh: storage failure keeps the inline result, never turns success into error.

This is the single biggest context-diet win for 27B-class models, and it converts "the model
guesses because the data was truncated" into "the model greps the artifact", which is exactly
the truth-seeking behavior requested.

### P3. Deterministic pruning before LLM condense (quality preservation + cost)

Tumble's condense summarizes with an LLM. With a weak model as summarizer this is the main
information-loss point, and it is also slow and costs a full generation.

Proposal, mirroring dsh compaction-basic:

1. On context pressure, FIRST deterministically shrink old over-budget tool results
   (head/middle/tail, keep first and last K lines, mark the elision, cite the original), oldest
   first, never touching user or assistant messages.
2. Remeasure. If below threshold: done, no LLM call at all this round.
3. Only if still over pressure: run the existing LLM condense on the remaining span.
4. Keep tool-call/result pairing intact at prune boundaries.

Combined with P2, most "big" content is already an artifact reference, so pruning gets cheaper
over time. Deterministic pruning is model-independent, reproducible, and preserves the
assistant's stated reasoning and decisions verbatim, which weak models need to stay on track.

### P4. Native web_search and web_fetch tools (explicit user goal: consult documentation)

dsh ships both as first-class one-parameter tools behind a backend seam. Tumble has only the
heavy browser_action (Puppeteer session, screenshots, vision needed) and whatever MCP servers a
user wires up (schema bloat, setup burden; the deferred-tools catalog helps but the schemas are
still MCP-shaped).

Proposal:

- `web_search`: one required parameter `queries` (array of 1-4 strings). Returns merged results:
  title, URL, snippet, optional answer line.
- `web_fetch`: one required parameter `url`. Returns readable text (markdown-converted), spilled
  through P2 when large.
- Backend seam in settings: SearXNG instance URL (the user already self-hosts one), with room
  for other providers later. Schemas never change when the backend does.
- One line of tool-adjacent guidance (dsh style, not a rules-section essay):
  "When unsure about an API, version, or error message, verify against current documentation
  with web_search / web_fetch before coding from memory."
- Available in all modes via a new "web" group or inside the existing browser group; enabled for
  text-only models (unlike browser_action, no vision required).

This is the concrete lever for "chetniejsze zagladanie do dokumentacji": a tool a 27B model can
actually call correctly (one parameter), plus one nudge line, beats a paragraph of exhortation.

### P5. Tool diet per model profile (weak-model accuracy; removal by hiding)

dsh's lesson: a scope can restrict inherited tools; fewer choices means fewer wrong choices.
Tumble currently exposes overlapping editors (ApplyDiffTool, ApplyPatchTool, EditTool,
EditFileTool, SearchAndReplaceTool, SearchReplaceTool, WriteToFileTool, InsertContent variants)
depending on experiments and mode groups. A 27B model picking among 4 edit verbs wastes turns
and produces malformed calls.

Proposal:

- Add a per-API-profile "slim toolset" toggle (the profile already pins model per mode, so this
  naturally follows the model, surviving mid-task mode switches).
- Slim = one diff editor + write_to_file + read/search/list + execute_command + ask/attempt +
  new_task + (P4 web tools) + read_artifact. Hide the rest from BOTH the tool list and any
  prompt mention (mode groups already do the plumbing; this is a filter on top).
- Hide browser_action for text-only profiles entirely (Vision mode already covers images).
- This is the requested "remove functionality that stands in the way", implemented as hiding per
  profile rather than deletion, so strong-model profiles lose nothing and mid-task mode/model
  switches stay safe (transient recompute, no persisted state).

### P6. Micro-guidance and teaching errors (critical thinking on the cheap)

Adopt dsh's two habits:

- Tool-adjacent one-liners instead of rules-section paragraphs. Concretely add:
  "Check the exit code on every command result; investigate failures before moving on." next to
  execute_command guidance, and the P4 documentation line next to the web tools. Audit
  rules.ts / objective.ts for sentences that can move next to their tool or be deleted; shorter
  rules sections measurably help small models comply.
- Every tool-argument validation failure returns, inside the tool error, a minimal correct
  invocation example for THAT tool (static string per tool, no LLM involved). Weak models retry
  correctly from an example far more reliably than from an abstract schema restatement.

### P7. search_task_history tool (truth-seeking after condense)

Port the idea of dsh's session-query family in minimal form: one tool `search_task_history`
(parameters: `query`, optional `before_index`) that greps the task's stored
api_conversation_history (including content shadowed by condense/prune, which P3 keeps citing).
When the model suspects "I knew this earlier", it can verify instead of confabulating. Low
implementation cost since history already persists per task.

## Explicitly NOT adopting

- **Cordis / everything-is-a-plugin.** Wrong scale for a VSCode extension fork; no user benefit.
- **Code Mode (`run_code`, tools presented as a code API).** Actively hostile to weak models:
  writing orchestration code that calls tools requires more capability than calling tools.
- **Agent Teams, cordis\_\* self-modification tools, terminal PTY family, LSP tool.** Tumble has
  its own equivalents (orchestrator/subtasks, codebase index) or no need.
- **Ralph loop as a tool.** The orchestrator + new_task pattern already covers bounded
  delegation; a fresh-agent restart loop is a workflow the user can script. Revisit only if
  long-horizon tasks with small-context models become a daily pattern; the transferable idea
  (only a bounded structured report crosses rounds, the workspace is the memory) is worth
  keeping in mind for subtask report design.
- **exit_plan_mode-style soft plan mode.** Tumble's Architect mode plus the plan-review branch
  stack already owns this space.

## Suggested order of implementation

Each item is one branch (per repo convention), roughly in value/risk order:

1. P4 web tools (self-contained, immediate user-visible value, SearXNG backend already running).
2. P2 generic spill + read_artifact (builds on existing OutputInterceptor).
3. P3 pruning-before-condense (depends on P2 only for maximum effect, not functionally).
4. P6 micro-guidance + teaching errors (small diffs, prompt A/B on agent-bench).
5. P5 slim toolset per profile.
6. P1 prompt reordering + cache contract (gate on Z.ai cache probe + agent-bench, per memory).
7. P7 search_task_history.

## Open questions for the user

- P1: is the Z.ai/GLM endpoint's prefix cache observable enough to justify the reorder now, or
  should the probe run first? (Memory says probe first.)
- P4: SearXNG as the default backend with the instance URL in settings, correct?
- P5: should "slim" also hide MCP tools by default for small-model profiles?
