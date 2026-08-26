# Fix: nightly build crash on `integer` configuration type

**Date:** 2026-08-26
**Branch:** `fix/build-schema-integer-type`
**Severity:** CI-blocking (nightly VSIX build fails)

## Symptom

The GitHub Actions nightly build (`pnpm vsix:nightly`) fails at the
`@roo-code/vscode-nightly#bundle:nightly` step with a Zod validation error:

```
error: [{
  "code": "invalid_union",
  "path": ["configuration", "properties",
           "tumble-code.apiRequestTimeout", "type"],
  "message": "Invalid input"
}]
```

The `type` field received `"integer"` but the schema's union of literals only
accepts `"string"`, `"array"`, `"object"`, `"boolean"`, `"number"`.

## Root cause (proven with evidence)

1. `src/package.json:417-423` defines the `tumble-code.apiRequestTimeout`
   configuration property with `"type": "integer"`. This is a valid VS Code
   configuration contribution type (VS Code's own schema lists `integer`
   alongside `string`, `number`, `boolean`, `array`, `object`).

2. `packages/build/src/types.ts:75-82` defines `configurationPropertySchema`
   with a `type` field that is a Zod union of five literals. `"integer"` is
   missing from that union.

3. `packages/build/src/esbuild.ts:272` calls `contributesSchema.parse(contributes)`
   inside `generatePackageJson`. The nightly `esbuild.mjs` plugin runs this
   parse at `build.onEnd`, so the crash aborts the bundle before the VSIX is
   packaged.

4. The `apiRequestTimeout` property (with `type: "integer"`) was introduced in
   PR #117 (the zoo-691 delegation atomic update port, 2026-06-29). The build
   schema was not updated to accept `"integer"`, so every nightly build since
   that merge has been broken.

The stable (non-nightly) build is unaffected because it ships `package.json`
as-is and never runs `generatePackageJson` (which exists to rewrite
`tumble-code` tokens to `tumble-code-nightly`).

## Fix

Add `z.literal("integer")` to the `type` union in `configurationPropertySchema`
in `packages/build/src/types.ts`. This aligns the build-time validator with the
set of types VS Code actually supports for configuration properties.

## Verification

- `packages/build` unit test (`index.test.ts`): extended with an
  `apiRequestTimeout` property of `type: "integer"` in both the input and the
  expected output. Test passes.
- `packages/build` full suite: 2/2 pass.
- `packages/build` dist rebuilt (`npm run build`); `dist/types.js` now contains
  the `"integer"` literal.
- End-to-end: `node esbuild.mjs` in `apps/vscode-nightly` completes with exit
  code 0. The generated `build/package.json` contains
  `tumble-code-nightly.apiRequestTimeout` with `"type": "integer"` and the
  name substitution applied correctly.

## Separate known issue (fixed in stacked follow-up)

The `configurationPropertySchema` was a plain `z.object({...})` without
`.passthrough()`, so Zod stripped keys it did not explicitly declare. The real
`src/package.json` declares `minimum`, `maximum`, `markdownDescription`, and
`order` on several configuration properties (lines 359-478), and all of these
were dropped from the generated nightly `package.json`, degrading the nightly
extension's settings UI (no range validation, no rich descriptions, no sort
order).

**Fix (branch `fix/build-schema-preserve-config-fields`, stacked on this
branch):** added `.passthrough()` to `configurationPropertySchema`. The schema
still validates the shape the transform depends on (the `type` union and the
required `description`), but now preserves every other VS Code field
untouched. Verified that all 21 configuration properties have identical field
sets between source and generated `package.json` after the name substitution.

## Files changed

- `packages/build/src/types.ts` - add `z.literal("integer")` to the union;
  add `.passthrough()` to preserve VS Code configuration fields the transform
  does not inspect.
- `packages/build/src/__tests__/index.test.ts` - regression tests for the
  `integer` configuration type and for field preservation (`minimum`,
  `maximum`, `markdownDescription`, `order`) through `generatePackageJson`.
