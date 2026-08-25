# WS-F audit: system-prompt prefix stability and section order

Date: 2026-08-24
Branch: `feat/30-prefix-stability` (stacked on feat/29 WS-E, feat/28 WS-D, feat/27, feat/26, feat/25)
Plan: [2026-08-24_dsh-adoption-implementation-plan.md](2026-08-24_dsh-adoption-implementation-plan.md), section "WS-F"
KV-cache effect of this workstream: **one-time prefix invalidation** (every existing conversation
re-prefills its system prompt once, because the whole prompt reorders).

## Why this exists

Providers that serve a request do not re-read the prompt from scratch if they already hold the
key/value tensors ("KV cache") of an earlier request that starts with the same bytes. They reuse
the cache up to the FIRST byte that differs and recompute everything after it. llama.cpp does this
for local models, Z.ai/GLM and DeepSeek-style endpoints do it server-side and bill cached tokens
at a lower rate.

Before this change the mode's `roleDefinition` was the first thing in the prompt, so switching
mode (which orchestrator flows do constantly) invalidated the cache from token 1. Measured on the
built-in modes with the real assembly, the prefix two modes shared was **17 bytes**: the
length of `"You are Tumble, a"`.

## Method

Measured with a throwaway spec that calls the real `SYSTEM_PROMPT` for five built-in modes
(code, architect, ask, debug, orchestrator) with identical settings, then compares every pair
byte by byte. `os`, `os-name`, the shell util, `vscode`, the MODES section and the memory
sections were stubbed to fixed values so the numbers are reproducible on any machine; everything
else is the production code path. The permanent version of that measurement now lives in
`src/core/prompts/__tests__/prefix-stability.spec.ts`.

The measurement is run TWICE, because the answer depends on whether an MCP hub is connected:

- **with a hub connected** (two servers), orchestrator has no `mcp` group while the other four
  modes do, so a code-to-orchestrator switch parts company at the MCP SERVERS section, the very
  first entry of the variable tail. That is the worst realistic case and the one an orchestrator
  flow actually pays.
- **with no hub**, MCP SERVERS is empty for every mode, so the shared region runs on through
  MODES and RULES.

## Result

| Measurement                                               | Before  | After   |
| --------------------------------------------------------- | ------- | ------- |
| Min pairwise shared prefix, five modes, MCP hub connected | 17 B    | 8252 B  |
| Min pairwise shared prefix, five modes, no MCP hub        | 17 B    | 11684 B |
| Stable head (sections 1 to 7), memory stubbed short       | n/a     | 8243 B  |
| Whole prompt, code mode, hub connected, same stubs        | 11779 B | 12324 B |

Both "after" numbers come from one run of the same script, so the doc and the test's
`MIN_SHARED_PREFIX_BYTES` floor (8000, the hub-connected worst case with tolerance) describe the
same experiment. The hub-connected figure (8252) is the stable head (8243) plus its trailing
separator: exactly the contract, nothing more. The no-hub figure (11684) is larger because MODES,
RULES and the `====\n\nMODE\n\n` header happen to match too; that is a bonus, not a promise, and a
mode with its own MCP allowlist or its own skills does not get it.

> **Amended 2026-08-25** (see `ai_plans/2026-08-25_prefix-opener-review-fixes.md`). The stable
> opener was reworded and is now 66 bytes shorter, so every "after" number above drops by exactly
> 66: hub connected 8252 to **8186**, no hub 11684 to **11618**, stable head 8243 to **8177**,
> whole prompt 12324 to **12258**. The `MIN_SHARED_PREFIX_BYTES` floor stays at 8000, because a
> deliberate shortening of head text is not the regression that floor exists to catch.

With memory enabled the head grows by the memory behavioral section (9225 B measured) plus the
`MEMORY.md` index (up to 25 KB), so on a real installation the shared prefix is roughly 17 to 42 KB
instead of 17 bytes.

## Section catalog

