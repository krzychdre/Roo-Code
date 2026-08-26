# Fix: `pnpm knip` crashes on a root-owned docker volume, then fails on a dead dependency

Date: 2026-08-26
Branch: `fix/knip-crawl-and-unused-poe-dep` (off `main`)

## Symptom

Two separate failures, one hiding the other.

1. Locally, `pnpm knip` never produced a report at all:

```
[Error: EACCES: permission denied, scandir
 '/home/krzych/Projekty/QUB-IT/Roo-Code/self-hosted-cloudapi/.vol/postgres'] {
  errno: -13, code: 'EACCES', syscall: 'scandir'
}
```

2. Once the crash was out of the way, knip exited 1 with a real finding:

```
Unused dependencies (2)
ai-sdk-provider-poe  packages/types/package.json:27:4
ai-sdk-provider-poe  src/package.json:522:4
```

Only failure 2 is visible in CI (`.github/workflows/code-qa.yml` job `knip`),
because the CI checkout has no docker bind-mount data in the tree.

## Root cause 1 (proven, not guessed): knip's file crawl ignores `knip.json`'s `ignore`

`self-hosted-cloudapi/.vol/` is the bind-mount directory for the self-hosted
cloud API compose stack. `.vol/postgres` is the Postgres data directory, so it
is `drwx------ postgres root` by necessity - Postgres refuses to start when its
data directory is group- or world-accessible. An unprivileged `readdir` on it
throws `EACCES`, and fast-glob's default `suppressErrors: false` turns that into
a fatal error.

`knip.json` already listed `"self-hosted-cloudapi/**"` under `ignore`, and
adding the explicit dot-directory variant `"self-hosted-cloudapi/.vol/**"`
changed nothing. Evidence for why:

- `node_modules/knip/dist/util/glob.js:28` (`defaultGlob`) calls
  `glob(...)` with `cwd`, `dir`, `gitignore`, `absolute`, `dot`, `label` - and
  **no `ignore` key**. In `glob-core.js:130`,
  `options.gitignore && Array.isArray(options.ignore) ? [...options.ignore] : []`
  therefore always yields `[]` for the config-level patterns. The `ignore`
  section of `knip.json` filters _reported issues_, it never prunes the crawl.
- The only patterns that do reach fast-glob come from `cachedGitIgnores`, and
  `glob-core.js:133-143` walks **from the globbed directory upwards**. For a
  root-workspace glob that means the root `.gitignore` plus ancestors; a nested
  `self-hosted-cloudapi/.gitignore` (which does contain `.vol/`) is cached under
  its own directory key and is never consulted.
- The other crawl, `findAndParseGitignores`, was ruled out by running it
  standalone against the repo root: it completes without throwing and correctly
  yields `self-hosted-cloudapi/**/.vol` in its ignore set. So the crash is in
  the source-file glob, not in the gitignore collector.

### Fix 1

Add `.vol/` to the **root** `.gitignore`. Root-level rules are the ones knip
feeds into fast-glob, so the directory is pruned before anything tries to
descend into it. The nested `self-hosted-cloudapi/.gitignore` rule stays where
it is; git itself was already fine, this is purely about the crawler.

## Root cause 2: the provider cleanup left an npm dependency behind

Commit `d4a7f4182` ("Chore/provider cleanup model refresh", #154) retired seven
providers, poe among them: the handler, fetcher, schemas and UI were deleted and
only `{ id: "poe", lifecycle: "retired" }` remains in
`packages/types/src/provider-registry.ts`. The npm package that the deleted
handler imported, `ai-sdk-provider-poe`, was left declared in both
`src/package.json` and `packages/types/package.json`.

A repo-wide search (excluding `node_modules`, `pnpm-lock.yaml` and archived
error dumps) finds the string in those two manifests and nowhere else - no
static import, no dynamic import, no string reference.

### Fix 2

Remove `ai-sdk-provider-poe` from both manifests and regenerate the lockfile
(`pnpm install`, 71 lines dropped from `pnpm-lock.yaml`).

## Verification

- `pnpm knip` - exit code 0, ~15 s. The remaining output is warnings only
  (`exports`, `types`, `enumMembers`, `duplicates` are set to `warn` in
  `knip.json` and do not affect the exit code).
- `pnpm check-types` - 14/14 turbo tasks successful after `pnpm install` had
  removed the workspace symlinks for the dropped package, so a leftover import
  could not have resolved silently.

## Known leftovers, deliberately not touched

`@ai-sdk/baseten`, `@ai-sdk/fireworks` and `sambanova-ai-provider` are also
dependencies of retired providers with no remaining code references, but they
sit in `knip.json`'s `ignoreDependencies` for the `src` workspace, so they do
not fail anything today. Dropping them (and their `ignoreDependencies` entries)
touches the extension bundle and belongs in its own change.
