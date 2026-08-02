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
   stale, heartbeat the held lock descriptor, and use inode plus token checks for
   ownership-safe release/recovery rather than trusting PID liveness. Retain
   atomic temp-write/fsync/rename, and prove independent Node writers preserve
   both updates plus stale-lock and error cleanup behavior.

## 2026-08-01 final security/concurrency closure

The two remaining findings replace parts of the preceding blocking design:

1. **Immutable startup identity.** Server construction resolves the startup
   workspace exactly once with `realpath` and retains that canonical directory as
   the default and security root. A symlink used at startup therefore identifies
   its original target, and retargeting that pathname later cannot move session,
   handoff, or plan access. Ordinary explicit workspace arguments must resolve to
   that same canonical path. The deliberate cross-workspace startup opt-in keeps
   its broader path-based behavior. Workspace-isolated plan listing and reading
   require verification of the path behind the opened descriptor: Linux uses
   `/proc/self/fd/<fd>`; other platforms fail closed until an equivalent supported
   API exists. Tests cover symlink startup, post-start retarget, Linux containment,
   and the platform-gated fail-closed result.
   _Superseded on 2026-08-02: the fail-closed branch is replaced by a portable
   check, see below._
2. **Immutable handoff update journal.** The stale pathname lock is removed; it
   cannot fence a paused owner that resumes after another process revokes it.
   Creation still atomically publishes the compatible `<id>.md` base document.
   Every update instead atomically publishes one unique immutable JSON operation
   under `<id>.md.updates/<timestamp>-<uuid>.json`. Readers ignore malformed and
   orphaned `.tmp` files, sort complete operations by revision, preserve every log
   entry, merge pick-up metadata deterministically, and resolve statuses by the
   monotone order `open < picked-up < abandoned < done`. Independent writers
   never replace one another's revisions; a crash before rename leaves only a
   harmless cleanable temp file, while a crash after rename leaves a complete
   durable operation. Existing handoffs need no migration: an absent sidecar is
   an empty journal. Sidecars must be retained with their base Markdown file;
   orphaned `.tmp` files may be deleted at any time. Multiprocess tests cover a
   delayed writer, a killed writer paused before publication, surviving updates,
   and failed atomic publication. No native dependency is introduced.

## 2026-08-02 review of the unreviewed tail

The three commits that closed the races (`64b0a21a3`, `6b7e7587c`, `ce5e426b7`)
never had a review pass of their own — the last one replaced the lock design the
previous review rejected. Reviewing them found no security hole, and five defects
where the system reported something untrue. What changed:

1.  **A handoff can move backwards again.** Resolving statuses by the monotone
    order `open < picked-up < abandoned < done` also applied to _sequential_
    updates, so a task marked done by mistake could never be reopened, and
    `update_handoff` answered `is now done` to a caller that asked for `open`.
    Every mutable field is now a last-writer-wins register: the operation with the
    highest revision to name a field wins, whatever order operations arrive in.
    The total order over revisions already made that deterministic for competing
    writers, so ranking statuses bought nothing and cost reversibility.
2.  **The base document is folded, not left stale.** Nothing rewrote `<id>.md`
    after creation, so its frontmatter said `status: open` for finished work and
    no log entry ever reached the file people actually open. Each update now folds
    the journal into the document and deletes the operations it has absorbed.
    Correctness across compaction is why the registers are stored in the
    frontmatter (`statusRevision`, `pickedUpByRevision`,
    `pickedUpSessionIdRevision`) next to `foldedRevisions`: an operation whose
    `rename` lands after a compaction is _older_ than what the document carries,
    and applying it on top would let a stalled writer win by being late — a
    regression the existing multiprocess test caught during this work. Deletion is
    guarded by the fold the document on disk actually claims, so a competing
    compaction cannot delete an operation it never absorbed. A reader that sees
    the base replaced under it restarts.
3.  **Empty updates publish nothing.** An update carrying no status, note or
    pick-up detail wrote a revision that folded to nothing, so a retrying model
    grew the journal for free.