Varies-with classes: **(a)** constant everywhere, **(b)** per-mode, **(c)** per-settings or
per-workspace or per-machine (fixed for a given install and workspace, identical across modes),
**(d)** mutates within a single conversation.

| Section                    | Varies with                                        | Class | Bytes (approx) | Old position        | New position    |
| -------------------------- | -------------------------------------------------- | ----- | -------------- | ------------------- | --------------- |
| Stable opener (new)        | nothing                                            | a     | 287            | did not exist       | 1 (head)        |
| MARKDOWN RULES             | nothing                                            | a     | 325            | 2                   | 2 (head)        |
| TOOL USE                   | nothing                                            | a     | 363            | 3                   | 3 (head)        |
| Tool Use Guidelines        | nothing                                            | a     | 1430           | 4                   | 4 (head)        |
| Output Efficiency          | nothing                                            | a     | 656            | 5                   | 5 (head)        |
| OBJECTIVE                  | nothing                                            | a     | 1756           | 11                  | 6 (head)        |
| CAPABILITIES               | cwd (MCP sentence removed, see below)              | c     | 1914           | 6                   | 7 (head)        |
| SYSTEM INFORMATION         | OS, shell, home dir, cwd                           | c     | 1414           | 10                  | 8 (head)        |
| Memory behavioral section  | memory enabled, memory dir, cwd                    | c     | 9225           | 9                   | 9 (head)        |
| MEMORY.md index            | contents of MEMORY.md (rewritten by the agent)     | d     | 0 to 25000     | 13 (last)           | 10 (head end)   |
| MCP SERVERS (new section)  | mode's `mcp` group and `allowedMcpServers`         | b     | 200            | inside CAPABILITIES | 11 (tail)       |
| MODES                      | installed and custom modes                         | c     | ~1000          | 8                   | 12 (tail)       |
| AVAILABLE SKILLS           | current mode, installed skills                     | b     | 0 to ~3000     | 8b                  | 13 (tail)       |
| RULES                      | cwd, shell, `isStealthModel`                       | c     | 3373           | 9                   | 14 (tail)       |
| MODE (role definition)     | current mode, prompt overrides                     | b     | 167 to ~1500   | 1 (first!)          | 15 (tail)       |
| USER'S CUSTOM INSTRUCTIONS | language, global and mode instructions, rule files | b     | 0 to unbounded | 12                  | 16 (tail)       |
| Deferred-tools catalog     | `tools_load` calls made SO FAR in this task        | d     | 0 to ~2000     | 7                   | 17 (tail, LAST) |

Byte counts come from the canonical snapshot
(`src/core/prompts/__tests__/__snapshots__/prefix-stability/canonical-code-prompt.snap`), which
stubs the memory sections and the MODES list; the memory number is measured separately from
`buildMemoryLines`, and MODES is estimated from a default installation.

### The two class-(d) sections

Only two sections can change while a task is running, and both had to be placed with that in mind.

- **The deferred-tools catalog** shrinks on every `tools_load` call: the resolver records the
  materialized names on the Task (`src/core/task/deferred-tools-resolver.ts` appends to
  `materializedDeferredTools`) and the next build drops those entries from the catalog. At its
  original tail position 2 that mutation invalidated MODES, SKILLS, RULES, MODE and the whole
  custom-instructions block behind it, which is roughly 5 KB re-prefilled for a change of a few
  dozen bytes. It is now the LAST section in the prompt, so the invalidation costs its own bytes
  and nothing else. Being last also gives its two-step procedure the recency a weak model needs.
- **The MEMORY.md index** changes when the agent writes a memory. It stays at the END of the
  stable head, per the plan, because it is mode-independent: keeping it there buys back up to
  25 KB on every mode switch, and the price is invalidating the ~5 KB tail on the much rarer
  memory write. This is the one place where the head holds something that can change mid-task,
  and it is a deliberate trade rather than an oversight.

## Changes beyond pure reordering

Everything below is a content change, not just a move. Each is listed because the plan says the
workstream is about ORDER, so any deviation has to be visible in review.

