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

---

# Hardening round 2 (2026-08-25, second commit on `feat/35-prefix-opener-fix`)

Everything above describes the first commit, `e074bad44`. An adversarial verifier then re-reviewed
that commit. It PASSED it (no blocker, nothing refuted from the four accepted defects) but left
five suggestion-level findings. All five are implemented in this second commit. Nothing above is
rewritten; this section is the amendment.

## The five verifier findings

**Finding 1 (guard gap).** The opener's second promise, "your mode's own instructions ... appear
inside USER'S CUSTOM INSTRUCTIONS", relies on that header being present in every prompt. The header
is emitted only when `addCustomInstructions` collected at least one section
(`src/core/prompts/sections/custom-instructions.ts`, the trailing `joinedSections ? ... : ""`).
Every contributor is optional except the Language Preference entry, and nothing pinned that.

**Finding 2 (same defect class as the blocker, highest value).**
`packages/types/src/mode.ts` validated `roleDefinition: z.string().min(1, ...)`, which is not
trim-aware. A whitespace-only role definition (one space hand-edited into `custom_modes.yaml` or
`.roomodes`) passed validation, `getModeSection` then trimmed it to `""` and dropped the whole MODE
section, and the opener's FIRST promise became a pointer to a missing section. That is the same
defect the first commit removed, arriving by a different door.

**Finding 3 (test coverage).** The new opener-contract block only exercised the five built-in
modes. Custom modes take a different path through `getModeSelection` (a custom mode is used
ENTIRELY, with no merge against a built-in mode), and that is exactly the path Finding 2 protects.

**Finding 4 (weak-model wording).** "any mode-specific rules for you appear inside USER'S CUSTOM
INSTRUCTIONS" is a universal claim, and the same prompt contains a counterexample: AVAILABLE SKILLS
is filtered by the current mode (`src/core/prompts/sections/skills.ts`, the `<context_notes>` block
says so in as many words), so mode-scoped content demonstrably lives somewhere else too.

