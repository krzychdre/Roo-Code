# Agent Interchange — Claude Code ⇄ Tumble Code

**Date:** 2026-07-31
**Branches:** `feat/agent-interchange-core` → `feat/agent-interchange-mcp` → `feat/agent-interchange-vscode` → `feat/shared-memory-with-claude-code` (stacked, merge in that order)

The memory branch was planned as independent, but sharing needs Claude Code's
slug rule and its project-directory reader, and one definition of that rule is
worth more than a second copy of it — so it stacks on the core package too.

## The ask

> "chciałbym aby było możliwe podjęcie zadań z Claude Code przez Tumble Code i odwrotnie.
> Wzajemne czytanie analiz zadań i planów itd. Pełny interchange."

Two agents work on the same repos on the same machine and cannot see each other's
work. A task investigated in Claude Code has to be re-explained from scratch to
Tumble Code, and vice versa.

## What the two stores actually look like

Measured on this machine, not assumed.

### Claude Code

`~/.claude/projects/<slug>/<sessionId>.jsonl` — one JSON object per line.

| record type             | carries                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user` / `assistant`    | `message` in Anthropic wire format, `parentUuid`, `uuid`, `sessionId`, `cwd`, `gitBranch`, `version`, `isSidechain`, `timestamp`; tool results also carry `toolUseResult` |
| `ai-title`              | model-generated session title (last one wins)                                                                                                                             |
| `last-prompt`           | most recent user prompt + `leafUuid`                                                                                                                                      |
| `file-history-snapshot` | per-message file backups                                                                                                                                                  |
| `queue-operation`       | prompt queue bookkeeping                                                                                                                                                  |

Content blocks are `text` / `thinking` / `tool_use` / `tool_result`.
Sidechains (`isSidechain: true`) are subagent turns interleaved in the same file.

Adjacent: `~/.claude/projects/<slug>/memory/` (MEMORY.md + fact files),
`~/.claude/plans/*.md` (plan-mode artifacts), `~/.claude/todos/`.

**Slug algorithm** — derived empirically from 20 real directories:

| cwd                                                  | directory                                            |
| ---------------------------------------------------- | ---------------------------------------------------- |
| `/home/krzych/Downloads/vpn_jurasz`                  | `-home-krzych-Downloads-vpn-jurasz`                  |
| `/home/krzych/Projekty/ITKONTEKST/jurasz.ai`         | `-home-krzych-Projekty-ITKONTEKST-jurasz-ai`         |
| `/home/krzych/Projekty/QUB-IT/k3s_2025_05_19/fluxcd` | `-home-krzych-Projekty-QUB-IT-k3s-2025-05-19-fluxcd` |

i.e. every non-alphanumeric character becomes `-`. This is **lossy and
ambiguous** (`k3s_2025` and `k3s-2025` collide), so lookup must scan the project
directories and read `cwd` back out of the records; the slug is only a fast path
and the address for the shared memory dir.

### Tumble Code

`<globalStorage>/qub-it.tumble-code/tasks/<taskId>/`

| file                            | carries                                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `api_conversation_history.json` | `ApiMessage[]` — Anthropic message shape plus `ts`                                                                          |
| `ui_messages.json`              | `ClineMessage[]` — `say`/`ask` UI stream (`api_req_started`, `reasoning`, `tool`, `completion_result`, `subtask_result`, …) |
| `history_item.json`             | `HistoryItem` — title, `workspace`, `mode`, `apiConfigName`, tokens, cost, `status`, `childIds`, `completionResultSummary`  |
| `checkpoints/`                  | shadow-git checkpoints                                                                                                      |

555 of 578 task directories on this machine carry `history_item.json`; the
remainder predate it, so the reader must fall back to `ui_messages.json`.
Memory lives at `<globalStorage>/memory/projects/<sanitizeCwd(cwd)>/memory/`
where `sanitizeCwd` maps non-`[a-zA-Z0-9-]` to `_` (`src/core/memory/paths.ts`).

### The lucky part

Both stores keep the conversation as **Anthropic content blocks**. The message
layer is already common; what differs is the envelope (JSONL-with-parent-chain
vs. two JSON arrays), the metadata, and the tool vocabulary
(`Read`/`Edit`/`Bash`/`TodoWrite` vs. `read_file`/`apply_diff`/`execute_command`/`update_todo_list`).

## Decisions taken with the user

1. **Transport:** one MCP server over a shared core library, plus native VS Code
   commands in the extension (only extension code can write Tumble's task
   history). Not the cloud API — the interchange must work offline and local.
2. **Depth:** _briefing + raw transcript on demand_. A handoff is a structured
   document; the full transcript is readable through a separate paginated call.
   No fabricated native sessions, no synthetic `tool_use` blocks — tool names,
   signed `thinking` blocks and `tool_use`/`tool_result` pairing do not survive
   translation, and a half-valid session file is worse than an honest briefing.
3. **Shared state:** unify the **memory directory** only. Plans and todos stay
   per-agent (read-only cross-visibility is provided by the MCP server).

## Design

```text
packages/agent-interchange/          ← core, no VS Code dependency
  src/types.ts                       canonical session/message model
  src/locate.ts                      find both stores; CC slug; VS Code variants
  src/readers/claude-code.ts         JSONL → canonical
  src/readers/tumble-code.ts         task dir → canonical
  src/tools.ts                       tool-vocabulary map (both directions)
  src/briefing.ts                    canonical → briefing markdown (deterministic)
  src/transcript.ts                  canonical → paginated readable transcript
  src/plans.ts                       workspace plans; global CC plans privileged
  src/handoffs.ts                    handoff store + lifecycle
  src/search.ts                      cross-store text search
  src/mcp/server.ts                  stdio MCP server exposing the above
```

**Handoff store:** `~/.local/share/agent-interchange/handoffs/` (override with
`$AGENT_INTERCHANGE_DIR`) — outside the repo, same convention as the `zoo-port`
ledger, so handoffs are not accidentally committed and survive branch switches.
One markdown file per handoff with YAML frontmatter (`id`, `from`, `to`,
`sourceAgent`, `sourceSessionId`, `cwd`, `gitBranch`, `status`, timestamps) and a
body of fixed sections.

**Briefing is derived, not model-written.** The renderer extracts, from the
canonical session:

- the opening request and the model-assigned title
- files touched, split into read vs. written (from `tool_use` inputs of both
  vocabularies)
- commands executed
- plans referenced (`ExitPlanMode` input, `ai_plans/*.md` paths seen in tool
  calls, architect-mode plan text)
- the last todo list state (`TodoWrite` / `update_todo_list`)
- open questions (`AskUserQuestion` / `ask_followup_question`)
- outcome (last assistant text / `attempt_completion` / `completionResultSummary`)
- token and cost totals, mode, model, branch

An agent picking the task up may of course add its own prose to the handoff, but
the factual skeleton never depends on a model having been honest about what it did.

**MCP tools** (descriptions written for weak models — few parameters, defaults
everywhere, compact markdown returns):

| tool                                                | purpose                                                   |
| --------------------------------------------------- | --------------------------------------------------------- |
| `list_sessions`                                     | both agents' sessions for a cwd, newest first             |
| `read_session`                                      | `briefing` (default) \| `transcript` \| `raw`, paginated  |
| `search_sessions`                                   | text search across both stores, with snippets             |
| `list_plans` / `read_plan`                          | workspace plans; global CC plans only with startup opt-in |
| `create_handoff`                                    | freeze a session into a handoff document                  |
| `list_handoffs` / `read_handoff` / `update_handoff` | the pick-up lifecycle                                     |

**VS Code side** (`src/`):

- `tumble-code.pickUpAgentSession` — QuickPick over Claude Code sessions and open
  handoffs → starts a new task seeded with the briefing.
- `tumble-code.createHandoff` — freeze the current task into a handoff for Claude
  Code to pick up.

**Shared memory** (independent branch): a `sharedMemoryWithClaudeCode` setting
resolves the per-workspace memory dir to `~/.claude/projects/<ccSlug(cwd)>/memory`
instead of `<globalStorage>/memory/projects/<sanitizeCwd(cwd)>/memory`, so both
agents read and write one `MEMORY.md` set. Guarded by the existing
`validateMemoryPath` and the `isAutoMemPath` containment check.

## Risks

- **Slug collisions** (`k3s_2025` vs `k3s-2025`) — mitigated by verifying `cwd`
  from the records after resolving a directory; a proven mismatch logs a warning
  and falls back to Tumble's isolated memory path.
- **Large transcripts** — the 8.9 MB session in this project's directory must not
  be loaded whole into an agent's context. Readers stream JSONL line by line and
  `read_session` is paginated with an explicit total count.
- **Store drift** — both formats are private to their tools. Readers are lenient:
  unknown record types are skipped, missing files fall back, and a parse failure
  degrades one session rather than the listing.
- **Concurrent writes** — Tumble may be writing a task while the reader reads it;
  reads are snapshot-tolerant (a truncated trailing JSONL line is dropped).

## Tests

- Fixture-based reader tests for both stores, including a task without
  `history_item.json` and a JSONL file with a truncated last line.
- Slug round-trip tests over the empirical table above.
- Briefing renderer golden tests for both vocabularies.
- Handoff lifecycle tests (create → list → pick up → complete).
- Memory path tests for the shared-root mode, including the collision warning and
  the `validateMemoryPath` rejections.

## 2026-08-01 review hardening

The accumulated stack review identified four release-blocking gaps. This pass is
strictly limited to them:

1. Scope every ordinary MCP list/read/handoff operation to the server's startup
   workspace. Empty workspace arguments are rejected, and session/handoff ids
   found in global stores are re-checked against that workspace. Deliberate
   cross-workspace operation requires a startup environment opt-in rather than a
   tool-call argument a model can invent.
2. Add a reproducible installer that copies the built bundle to durable user
   storage and merges/removes only the owned `agent-interchange` registration in
   Claude Code and Tumble Code configuration. Configuration writes are atomic;
   unrelated keys and servers survive install, update, and uninstall.
3. Treat a proven Claude project-slug collision as unsafe for shared memory.
   Preserve sharing for an unclaimed or matching directory, but fall back to the
   ordinary Tumble-isolated path and emit an actionable warning for a mismatch.
4. Serialize same-process handoff mutations and replace in-place rewrites with
   temp-file + fsync + rename atomic replacement. Tests cover competing updates
   and failed replacement without accepting a truncated destination.

Validation is package-local Vitest, typecheck, lint and build for
`@roo-code/agent-interchange`, focused extension memory tests, and extension
typecheck/lint/build where practical. The repository requests Node 20; the local
runtime used for this pass is recorded in the final report if it differs.

## 2026-08-01 final-review remediation

- Ordinary workspace-isolated MCP servers list and read only plans contained in
  the startup workspace. Claude Code's machine-global plan store is included
  only when the server starts with `AGENT_INTERCHANGE_ALLOW_CROSS_WORKSPACE=1`;
  the same gate protects direct known-path reads.
- Shared-memory collision detection scans every Claude session head in the slug
  directory. Only proven collisions are cached, so a directory that was empty or
  safe is rechecked and falls back immediately if a conflicting session appears.
- The installer preflights all inputs and applies bundle/config mutations as one
  rollback-capable operation. Failure-injection tests exercise install, update,
  and uninstall without touching live user configuration.
- Manual configuration examples use the durable installed bundle location, not
  a build artifact inside a checkout.

## 2026-08-01 final blocking findings

1. Resolve the startup workspace and each workspace plan root to their real
   paths. Reject plan-directory and Markdown-file symlinks whose opened targets
   escape those roots; on Linux, verify the already-open descriptor through
   `/proc/self/fd` to close the realpath/open race while retaining demonstrably
   safe in-root symlinks. Apply the same file-root containment to privileged
   global Claude plans without changing the explicit startup opt-in.
2. Protect each handoff read-modify-atomic-replace mutation with a bounded,
   token-owned interprocess lock. Recover only locks whose metadata timestamp is
   stale, retain atomic temp-write/fsync/rename, and prove independent Node
   writers preserve both updates plus stale-lock and error cleanup behavior.