1. **New stable opener** (`STABLE_PROMPT_OPENER` in `src/core/prompts/system.ts`). The pointer is
   load-bearing: a weak model that no longer reads its persona in the first sentence has to be
   told where it lives. Shipped text (as amended on 2026-08-25, see
   `ai_plans/2026-08-25_prefix-opener-review-fixes.md`):

    > You are Tumble Code, an AI coding agent. Your mode is defined later in this prompt: the MODE
    > section states your role, and any mode-specific rules for you appear inside USER'S CUSTOM
    > INSTRUCTIONS. Both are binding on you.

    The text WS-F originally shipped was:

    > You are Tumble Code, an AI coding agent. Your mode is defined at the end of this prompt and
    > both parts of it are binding on you: the MODE section states your role, and the
    > "Mode-specific Instructions" block inside USER'S CUSTOM INSTRUCTIONS states the rules you
    > must follow in that mode.

    A review found two false claims in it. First, "Mode-specific Instructions" renders only when
    the mode has non-empty `customInstructions`, and the default `code` mode has none, so the most
    used mode of all was pointed at a block that is not in its prompt; the replacement says "any
    mode-specific rules for you", which is true whether or not the block is there. Second, "at the
    end of this prompt" is wrong: MODE is the fifth of seven tail sections, with USER'S CUSTOM
    INSTRUCTIONS and the deferred-tools catalog after it; the replacement says "later in this
    prompt".

    **The plan's verbatim wording was corrected here; treat this as a plan-level bug.** The plan
    specified "Your current mode, its role, and its rules are defined in the MODE section at the
    end of this prompt", which is false in this codebase: the MODE section carries only
    `roleDefinition`. A mode's actual rulebook is its `customInstructions` (for example the
    orchestrator's eight-point delegation protocol in `packages/types/src/mode.ts`), and that
    renders much further down as the "Mode-specific Instructions" block inside USER'S CUSTOM
    INSTRUCTIONS, under a heading that introduces the whole block as "instructions provided by the
    user". A weak model that followed the plan's pointer would read two sentences of persona,
    never find rules there, and then meet its own operating protocol framed as a user's wish. The
    shipped opener names both destinations and states plainly that both bind the model. It is
    still three short sentences and still byte-identical across modes, so the KV-cache property is
    intact.

2. **New MODE section header.** The role definition is now wrapped in `====\n\nMODE\n\n...` so the
   opener's pointer refers to something that exists. An empty role definition emits nothing.
3. **The MCP availability sentence moved out of CAPABILITIES** into its own tail section
   (`getMcpAvailabilitySection`, `====\n\nMCP SERVERS`). The sentence itself is unchanged except
   for the leading "- " bullet marker, which was dropped because the sentence is now the whole
   body of its own section. The emit condition is unchanged: the mode must carry the `mcp` group
   and at least one allowlisted server must be connected. `getCapabilitiesSection` lost its
   `mcpHub` and `allowedMcpServers` parameters as a result.
4. **A stray tab disappeared.** The old template indented `# Tool Use Guidelines` with a literal
   tab, which in markdown makes the heading and its first lines read as an indented code block.
   The new join-based assembly trims each section, so the heading is now a heading.
5. **Blank-line runs are canonical.** Sections are joined with exactly one blank line and empty
   sections drop out entirely. The old template literal emitted a varying number of blank lines
   depending on which optional sections were empty, which is a difference in bytes for no
   difference in meaning.
6. **`undefined` can no longer reach the prompt.** The old template rendered the literal string
   "undefined" if a section builder returned nothing; the join guards with `?? ""`.
7. **CAPABILITIES now prints the workspace path through `toPosix()`**, like RULES and SYSTEM
   INFORMATION already did. On posix hosts the bytes are unchanged; on Windows the prompt used to
   spell the same directory two ways in one prompt (backslashes here, forward slashes there),
   which is the kind of contradiction a weak model resolves by inventing a third spelling.