**Finding 5 (weak-model wording).** "Both are binding on you" has two referents in the previous
sentence, and one of them (the mode's own instructions) is empty in `code` mode. A weak model was
being told that an absent thing binds it.

## Fix 1: the opener, v2

```
You are Tumble Code, an AI coding agent. Your mode is defined later in this prompt and is binding on you: the MODE section states your role, and your mode's own instructions, if it has any, appear inside USER'S CUSTOM INSTRUCTIONS.
```

**231 bytes, plain ASCII, two sentences, no dashes of any kind.** What each clause buys:

- "Your mode is defined later in this prompt **and is binding on you**": bindingness now has ONE
  referent, "your mode", and every prompt has a mode. Findings 5. The mandatory force is not
  weakened; it moved from a trailing sentence with two shaky referents to the main clause with one
  solid one.
- "the MODE section states your role": unconditional, and after Fix 2 it is unconditional for
  custom modes too.
- "your mode's own instructions, **if it has any**, appear inside USER'S CUSTOM INSTRUCTIONS":
  conditional (the block only renders when the mode has `customInstructions`), and it says where
  the mode's OWN instructions go rather than claiming that all mode-scoped content is there.
  Findings 4.

v1 was 221 bytes, so v2 costs 10 bytes. That is the whole KV-cache price of the reword.

## Fix 2: trim-aware `roleDefinition` (Finding 2)

`packages/types/src/mode.ts`:

```ts
roleDefinition: z.string().trim().min(1, "Role definition is required"),
```

**Idiom choice.** zod is pinned at `3.25.76` in both `package.json` and
`packages/types/package.json`, so `.trim()` is available and is the house style (`cli.ts` already
uses `z.string().trim().regex(...)` for session ids). It is preferred over a `.refine()` on the
trimmed length for two concrete reasons:

1. `.trim()` is a ZodString CHECK in zod 3, not a `ZodEffects` wrapper, so `modeConfigSchema` stays
   a plain `ZodObject` with `roleDefinition: string`. A `.transform()` or a wrapping refine would
   change the schema's class and risk the same `zodResolver` inference breakage that
   `groupEntryArraySchema` carries an explicit type assertion to avoid.
2. Checks run in order, so `.min(1)` sees the TRIMMED value and keeps its custom message. A
   whitespace-only role definition now fails with the same "Role definition is required" the user
   already sees for an empty one, which is what the settings UI and the `.roomodes` JSON schema
   surface.

Scope was deliberately NOT widened. `whenToUse`, `description` and `customInstructions` are
optional and render conditionally, so a blank one degrades to "absent" instead of breaking a
promise the opener makes; changing them would be churn with no defect behind it.

`schemas/roomodes.json` needs no regeneration: `zod-to-json-schema` does not represent `trim`, so
the generated `{"type":"string","minLength":1}` is byte-identical and
`roomodes-schema-sync.spec.ts` stays green. Verified by running it.

**Known residual, recorded on purpose.** `getModeSelection` in `src/shared/modes.ts` resolves a
BUILT-IN mode's role as `promptComponent?.roleDefinition || baseMode.roleDefinition`. An empty
string there falls through to the built-in text (harmless), but a whitespace-only string is truthy
and would win, blanking MODE again. That path comes from `customModePrompts`, a different schema
(`promptComponentSchema`, where `roleDefinition` is optional), and fixing it means changing
`getModeSelection`'s falsiness test, which is outside this round's scope. Follow-up candidate.

## Fix 3: custom-mode coverage (Finding 3)

`buildPrompt` in `prefix-stability.spec.ts` grew a fifth parameter, an extras bag carrying
`customModes` and `language`. The opener-contract block now runs the same assertions for two
realistic custom modes, one WITH `customInstructions` (`release-manager`) and one WITHOUT
(`note-taker`), and additionally proves the MODE section carries THAT mode's role definition (so
the assertion is not accidentally passing on the default mode's text) and that the conditional
block behaves exactly as "if it has any" claims. A further case asserts the opener bytes are
identical between a built-in mode and a custom mode, which is the KV-cache property the constant
exists for.

## Fix 4: the Language Preference guard test (Finding 1)

New describe block, `USER'S CUSTOM INSTRUCTIONS is unconditional`, placed immediately after the
opener contract. It builds the prompt with every optional custom-instruction input absent (no
global instructions, no `customModePrompts`, no `rooIgnoreInstructions`, AGENTS.md off, `code` has
no `customInstructions`, the cwd has no `.roo` rules) AND with the `language` argument left
undefined so the DEFAULT path runs (`language ?? formatLanguage(vscode.env.language)`), not a
hardcoded "en" from the harness. It then asserts the header is present, that "Language Preference:"
is the reason it is present, and that none of the other contributors rendered. A second case
repeats it on the custom-mode path.

The block carries a comment stating WHY it exists: if anyone ever puts the Language Preference
entry behind a setting, or lets an empty language through, this test must go red, because at that
moment the opener starts naming a section that a bare workspace does not have.

## REFUTED: "USER'S CUSTOM INSTRUCTIONS could be absent"

The verifier raised the possibility that the header might not render, which would make the opener's
second promise false. **This is refuted for the current code**, and the refutation is the reason
the guard test above is a GUARD rather than a fix:

- `addCustomInstructions` pushes the Language Preference entry whenever `options.language` is
  truthy (`custom-instructions.ts`, "Add language preference if provided").
- `system.ts` always supplies a language: `language: language ?? formatLanguage(vscode.env.language)`.
- `formatLanguage` (`src/shared/language.ts`) returns `"en"` for an empty or unrecognized locale.
  It has no code path that returns `""`.

So `sections` is never empty, `joinedSections` is never falsy, and the header always renders. The
guard test does not fix a live bug; it converts an invariant that currently holds by a single
unbroken thread into an invariant that CANNOT be broken silently. Confirmed by mutation, below.

## New measurements

All from the same pairwise loop in `prefix-stability.spec.ts`, with the same stubs as every
previous measurement in this document.

| Pair (MCP hub connected)  | v2 (this round) | v1 (first commit) | WS-F   |
| ------------------------- | --------------- | ----------------- | ------ |
| code vs orchestrator      | 8196 B          | 8186 B            | 8252 B |
| architect vs orchestrator | 8196 B          | 8186 B            | 8252 B |
| ask vs orchestrator       | 8196 B          | 8186 B            | 8252 B |
| debug vs orchestrator     | 8196 B          | 8186 B            | 8252 B |
| code vs architect         | 11830 B         | 11820 B           | n/a    |
| architect vs debug        | 11837 B         | 11827 B           | n/a    |

- **New worst case with a hub connected: 8196 bytes** (any `mcp`-group mode vs orchestrator).
- **Worst case with a hub that reports zero servers: 11628 bytes** (was 11618).
- **Computed head end (memory-index stub end): 8187 bytes** (was 8177).

Every pair moved by exactly +10, the byte delta of the opener, which is the evidence that nothing
but the opener changed.

**Floor decision: `MIN_SHARED_PREFIX_BYTES` stays at 8000.** The rule in the comment is that the
floor may follow a measurement UP but never down, and this round moved the measurement up by 10
bytes, which is far too small to justify raising a floor whose job is to tolerate ordinary head
text edits. Margin is now 196 bytes (was 186). The floor never exceeds the measurement, which was
the hard constraint. The comment now carries a three-line measurement log (8252, 8186, 8196) so the
next reader can see that the floor deliberately ignored all three.

## Mutation checks (three, all confirmed)

**Mutation 1: revert the schema fix.** `roleDefinition: z.string().trim().min(1, ...)` was
temporarily changed back to `z.string().min(1, ...)` and
`packages/types/src/__tests__/mode-roleDefinition.spec.ts` was run.
Result: **7 failed, 4 passed**. The failures were all five whitespace-only cases (space, spaces,
tab, newline, mixed), the shared-error-message case, and the normalization case. The four that
still passed are the ones that do not depend on trim awareness (normal value accepted, empty
rejected, missing rejected, plain-string type). Restored, green again.

**Mutation 2: restore the v1 opener.** `STABLE_PROMPT_OPENER` was temporarily set back to the v1
string and the opener-contract block was run.
Result: **4 failed, 12 passed**. The failures were "phrases the mode's own instructions
conditionally" (no "if it has any"), "makes no universal claim about where mode-scoped content
lives" (contains "any mode-specific rules"), "states bindingness with a referent that is never
empty" (no "is binding on you"), and "stays one plain-ASCII constant of at most two sentences" (v1
is three sentences). Restored, green again.