4.  **Plan access works on every platform.** Requiring `/proc/self/fd` meant
    workspace-isolated plan listing and reading returned nothing at all on macOS
    and Windows — and said `No plan documents found.`, which a caller cannot tell
    from a workspace without plans. Verification now has a portable form: after
    opening, prove no component between the plan root and the file is a symlink,
    and prove the file at that path is the object the descriptor holds. A swap
    during the open is caught either way — left in place it is seen as a link,
    reverted it leaves the descriptor pointing at a different object. Linux keeps
    `/proc/self/fd`, which settles it without walking anything. Where a filesystem
    reports no inode identity the check degrades to the symlink walk, which still
    refuses a planted link.

        The fail-closed branch was also the one test the suite could never run: it was
        gated to non-Linux, so on this machine and on CI it was asserted and skipped.
        Both containment paths now run wherever the suite runs, via a `containment:

    "portable"` seam, and the suite has no skips left.

5.  **One rule for what counts as the same workspace.** Authorization resolved
    symlinks (`realpath`) while the listings compared resolved strings, so a
    session recorded through a symlinked workspace was readable by id and absent
    from every listing — for an agent, indistinguishable from not existing. VS
    Code records whatever path the folder was opened by, so this is the ordinary
    case rather than a contrived one; Claude Code slugs `process.cwd()`, which the
    kernel has already resolved. `samePath` now canonicalizes both sides and is
    the one comparison the readers, the handoff store and the server all use. It
    is memoized, which matches the server already pinning its own workspace
    identity for its lifetime.

## 2026-08-02 shared-memory hardening closure

Independent re-checking confirmed four further findings in the handoff/plan tail:

1. **Compaction is a materialized view, not garbage collection.** Two compactors
   can read different snapshots and publish in reverse order. The older publisher
   can therefore replace `A+B` with `A`; deleting journals already claimed by the
   transient newer base then loses `B`. Immutable operation files now remain the
   recovery authority. Readers fold every revision absent from whichever base is
   currently visible, so a stale publication changes only the materialized file,
   never logical state. This intentionally trades bounded sidecar growth for a
   portable, crash-safe design without an unsafe reclaimable lock or unavailable
   compare-and-swap rename. A deterministic test pauses the `A` compactor, lets an
   `A+B` compactor publish, then releases `A` and proves `B` still survives.
2. **Revisions are logical, not wall-clock order.** New revisions reserve a
   Lamport counter with an exclusive, immutable claim file observed alongside the
   base registers and journals, with UUID only as an identity suffix. Sequential
   and overlapping writers therefore increase causally even in one millisecond,
   after clock rollback, or while an earlier writer delays journal publication;
   competing processes that select one counter race on `open("wx")`, and the loser
   retries at the next counter. Claims remain beside the immutable journal (a
   crashed reservation merely leaves a harmless skipped counter).
   `updateHandoff` reports which requested registers still own the surviving
   revision, and MCP no longer claims a requested state when it was superseded.
3. **Atomic replacement includes best-effort rename durability.** Temp contents
   are fsynced before rename, then the parent directory is opened and fsynced.
   Linux normally provides the intended rename-durability guarantee. macOS may
   accept a directory handle but does not promise Linux-equivalent metadata
   durability from `fsync`; Windows cannot open directories through Node, and
   individual filesystems may reject directory fsync. The second step is therefore
   explicitly best-effort and never makes a successful rename fail.
   Mocked-boundary coverage proves ordering and unsupported-platform behavior.
4. **Privilege broadens roots only.** Every plan, including privileged Claude
   global plans, now receives post-open descriptor/path containment verification.
   A regression test retargets an ancestor after `realpath` and before `open`, then
   proves the escaped descriptor is rejected; it is skipped only on Windows where
   the test setup cannot create the required directory symlink without privileges.

Validation for this closure is the complete package-local Vitest suite,
`pnpm check-types`, formatting of every touched file, and `git diff --check`.