## Nondeterminism found and fixed

1. **Rule-file ordering was locale-dependent and readdir-dependent**
   (`src/core/prompts/sections/custom-instructions.ts`). Files were sorted with
   `filenameA.localeCompare(filenameB)` and no locale argument, so the collation depended on the
   runtime's locale, and two files sharing a basename in different subdirectories compared equal,
   which left their relative order equal to `fs.readdir` order (filesystem-dependent, not stable
   across a rescan). Fixed: locale pinned to `"en"`, full path as the tie-breaker.
2. **Skills were listed in `fs.readdir` order** (`src/core/prompts/sections/skills.ts`).
   `SkillsManager` stores skills in a `Map` filled while scanning directories, and `Map` iteration
   is insertion order. Fixed: the prompt section sorts by name, then path, with plain code-unit
   comparison (deliberately not `localeCompare`, which would put the locale back in).
3. **MCP tool schemas followed connection order**
   (`src/core/prompts/tools/native-tools/mcp_server.ts`). `McpHub.getServers()` returns connection
   order; a server that reconnects (config edit, file watcher, manual restart) is deleted and
   re-appended, so it jumps to the end and shifts every schema after it, changing the tools array
   that providers hash as part of the request prefix. Fixed: servers are sorted by name in the
   tool-building path only. Tool order within a server is left alone (the server author's order,
   stable for a given server version), and the UI still reads `getServers()` directly so the user
   keeps seeing config order.

### Why the two comparators differ (deliberate, not an oversight)

Skills sort with plain code-unit comparison (`a.name < b.name`), rule files sort with
`localeCompare(b, "en")` plus a full-path tie-breaker. Two different answers to the same question,
for one reason: **what a change of order costs the user today.**

- Rule files already had a `localeCompare` order, and many users have several of them. Swapping to
  code-unit comparison would reorder existing rule sets wherever the two collations disagree (hyphens,
  underscores, digits, accented names), which is a SECOND one-time prefix invalidation on top of
  this workstream's, plus a silently different rule precedence for anyone who relies on file order.
  Pinning the locale to `"en"` removes the machine dependence while keeping the order every user
  already has. The residual risk is narrow: `localeCompare` output can still differ between ICU
  versions, so the guarantee is "stable on one machine and across machines with the same Node
  build", not "stable everywhere".
- Skills had NO order at all (the manager returns `fs.readdir` order), so there was no existing
  order to preserve and nothing to invalidate twice. That let the stronger option be chosen:
  code-unit comparison is ICU-independent and therefore byte-identical on every machine forever.

If the rule-file ordering ever needs a deliberate one-time invalidation for another reason, that is
the moment to switch it to code-unit comparison too, and the two comparators should then be merged.

Checked and found already deterministic:

- no `Date`, `Date.now`, `Math.random`, `process.env` or `toLocale*` anywhere under
  `src/core/prompts` or in `src/core/memory/memoryPrompt.ts`;
- the native tools array is a literal array iterated in order, and `filterNativeToolsForMode`
  preserves that order while filtering (tested);
- the deferred-tools catalog already sorts MCP groups by server name;
- `discoverSubfolderRooDirectories` already sorts its results;
- the MODES list follows built-in order then custom-mode file order;
- `McpHub.getServers()` deduplicates through a `Map` but preserves insertion order, and
  `updateServerConnections` connects sequentially in config-file key order.

## Deviations from the plan, and why

1. **OBJECTIVE is in the stable head; the plan's list did not mention it.** It is a constant with
   no inputs at all, so leaving it in the tail would have thrown away 1750 shared bytes. Placed
   after "Output Efficiency" and before the cwd-dependent sections, so the head runs
   constants first, then workspace facts.