**Mutation 3: gate the Language Preference entry.** The push in `custom-instructions.ts` was
temporarily made unreachable (`if (false && options.language)`) and the new guard block was run.
Result: **2 failed, 0 passed** in that block. Both cases failed on exactly the intended assertion,
`expected ... to contain "====\n\nUSER'S CUSTOM INSTRUCTIONS"`, for the built-in and the custom-mode
path alike. Reverted with `git checkout`, green again.

`git status` was clean of all three mutations before committing.

## Snapshots

The same seven `.snap` files changed again, each by exactly one line, the first line of the prompt.
The diff was inspected with `git diff -U0 -- '*.snap'`: fourteen changed lines total, seven removals
of the v1 opener and seven additions of the v2 opener, and nothing else.

## Verification

- `cd src && npx vitest run core/prompts` : **25 files, 370 tests, all passing** (was 361; the nine
  new tests are four opener-wording cases, two custom-mode cases, the custom-mode byte-identity
  case and the two Language Preference guard cases).
- `cd packages/types && npx vitest run` : **22 files, 313 tests, all passing** (was 302; eleven new
  cases in `mode-roleDefinition.spec.ts`).
- Mode-schema consumers outside `packages/types`: `cd src && npx vitest run core/config
shared/__tests__/modes.spec.ts shared/__tests__/modes-empty-prompt-component.spec.ts
services/marketplace/__tests__/SimpleInstaller.spec.ts` : **12 files, 325 tests, all passing**.
  This is the set that round-trips `ModeConfig` through the schema (`CustomModesManager` and its
  four sibling specs, `CustomModesSettings`, import/export, the marketplace installer), so it is
  where a trim-aware field would have shown up if anything depended on untrimmed storage.
- `npx tsc --noEmit` clean in `src` and in `packages/types`.
- `git diff | grep -P '[\x{2013}\x{2014}]'` : empty. The one place a dash character was needed, the
  regex that asserts the opener contains none, is written with `\u2013` and `\u2014` escapes (the
  code points of the en dash and the em dash) so the spec file itself stays ASCII.

## KV-cache effect

`KV-cache: one-time prefix invalidation`, again, for the same unavoidable reason: the defect class
being fixed is in the first sentence. Because this second commit lands on the same branch as the
first, a user who never ran the intermediate build pays the invalidation ONCE, not twice. After it,
the prefix is stable again and shares 8196 bytes across a mode switch, 10 bytes more than v1 and
56 fewer than the original WS-F text.
