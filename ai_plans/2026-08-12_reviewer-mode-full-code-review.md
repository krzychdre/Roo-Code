# Reviewer mode: from diff-checker to a full code-review mechanism

Date: 2026-08-12
Branch: `feat/23-reviewer-full-code-review`

## Request

Upgrade the user-side `reviewer` custom mode into a full-fledged code-review
mechanism. The user's requirements, verbatim in intent:

1. **Substance first** — review the change against the _task's intent_; the
   reviewer should work the intent out itself but may ask questions when it
   genuinely matters.
2. **Reuse with boundaries** — flag re-implemented logic, but never propose
   reuse that couples modules an architectural decision deliberately separates.
3. **Clean code** — DRY, YAGNI, low cognitive complexity, design patterns where
   they fit.
4. **Anti-primitive, anti-magic** — flag 3+-branch if/else ladders, but do not
   promote "clever" solutions a human cannot read.
5. **Propose better solutions**, not just complaints.
6. **See beyond the diff** — read the surroundings of changed code, and consult
   the recorded architectural decisions in the memory system; surface them to
   the user.
7. **Contradictions and nuances** — changes that silently violate assumptions
   or invariants the callers rely on.
8. **Meaningful tests** — tests must be able to fail when the changed logic
   breaks; tests of mocks or of library behaviour are "false confidence".
9. **Signal over nitpicks** — report only findings that carry real risk or
   genuinely need change (the user flags this as the hard part).

Additions proposed by the assistant and accepted:

- An **intent summary** written before judging, so a misunderstood task is
  caught immediately.
- A **noise gate** (three-question test) plus a hard cap of 3 Suggestion-level
  findings.
- **Evidence discipline** — every finding cites file:line and a harm scenario;
  unverified suspicions are labelled "unverified", never stated as fact.
- An explicit **verdict line** (APPROVE / APPROVE WITH COMMENTS / REQUEST
  CHANGES).
- **Memory write-back** of confirmed architectural decisions (user opted IN).
- A **scaled tool budget** (user chose: 25 calls for ≤5 changed files, 60
  above) instead of the flat 25 from the 2026-07-27 turn-economics rewrite.
- Extension point: project-local `.roo/rules-reviewer/` can add repo-specific
  review rules without touching the mode definition (no file shipped now; the
  loader already supports it).

## Where the mechanism lives

The reviewer is a _global custom mode_, not extension code:

- Versioned source: `ai_plans/assets/reviewer-mode.yaml` (this repo).
- Live copy: `~/.config/Code/User/globalStorage/qub-it.tumble-code/settings/custom_modes.yaml`.

No extension code changes are needed. Two platform facts the new prompt relies
on, both verified on `main`:

1. **Memory index is already injected into every mode's system prompt.**
   `src/core/prompts/sections/memory.ts` appends the truncated `MEMORY.md`
   index after custom instructions, so the reviewer can be _instructed_ to open
   the relevant `project`/`feedback` memory files — no code needed.
2. **Memory writes bypass `fileRegex` but require the `edit` group.**
   `src/core/tools/validateToolUse.ts:221` carves out paths inside the
   auto-memory dir _before_ the regex check, but only runs at all when the mode
   has an `edit` group. Giving reviewer `edit` with `fileRegex: a^` (a valid
   regex that can never match — it requires an `a` before start-of-string)
   yields exactly "may write memory files, may never touch source".

## Design decisions (and why)

**Weak-model discipline** (per recorded feedback: design for GLM/Qwen/local
models, not frontier ones):

- Every quality principle is turned into an _operational decision rule_ with a
  concrete threshold ("3+ branches on the same discriminator", "would the test
  fail if the logic were inverted?"), never an adjective ("clean", "simple").
- The procedure is numbered and phased (UNDERSTAND → JUDGE → GATE/REPORT), and
  the report skeleton is fixed, so a weak model can follow it mechanically.
- The turn-count lesson from `2026-07-27_verbosity-and-turn-economics.md` is
  kept: one-command diff, batched reads, no re-reads, budget stated up front.
  The budget scales because "see beyond the diff" is impossible in 25 calls on
  a large change; it stays at 25 for small ones so GLM costs do not regress.

**Question policy.** The 2026-07-27 rewrite banned questions because reviewer
usually runs as a delegated subtask. The new mode allows exactly ONE batch of
at most 3 questions, only in the UNDERSTAND phase, and only when different
answers would change the verdict; otherwise assumptions are recorded in the
report. This satisfies both the interactive use case (user asked for questions)
and the delegated one (assumption-recording fallback stays).

**Reuse boundary test.** Before proposing extraction, the reviewer must check
the layer/import direction of both duplication sites and consult
memory/plan-doc decisions; a duplication that protects an architectural seam is
reported as _accepted_, with the reason.

**Test meaningfulness = mutation thought-test.** "If the implementation's
logic were inverted or deleted, would this test fail?" — a test that only
exercises mocks or asserts library behaviour cannot fail, and is reported as
an Important finding ("false confidence"), not as coverage.

**Noise gate.** A finding must (1) be able to cause incorrect behaviour, data
loss, outage, or a security hole, OR (2) materially slow future change, OR
(3) contradict a recorded decision or the stated intent. Otherwise it is
dropped. Formatting/import-order/naming-taste comments are banned outright,
and Suggestions are capped at 3.

**Memory write-back.** Only decisions _evidenced_ by a plan doc or an explicit
user answer get saved; style preferences and one-off facts do not. Writes go
through the existing memory-prompt instructions (taxonomy, frontmatter), which
every mode already receives.

## Deliverables

1. `ai_plans/assets/reviewer-mode.yaml` — rewritten mode (this is the review
   mechanism itself).
2. Live copy updated at
   `~/.config/Code/User/globalStorage/qub-it.tumble-code/settings/custom_modes.yaml`
   (identical `customModes` entry; requires a window reload or mode refresh to
   take effect).
3. This plan document.

## Verification

- `a^` accepted by `groupOptionsSchema` (`new RegExp("a^")` is valid; the
  refinement in `packages/types/src/mode.ts` only requires syntactic validity).
- Tool name `ask_followup_question` confirmed in `src/shared/tools.ts:110`.
- Memory carve-out order confirmed: `validateToolUse.ts` returns `true` for
  auto-memory paths _before_ evaluating `fileRegex`, so `a^` never blocks
  memory writes while blocking every workspace edit with a clear
  `FileRestrictionError` that quotes the group description.
- Live YAML re-parsed after the copy (yq/python) to catch indentation slips.

## Follow-ups (not in this change)

- Optionally seed `.roo/rules-reviewer/` in this repo with Tumble-specific
  review rules (e.g. "i18n keys must exist in all locales") once the base mode
  has been exercised.
- Measure turn counts on the next few GLM reviews; if the 60-call ceiling is
  routinely hit, consider a two-pass review (breadth then depth) instead of a
  bigger budget.