2. **MODES and RULES stay in the tail, as the plan says, even though both are mode-independent.**
   Promoting them into the head would add roughly 4.4 KB to the CONTRACTUAL shared prefix. They
   are left in the tail because the plan's order is the source of truth for this workstream, and
   because RULES depends on the profile (`isStealthModel`) while MODES depends on the user's mode
   inventory: both are stable-per-install rather than stable-per-anything. With no MCP hub they
   land inside the shared region anyway (the 11684 vs 8243 gap, 11618 vs 8177 after the
   2026-08-25 opener amendment); with a hub connected and an
   orchestrator switch they do not, which is what makes the follow-up worth doing.
3. **The MEMORY.md index sits at the END of the head, per the plan, not in the tail.** This is a
   deliberate trade: the index is mode-independent, so keeping it in the head buys back up to
   25 KB on every mode switch, at the cost of invalidating the tail (roughly 5 KB) on the rarer
   event of the agent writing a memory mid-task. Documented here because it is the one place
   where the head holds something that can change during a task.
4. **The gate was NOT run, and is still owed before merge.** The plan gates WS-F behind a Z.ai
   prefix-cache probe and an agent-bench baseline; both need live endpoints, so neither could run
   here. The reorder was implemented anyway, on the plan's own open question 3 ("reorder anyway;
   local llama.cpp is a daily target"). Stating it plainly so nobody reads this document as
   evidence the gate passed: **the gate is deferred, not satisfied.** What it protects against is
   the risk in the plan's own Risks section, that "role at the end" weakens persona adherence in
   weak models, and the corrected opener (deviation note 1 above) reduces but does not disprove
   that risk. The revert is a pure reorder of two arrays in `system.ts`, so if the bench comes back
   worse, backing this out costs one commit and a snapshot regeneration.
5. **The opener's wording deviates from the plan's verbatim text** because the plan's text was
   factually wrong about where mode rules live. Full reasoning in "Changes beyond pure reordering",
   item 1.
6. **The deferred-tools catalog is last, not second, in the tail.** The plan's tail order put it
   right after the MCP availability section. It is the only section that mutates mid-task, so
   anything after it pays for every `tools_load` call; it moved to the end. See "The two class-(d)
   sections" above.

## Tests

`src/core/prompts/__tests__/prefix-stability.spec.ts` (new, 21 cases), all against the real
`SYSTEM_PROMPT` and the real `buildNativeToolsArrayWithRestrictions`:

- byte stability: two consecutive builds are `toStrictEqual` for code, architect, ask, debug and
  orchestrator, with the slim toolset off and on (10 cases);
- byte stability across settings: slim on and slim off are each reproducible AND different from
  each other (guards against a vacuous test);
- the whole stable head lies inside the prefix shared by slim-on and slim-off;
- common prefix: every pair of the five modes shares at least `MIN_SHARED_PREFIX_BYTES` (8000,
  the hub-connected worst case with tolerance, and a comment on how to update it legitimately:
  it may only go up unless a head section is deliberately shortened). The contractual assertion
  is computed, not hardcoded: the shared prefix must reach past the end of the memory index,
  which is the last head section. The pair also has to diverge eventually, so the test cannot
  pass vacuously;
- a control case showing that the worst-case number comes from the MCP group difference and not
  from a short head: two modes that both carry `mcp` share past the RULES section;
- section order: every head marker precedes every tail marker, and both groups are in their
  documented order;
- the deferred-tools catalog is the LAST section: with the experiment on, every other section
  marker has a smaller index than the catalog's;
- full-prompt snapshot for one canonical config, so an accidental reorder is a reviewable diff;
- advertised tool array: identical order across two builds, for a full and for a slim profile,
  with two MCP servers connected;
- MCP connection order does not matter: two hub stubs listing the same two servers in REVERSED
  order produce a byte-identical prompt (with `deferredTools` on, so the catalog really names the
  servers) and a byte-identical tools array.

`src/core/prompts/sections/__tests__/prefix-determinism.spec.ts` (new, 2 cases) guards the other
two ordering fixes at their own level, where the mocking is cheap:

- skills: a manager returning the skill list REVERSED produces identical section bytes;
- rule files: two files sharing a basename in different subdirectories render identically whatever
  order `fs.readdir` returns them in, exercising the real `loadRuleFiles` path.

