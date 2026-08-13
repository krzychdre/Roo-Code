# Vision mode: eyes for text-only models

Date: 2026-08-13
Branch: `feat/24-vision-mode`

## Request

The user's daily-driver models (GLM-5.2 on Orchestrator / Code / Ask / Debug)
cannot see images. Add a dedicated mode that:

1. Runs on a vision-capable model (the user will pin Qwen3.6-35B to it) and
   specializes in recognizing what is on provided or downloaded images.
2. Can be handed an image mid-task by any other mode, and hands back a textual
   description the big text-only model can keep working with.

## Where the mechanism lives

Like `reviewer`, this is a _global custom mode_, not extension code:

- Versioned source: `ai_plans/assets/vision-mode.yaml` (this repo).
- Live copy: `~/.config/Code/User/globalStorage/qub-it.tumble-code/settings/custom_modes.yaml`.

One deliberate code change ships with it (see "Delegation hint" below):
`src/core/tools/helpers/imageHelpers.ts` + a new spec.

## How the round-trip works (all verified on `main`)

1. **Per-mode model pinning already exists.** `modeApiConfigs`
   (`ClineProvider.ts:2871`) maps mode slug -> API profile, and
   `handleModeSwitch` (`ClineProvider.ts:1598`) loads that profile on every
   switch. Pinning a Qwen3.6-35B profile to `vision` is pure configuration.
2. **Delegation is always available.** `new_task` and `switch_mode` are in
   `ALWAYS_AVAILABLE_TOOLS` (`src/shared/tools.ts:324`); a `new_task` child
   goes through `handleModeSwitch` (`ClineProvider.ts:4257`), so the subtask
   runs on the vision-pinned model and the parent resumes on its own
   mode/profile when the child completes.
3. **The child can actually see.** `read_file` natively returns image blocks
   when the current model `supportsImages`
   (`ReadFileTool.handleBinaryFile` -> `processImageFile`), so the vision mode
   needs no special tools - plain `read_file` is its eye. Downloads are
   covered by the `command` group (`curl` to `/tmp`).
4. **History stays correct across mode switches.** `maybeRemoveImageBlocks`
   is applied transiently on EVERY request build (`ApiRequestBuilder.ts:428`,
   `TaskApiLoop.ts:1118`): image blocks degrade to
   `[Referenced image in conversation]` for text-only models and reappear for
   vision-capable ones. Nothing is persisted or destroyed - this matches the
   recorded design-for-mode-switching rule (transient recompute over
   mutation), and it makes the manual `switch_mode` round-trip safe too.
5. **Callers learn about the mode from the system prompt.** The MODES section
   lists every mode with its `whenToUse`
   (`src/core/prompts/sections/modes.ts`), so vision's `whenToUse` doubles as
   the delegation contract: what to delegate, what to include (paths/URLs +
   the question), what comes back.

## Design decisions (and why)

**Subtask-first, not switch-first.** The recommended flow is `new_task`
because (a) the image tokens live only in the child's context - the parent's
history never carries image blocks, (b) mode + model switching and restoring
is automatic, (c) the answer arrives as one `attempt_completion` text block
that stands alone. `switch_mode` remains a valid manual fallback for
interactive use (the chat image-attach UI unlocks whenever the active mode's
pinned model supports images - `shouldDisableImages` gates on the current
model), and fact (4) keeps it safe.

**Delegation hint at the moment of need.** Weak text-only models will not
remember a prompt-space rule N turns in. So the unsupported-image notice in
`imageHelpers.ts` (returned by `read_file` exactly when GLM trips over an
image, and by image mentions via `resolveImageMentions.ts`) now appends: if a
vision-capable mode is listed in MODES, delegate with `new_task` (path +
question) and continue with the returned description. The wording is
conditional and slug-free, so installs without the vision mode read it as a
no-op suggestion; no plumbing of the mode list into the helper is needed.

**Weak-model discipline on the callee too** (per the recorded
design-for-weak-models rule, and because Qwen3.6-35B is itself mid-size):

- Numbered phases (COLLECT -> ANALYZE -> REPORT), a per-kind checklist with
  concrete items instead of adjectives, and a fixed report skeleton
  (ANSWER / IMAGE / TEXT CONTENT / STRUCTURE / NOTABLE / LIMITS).
- Verbatim-transcription rule: legible text is copied character by character,
  never paraphrased - the caller may need exact error strings or identifiers.
- Batched reads (all images in ONE `read_file` request), tiny tool budget,
  no codebase exploration: the mode describes, it does not solve.
- Questions are banned outright (stricter than reviewer's one-batch rule):
  the caller is almost always another model, so `ask_followup_question`
  would stall the pipeline at the human. Gaps go to a LIMITS section.

**Minimal tool surface.** Groups: `read` + `command` only. No `edit` (vision
has no memory-write duties, unlike reviewer - omitting the group entirely is
simpler than the `a^` carve-out), no `mcp`/`browser` (prompt weight matters
on a 35B model; `curl` covers downloads).

## Deliverables

1. `ai_plans/assets/vision-mode.yaml` - the mode definition (new file).
2. `src/core/tools/helpers/imageHelpers.ts` - delegation hint appended to the
   unsupported-model notice; new
   `src/core/tools/helpers/__tests__/imageHelpers.spec.ts` pins the hint
   (mutation-test: removing the hint or reordering the early return fails it).
3. Live copy updated at
   `~/.config/Code/User/globalStorage/qub-it.tumble-code/settings/custom_modes.yaml`
   (vision entry appended next to reviewer; the extension hot-reloads the
   file, a window reload is a safe fallback).
4. This plan document.

## User-side configuration (one-time, in the GUI)

1. Create an API profile for the vision model (Qwen3.6-35B endpoint).
2. Prompts tab -> select the Vision mode -> pick that profile as the mode's
   API configuration (this writes `modeApiConfigs.vision`).
3. Leave GLM profiles pinned to the other modes as they are.

## Verification

- Existing suites are unaffected by the notice change: `readFileTool.spec.ts`
  and `resolveImageMentions.spec.ts` mock `validateImageForProcessing` and
  assert on the mocked notice, not the real string (checked).
- New `imageHelpers.spec.ts` passes; it calls the real function with a
  nonexistent path, proving the unsupported-model check precedes filesystem
  access.
- Live YAML re-parsed after the copy (python), both slugs present.
- Manual e2e (user): GLM orchestrator task containing a screenshot path ->
  read_file returns the hint -> `new_task` to vision -> description returns
  to the parent.

## Follow-ups (not in this change)

- Optionally make the hint conditional on a vision-capable mode actually
  existing (requires passing the mode list into `imageHelpers`; skipped -
  the sentence is already conditional).
- Optionally add the `browser` group so vision can take its own screenshots
  (`browser_action` screenshots only work on vision models anyway).
- Optional `.roo/rules-vision/` for project-specific image conventions
  (e.g. where design mockups live), once the base mode has been exercised.
