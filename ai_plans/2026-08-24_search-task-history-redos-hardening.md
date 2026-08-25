# search_task_history: ReDoS hardening after adversarial review

- **Date:** 2026-08-24
- **Branch:** `feat/32-search-task-history-hardening` (stacked on `feat/31-search-task-history`, commit 832df9d96)
- **Scope:** `src/core/task/searchTaskHistory.ts` + its spec. `ReadArtifactTool` has the same class of exposure but gets its own branch (one branch per functionality).

## Why

Two independent adversarial reviews (models A and B) of `feat/31` produced five confirmed defects in the ReDoS defence of `search_task_history`. Every claim below was re-verified in this session against the actual code before making this plan; two reviewer claims were refuted and are explicitly out of scope (see the last section).

## Confirmed defects and fixes

### 1. Guard drops nested quantification (worst, from review A)

`isCatastrophicPattern` tracks, per open group, whether the body carries an unbounded quantifier. When a group closes WITHOUT being quantified itself, that flag is popped and discarded: the only upward propagation sits in the `if (quantified)` branch. Hence `((a+))+b`, `((a*))+c`, `(((a+)))+b` compile as live regexes although they are semantically identical to `(a+)+b`, which the guard refuses. One 2000-char line (the per-line test cap) then hangs the extension host, because `RegExp.test` cannot be interrupted and the wall clock is only checked between lines.

**Fix:** on popping a group, propagate `bodyQuantified` to the enclosing group even when the group itself carries no quantifier. A body that contains an unbounded quantifier still contains it as far as any enclosing group is concerned.

**Accepted false positives:** patterns like `((a+)b)+` (safe: each outer iteration must consume the `b`) will now be refused. This matches the guard's documented philosophy (syntactic and conservative); the fallback is a literal search plus an explanation, never an error.

### 2. Guard ignores `?` in a group body (review B, weakly exploitable on V8)

`(a?)+$` and `(?:\d?)*` pass as live regexes because `?` never marks the current group. This is the classic nullable-body-under-unbounded-loop shape. On Node 22 / V8 the empty-match cut keeps it at 11-16 ms (measured in the review), so it is a validation defect there, but other engines and future runtimes are not covered by that mercy.

**Fix:** treat `?` as a body marker, EXCEPT when it directly follows `(` (there it is group syntax: `(?:`, `(?=`, `(?!`, `(?<`). `(?:foo)+` and `(https?)` stay allowed; `(a?)+` and `(?:\d?)*` get refused.

**Explicit non-goal:** `(\d+)?x` stays allowed. A bounded `?` on the group is at worst polynomial; review B listed it as a required refusal and that part of the claim is wrong.

### 3. Post-scan phase runs outside the wall-clock budget (review B, measured)

The 2 s budget is checked only inside the scan loop. Sort, per-match whitespace normalisation and hit-block building run after the last check with no bound; the review measured 5.4 s end-to-end with `timedOut: false` on 2000 sources x 1000 matching lines (post-scan alone 3.6-4.4 s, growing with match count). The `timedOut` error path in `SearchTaskHistoryTool` is unreachable for exactly the calls that need it.

**Fix, two layers:**

- Structural: cap collected matches at `MAX_COLLECTED_MATCHES` (10 000). Reaching the cap stops the scan and reports the existing `timedOut` outcome; a query matching 10 000+ lines cannot produce a useful answer and the shipped advice (simplify the pattern) is exactly right. With the cap in place, sort and dedup are bounded to milliseconds.
- Clock: one extra deadline check after the scan loop, before any post-scan work, so a scan that finishes just past the deadline between two interval checks is also reported.

### 4. CRLF corpus silently defeats anchored queries (review B, measured)

Lines are split on `"\n"` only, so a corpus with Windows line endings (CRLF, the `\r\n` pair) keeps a trailing `\r` on every line and `$`-anchored queries return 0 hits with no diagnostic (measured: 1 plain hit vs 0 anchored on the same corpus).

**Fix:** split on `/\r?\n/`. The line cache feeds both matching and display, so hit blocks also stop carrying the invisible `\r`.

### 5. Byte-cut artifacts end in U+FFFD (review B, cosmetic)

`readTaskArtifacts` reads up to an allowance of BYTES and decodes with `toString("utf8")`; a cut inside a multi-byte character yields the replacement character U+FFFD at the end of the text. The sibling `capBytes` already handles this correctly (strips a trailing U+FFFD after the cut).

**Fix:** when the read was truncated (`bytesRead < stats.size`), strip one trailing U+FFFD, same as `capBytes`.

## Test matrix (added to the shipped specs)

| Area                 | New assertions                                                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guard classification | `((a+))+b`, `((a*))+c`, `(((a+)))+b`, `(a?)+`, `(?:\d?)*`, `((a+)?)*` are `unsafe`; `(?:foo)+`, `(https?)`, `(\d+)?x`, `(a+)?` stay `regex`                                                                                |
| Post-scan budget     | corpus with more than `MAX_COLLECTED_MATCHES` matching lines returns `timedOut: true` fast; fake clock that jumps past the deadline only AFTER the scan loop still returns `timedOut: true` (pins the new post-scan check) |
| CRLF                 | CRLF corpus: `/^needle$/` finds the line; the rendered hit block carries no `\r`                                                                                                                                           |
| U+FFFD               | artifact whose byte cap cuts a 2-byte character in half decodes without a trailing U+FFFD and is flagged `truncated`                                                                                                       |

## Evidence base

- Guard gap: manual instruction-level trace of `isCatastrophicPattern` in this session; exponential behaviour of the nested shape is engine-canonical (identical backtracking automaton to the refused `(a+)+b`).
- Budget breach 5.4 s, CRLF 1-vs-0 hits, U+FFFD index: executed measurements from the adversarial review sessions (Node v22.22.1).
- Refuted reviewer claims, recorded so nobody "fixes" them later: `readApiMessages` CAN reject (`fs.readFile` sits outside its try/catch), so the spec that mocks a rejection tests a real path and stays; `{n,}` in a group body IS handled by the guard (the `case "{"` arm plus the green `(a{2,})+` row).

## Out of scope, tracked elsewhere

- `ReadArtifactTool.searchInArtifact` hardening (same exposure, no guard/cap/budget): separate branch on top of this one.
- Marker-based self-echo detection vs microcompact (compacted results lose the marker): low impact, candidate for a `tool_use_id` lookup in a later change.