All three ordering fixes were mutation-checked: reverting the skills sort and reverting the
rule-file tie-breaker each turn their test red (verified, then restored), and deleting the MCP
server sort turns the reversed-hub tools-array case red. Without that check these tests would be
decorations.

Snapshots deliberately regenerated (expected churn, whole prompt reordered):

- `__snapshots__/system-prompt/consistent-system-prompt.snap`
- `__snapshots__/system-prompt/with-mcp-hub-provided.snap`
- `__snapshots__/system-prompt/with-undefined-mcp-hub.snap`
- `__snapshots__/add-custom-instructions/architect-mode-prompt.snap`
- `__snapshots__/add-custom-instructions/ask-mode-prompt.snap`
- `__snapshots__/add-custom-instructions/mcp-server-creation-disabled.snap`
- `__snapshots__/prefix-stability/canonical-code-prompt.snap` (new)

Existing assertions deliberately flipped: three cases in `system-prompt.spec.ts` asserted the role
definition appeared BEFORE "TOOL USE"; they now assert it appears after, in the MODE section. Six
cases in `sections.spec.ts` moved from `getCapabilitiesSection` to `getMcpAvailabilitySection`, plus
a new case asserting CAPABILITIES never mentions MCP at all.

## Contract

`CONTRIBUTING.md` gained a "KV-cache contract" section: what the stable prefix is, the rule that a
new section defaults to the tail unless proven constant, and the requirement that any PR touching
model-visible text states its KV-cache effect (`prefix-stable`, `append-only`, or
`one-time prefix invalidation`) in the commit message.

## Open

- **Z.ai / GLM prefix-cache probe** and **agent-bench A/B** (GLM-5.3 and Qwen 27B profiles,
  task success and time-to-first-token after mode switches) are owed to the user; both need live
  endpoints and cannot run here. The reorder is a pure ordering change, so the revert is trivial
  if the bench shows weaker persona adherence with the role at the end.
- Promoting MODES and RULES into the stable head (deviation 2) is a cheap follow-up worth roughly
  4.4 KB of contractual shared prefix.
- `getSystemInfoSection` contains a hardcoded `'/test/path'` in its last paragraph, left over from
  a test fixture. It is constant, so it does not affect stability, but it is wrong text; out of
  scope here, worth a separate one-line fix.
- CAPABILITIES still names `execute_command` and `list_files` unconditionally, even for a mode
  without those groups. That is a correctness wart, not a stability one (the bytes are the same
  for every mode), so it was left alone rather than reworded inside a reordering workstream.
- **RULES leaks an MCP sentence into slim prompts** (pre-existing, arrived with WS-E). The bullet
  "MCP operations that change state should be used one at a time" is emitted unconditionally by
  `getRulesSection`, so a slim profile with `slimHidesMcp` on hides every MCP schema and every
  other MCP mention, then still tells the model how to sequence MCP operations it cannot perform.
  Harmless for cache stability (the bytes are the same for every mode), wrong for the weak models
  slim exists to serve. Not fixed here: it is WS-E's text, and changing it inside a reordering
  workstream would hide it in a diff nobody reads for content. Worth one conditional in a
  follow-up, together with the CAPABILITIES wart above.
- **Explicit-breakpoint providers do not benefit yet.** Anthropic-style caching marks the WHOLE
  system prompt as one cached block (`src/api/providers/anthropic.ts:135` and
  `src/api/transform/caching/anthropic.ts:7`), and such a block is all-or-nothing: one differing
  byte anywhere in it, including in the tail, misses the cache. This workstream therefore helps
  the implicit prefix caches it targets (llama.cpp, GLM/Z.ai, DeepSeek) and does nothing for
  Anthropic, Gemini or Vertex. The follow-up that would cash in the same reorder there is to send
  the system prompt as TWO text parts, breakpoint after the stable head only. That is a provider
  change, not a prompt change, so it is deliberately out of scope here.
