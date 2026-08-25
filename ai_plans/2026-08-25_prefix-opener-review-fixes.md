# Stable prompt opener: stop promising a section that is not always there

Date: 2026-08-25
Branch: `feat/35-prefix-opener-fix` (stacked on `feat/33-prune-row-forced-truncation`, which
already carries every `feat/30` change)
Source: adversarial review of `feat/30-prefix-stability` (commit 76531a83a, "feat(prompts):
stable-prefix system prompt layout for KV-cache reuse").

## Background

`feat/30` reordered the system prompt into a stable head plus a variable tail so that providers
that cache by prompt prefix (llama.cpp locally, Z.ai/GLM and DeepSeek-style endpoints remotely)
keep their KV cache across a mode switch. "KV cache" here means the key/value tensors a provider
stores for a request and reuses for the next one, but only up to the first byte that differs.

Because the mode's `roleDefinition` no longer opens the prompt, `feat/30` added
`STABLE_PROMPT_OPENER` (`src/core/prompts/system.ts`): one constant sentence group, byte-identical
in every mode, whose job is to tell a weak model who it is and where the rest of its mode is
written down. The pointer is load-bearing, not decorative, which is exactly why a wrong pointer is
a real defect rather than a typo.

## Review findings

All four findings were ACCEPTED. None was refuted.

### Defect 1 (blocker): the opener promised a conditional block unconditionally

The shipped text was:

> You are Tumble Code, an AI coding agent. Your mode is defined at the end of this prompt and both
> parts of it are binding on you: the MODE section states your role, and the "Mode-specific
> Instructions" block inside USER'S CUSTOM INSTRUCTIONS states the rules you must follow in that
> mode.

Evidence that the promise is false:

- `addCustomInstructions` pushes the block only behind a guard:
  `if (typeof modeCustomInstructions === "string" && modeCustomInstructions.trim())` at
  `src/core/prompts/sections/custom-instructions.ts:478-480`.
- In `DEFAULT_MODES` (`packages/types/src/mode.ts:186-256`) the `code` mode entry has no
  `customInstructions` key at all. `architect`, `ask`, `debug` and `orchestrator` all have one.
- Confirmed against the real assembly, not by reading: the new test
  "proves the block really is absent for code and present for orchestrator" builds both prompts
  through `SYSTEM_PROMPT` and asserts `code` does not contain `Mode-specific Instructions:` while
  `orchestrator` does.

So in the default mode, the mode most sessions run in, the very first sentence of the prompt sent
a weak model to look for a section that is not in the prompt. That is the worst possible failure
for a pointer whose entire purpose is to survive weak models: the model either hunts for missing
text or concludes the prompt is inconsistent.

### Defect 2: "at the end of this prompt" is wrong

The variable tail has seven entries, in this order (`src/core/prompts/system.ts`, `variableTail`):
MCP SERVERS, MODES, AVAILABLE SKILLS, RULES, MODE, USER'S CUSTOM INSTRUCTIONS, deferred-tools
catalog. MODE is fifth of seven, and two more sections render after it, one of which is the very
last thing in the prompt by design. "At the end" is therefore false, and it is false in a way a
literal-minded model can act on (skipping to the tail and reading the catalog).

### Finding A (test gap): nothing checked that the opener's promises are kept

`prefix-stability.spec.ts` asserted that each prompt STARTS WITH `STABLE_PROMPT_OPENER`, but
nothing asserted that the sections the opener NAMES actually exist in the assembled prompt. That
is why defect 1 shipped green.

### Finding B (minor): the documented worst-case measurement went stale

`MIN_SHARED_PREFIX_BYTES = 8000` was documented against a measured worst case of 8252 bytes. Any
reword of the opener changes that number, so the comment had to be re-measured, not guessed.

## What changed

### 1. The opener text (`src/core/prompts/system.ts`)

New text, 221 bytes (the old one was 287, so 66 bytes shorter):

> You are Tumble Code, an AI coding agent. Your mode is defined later in this prompt: the MODE
> section states your role, and any mode-specific rules for you appear inside USER'S CUSTOM
> INSTRUCTIONS. Both are binding on you.

Design constraints it satisfies:

- **Unconditional truth only.** "any mode-specific rules for you appear inside USER'S CUSTOM
  INSTRUCTIONS" is a conditional statement about where such rules live IF there are any. It is
  true for `code` (there are none, so nothing is missing) and true for `orchestrator` (there are,
  and that is where they are). The named container, USER'S CUSTOM INSTRUCTIONS, does render in
  every mode, because `SYSTEM_PROMPT` always passes a language and `addCustomInstructions` always
  emits at least the "Language Preference" entry; the new per-mode test asserts this for all five
  built-in modes rather than trusting the argument.
- **Still points at MODE**, which is the whole reason the opener exists.
- **Still one constant string**, byte-identical across modes, workspaces and profiles, so the
  KV-cache property of `feat/30` is untouched.
- **Still tells the model the rules bind it.** "Both are binding on you" keeps the anti-pattern
  `feat/30` was guarding against: a weak model reading its own operating protocol as an optional
  user wish, because the block sits under a heading that calls it "instructions provided by the
  user".

The doc comment above the constant now states the rule that produced the defect ("every claim has
to be true in EVERY mode, because the string is a constant and cannot adapt") and records both
false claims, so the next person to edit it sees the trap.

### 2. New test block (`src/core/prompts/__tests__/prefix-stability.spec.ts`)

A new `describe("stable opener points only at sections that exist")` with five cases:

1. the opener really contains the phrases the fixture keys on (guards the fixture from a reword
   quietly making the rest vacuous);
2. the opener does not contain "Mode-specific Instructions";
3. the opener does not contain "at the end of this prompt";
4. `it.each(MODES)` over code, architect, ask, debug, orchestrator: build the REAL prompt via
   `SYSTEM_PROMPT`, assert it starts with the opener, assert `====\n\nMODE\n\n` and
   `====\n\nUSER'S CUSTOM INSTRUCTIONS` are both present, and assert the implication "if the
   opener names the Mode-specific Instructions block, the prompt must contain it";
5. a non-vacuity control proving the block is genuinely absent for `code` and present for
   `orchestrator`.

Case 4 is written as an implication rather than a fixed string match on purpose: it keeps testing
the right property after any future reword, instead of encoding today's sentence.

### 3. Floor comment re-measured (finding B)

The long comment above `MIN_SHARED_PREFIX_BYTES` now carries the re-measured numbers, states why
the floor did NOT follow the measurement down, and points at the computed assertion below it as
the real guard. Details and numbers in "Measurements".

### 4. Documentation

`ai_plans/2026-08-24_ws-f-prefix-audit.md` quoted the shipped opener verbatim and carried the
measured byte table. Both were amended: the quote now shows the new text with the old one kept
below it as history, and the table gained an amendment note with the recomputed numbers.

`CONTRIBUTING.md` needed no change: its KV-cache contract section refers to the "identity opener"
generically and never quotes the sentence.

Two older docs were deliberately LEFT alone, because they record proposals, not shipped text:
`ai_plans/2026-08-24_dsh-adoption-implementation-plan.md:339-340` and
`ai_plans/2026-08-24_deepseek-harness-inspirations.md:133-134` both contain draft openers that
were never shipped, and the WS-F audit already records that the plan's wording was a plan-level
bug. Rewriting them would falsify the record of what was originally proposed.

## Measurements

Minimum pairwise shared prefix across the five built-in modes, measured by instrumenting the
existing test loop and reading the numbers back out (then removing the instrumentation):

| Pair                      | After (measured) | Before (measured + 66) |
| ------------------------- | ---------------- | ---------------------- |
| code vs orchestrator      | 8186 B           | 8252 B                 |
| architect vs orchestrator | 8186 B           | 8252 B                 |
| ask vs orchestrator       | 8186 B           | 8252 B                 |
| debug vs orchestrator     | 8186 B           | 8252 B                 |
| code vs architect         | 11820 B          | 11886 B                |
| architect vs debug        | 11827 B          | 11893 B                |

The "after" column was measured. The "before" column is the measured value plus 66, which is
sound because the opener is the FIRST thing in the prompt and nothing else moved: shortening it by
66 bytes shifts every later byte by exactly 66. The arithmetic is confirmed at both ends by the
two figures `feat/30` recorded independently: the hub-connected worst case 8252 measures 8186 now,
and the hub-with-no-servers figure 11684 measures 11618 now. The stable head itself now ends at
byte 8177 (was 8243).

**New worst case: 8186 bytes** (code or any mcp-group mode vs orchestrator, with an MCP hub
connected; orchestrator has no `mcp` group, so the two prompts part company at the first tail
section).

**Floor: `MIN_SHARED_PREFIX_BYTES` stays at 8000.** It was NOT lowered. The comment already says
the number may only go up unless a change deliberately shortens head text, and that is precisely
what happened here, so following the measurement down would be wrong twice over: it would weaken
the guard, and it would treat a text edit as if it were the regression the floor exists to catch
(something mode-dependent creeping into the stable head). The remaining margin is 186 bytes (was
252), documented in the comment. The real guard is unchanged: the computed assertion below the
floor derives the head's end from where the memory-index stub ends and requires the shared prefix
to cover all of it, so it cannot go stale.

## Mutation check (proof the new test is not vacuous)

Method: with the new test in place, the opener constant in `src/core/prompts/system.ts` was
temporarily reverted to the exact old sentence, and only the new describe block was run
(`npx vitest run core/prompts/__tests__/prefix-stability.spec.ts -t "opener points only at
sections that exist"`).

Result: **3 failed, 6 passed**. The failures were

- "does not promise the conditional Mode-specific Instructions block",
- "does not claim the mode is defined at the end of the prompt",
- "delivers every section the opener names, in code mode" (the implication in case 4, which is the
  case that would catch a future reword this branch cannot anticipate).

Note that the per-mode case failed for `code` ONLY, exactly as the defect predicts: architect,
ask, debug and orchestrator all have `customInstructions`, so their prompts do contain the block
and the implication holds for them. The opener was then restored and the suite returned to green.

## Snapshots

Seven `.snap` files changed, all of them by exactly one line, the first line of the prompt:

- `__snapshots__/prefix-stability/canonical-code-prompt.snap`
- `__snapshots__/system-prompt/consistent-system-prompt.snap`
- `__snapshots__/system-prompt/with-mcp-hub-provided.snap`
- `__snapshots__/system-prompt/with-undefined-mcp-hub.snap`
- `__snapshots__/add-custom-instructions/architect-mode-prompt.snap`
- `__snapshots__/add-custom-instructions/ask-mode-prompt.snap`
- `__snapshots__/add-custom-instructions/mcp-server-creation-disabled.snap`

The diff was inspected line by line: no section moved, no other byte changed.

## Verification

`cd src && npx vitest run core/prompts/` : 25 files, 361 tests, all passing, which covers the four
files the review named (`prefix-stability.spec.ts`, `sections/__tests__/prefix-determinism.spec.ts`,
`system-prompt.spec.ts`, `sections.spec.ts`) plus the rest of the prompt suite.

## KV-cache effect

`KV-cache: one-time prefix invalidation`. The first sentence of every prompt changes, so every
in-flight conversation re-prefills once, on any provider that caches by prefix. After that the
prefix is stable again and shares 8186 bytes across a mode switch, the same contract `feat/30`
established, 66 bytes shorter. The invalidation is unavoidable: the defect IS in the first
sentence.

## Deliberately out of scope

- The gap between `USER'S CUSTOM INSTRUCTIONS` being a container for BOTH user text and mode text
  is a real prompt-design smell (the heading tells the model this is "provided by the user" while
  part of it is the mode's own protocol). Fixing it means giving mode instructions their own
  section, which is a bigger change with its own KV-cache and snapshot cost, and it is not what
  this review asked for.
- The Z.ai cache probe and the agent-bench A/B that `feat/30` deferred are still owed before the
  stack merges. This branch does not change that.
