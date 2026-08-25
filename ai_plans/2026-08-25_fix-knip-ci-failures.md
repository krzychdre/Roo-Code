# Fix knip CI failures

**Date:** 2026-08-25
**Status:** Complete — knip exits 0 locally (only `warn`-level rules remain, which don't fail CI)
**Branch:** `main`

## Problem

The `pnpm knip` step in CI failed with exit code 1. Knip reported 46 error-level
issues across 7 categories: unused files (1), unused dependencies (21), unused
devDependencies (13), unlisted dependencies (2), unlisted binaries (1),
unresolved imports (1). The `warn`-level rules (exports/types/enumMembers/
duplicates) are noise — they're configured as `"warn"` in `knip.json` and don't
fail CI.

## Root cause

A mix of genuine dead dependencies and knip's inability to trace certain
dependency usage patterns:

1. **Genuinely unused deps** — packages declared in `package.json` but with zero
   import references in source (confirmed via `grep -rE "from ['\"]<dep>"`).
   These are safe to remove.
2. **Used-but-untraceable deps** — knip can't follow:
    - esbuild bin entrypoints ([`packages/agent-interchange/src/mcp/index.ts`](packages/agent-interchange/src/mcp/index.ts:1) is compiled to `dist/mcp-server.mjs`)
    - Next.js app-router route files ([`apps/web-evals/src/app/api/runs/[id]/logs/failed/route.ts`](apps/web-evals/src/app/api/runs/[id]/logs/failed/route.ts:4) imports `archiver`)
    - CSS `@plugin` directives ([`apps/web-evals/src/app/globals.css`](apps/web-evals/src/app/globals.css:3) loads `tailwindcss-animate`)
    - dynamic `require()` ([`src/services/ripgrep/internal/loadRipgrep.ts`](src/services/ripgrep/internal/loadRipgrep.ts:15) loads `@vscode/ripgrep`)
    - tsconfig `plugins[].name` ([`packages/config-typescript/nextjs.json`](packages/config-typescript/nextjs.json:7) references `next` — not an import)
    - shell scripts referenced in npm scripts ([`apps/web-evals/scripts/check-services.sh`](apps/web-evals/scripts/check-services.sh:1) in the `dev` script)
    - Tailwind v4 engine ([`tailwindcss`](apps/web-evals/package.json:59) is the build engine used by `@tailwindcss/postcss`)

## Fix

### Removed genuinely unused deps (verified 0 import refs)

| Package                                     | File                                                                                    | Evidence                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| cheerio                                     | [`src/package.json`](src/package.json:525)                                              | 0 non-test imports                                                             |
| default-shell                               | [`src/package.json`](src/package.json:528)                                              | 0 non-test imports                                                             |
| diff-match-patch                            | [`src/package.json`](src/package.json:531)                                              | 0 non-test imports                                                             |
| jwt-decode                                  | [`src/package.json`](src/package.json:544)                                              | 0 non-test imports                                                             |
| node-ipc                                    | [`src/package.json`](src/package.json:549)                                              | 0 non-test imports                                                             |
| pkce-challenge                              | [`src/package.json`](src/package.json:557)                                              | 0 non-test imports                                                             |
| puppeteer-chromium-resolver                 | [`src/package.json`](src/package.json:561)                                              | 0 non-test imports                                                             |
| puppeteer-core                              | [`src/package.json`](src/package.json:562)                                              | 0 non-test imports                                                             |
| sound-play                                  | [`src/package.json`](src/package.json:571)                                              | 0 non-test imports                                                             |
| stream-json                                 | [`src/package.json`](src/package.json:572)                                              | 0 non-test imports                                                             |
| string-similarity                           | [`src/package.json`](src/package.json:573)                                              | 0 non-test imports                                                             |
| strip-ansi                                  | [`src/package.json`](src/package.json:574)                                              | 0 non-test imports                                                             |
| tmp                                         | [`src/package.json`](src/package.json:577)                                              | 0 imports (1 string-literal match in a dir-name array, not an import)          |
| glob                                        | [`src/package.json`](src/package.json:617)                                              | 0 non-test imports (used only in `apps/vscode-e2e` which has its own copy)     |
| + matching `@types/*` for each of the above | [`src/package.json`](src/package.json:589)                                              | type-only deps for removed packages                                            |
| @roo-code/types                             | [`packages/agent-interchange/package.json`](packages/agent-interchange/package.json:22) | 0 imports in agent-interchange src                                             |
| json-stream-stringify                       | [`packages/agent-interchange/package.json`](packages/agent-interchange/package.json:23) | 0 imports (used in `src/utils/safeWriteJson.ts` — owned by `src/package.json`) |
| proper-lockfile                             | [`packages/agent-interchange/package.json`](packages/agent-interchange/package.json:24) | 0 imports (used in `src/utils/safeWriteJson.ts` — owned by `src/package.json`) |
| node-ipc                                    | [`packages/evals/package.json`](packages/evals/package.json:36)                         | 0 imports                                                                      |
| zod                                         | [`packages/evals/package.json`](packages/evals/package.json:43)                         | 0 imports                                                                      |
| @types/node-ipc                             | [`packages/evals/package.json`](packages/evals/package.json:49)                         | type-only dep for removed package                                              |
| remove-markdown                             | [`webview-ui/package.json`](webview-ui/package.json:70)                                 | 0 non-test imports                                                             |
| @types/ps-tree                              | [`apps/web-evals/package.json`](apps/web-evals/package.json:57)                         | `ps-tree` not used in web-evals                                                |
| glob                                        | [`package.json`](package.json:39)                                                       | 0 imports at root level                                                        |
| @types/glob                                 | [`package.json`](package.json:34)                                                       | type-only dep for removed package                                              |

### Added as real devDependency (was unlisted)

| Package | File                                                            | Reason                                                                        |
| ------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| postcss | [`apps/web-evals/package.json`](apps/web-evals/package.json:58) | Implied by `postcss.config.mjs`; `@tailwindcss/postcss` requires it as a peer |

### knip.json changes (untraceable deps → ignoreDependencies/ignoreUnresolved/ignoreBinaries)

- Added [`packages/agent-interchange/src/mcp/index.ts`](packages/agent-interchange/src/mcp/index.ts:1) to the top-level `ignore` list (esbuild bin entrypoint).
- Added `@vscode/ripgrep` to the `src` workspace `ignoreDependencies` (loaded via dynamic `require()`).
- Added `next` to `packages/config-typescript` `ignoreUnresolved` (tsconfig plugin name, not an import).
- Added top-level `ignoreBinaries: ["scripts/check-services.sh"]` (shell script in `apps/web-evals` dev script).
- Added a new `apps/web-evals` workspace entry with `ignoreDependencies` for `tailwindcss` and `tailwindcss-animate` (Tailwind v4 engine + CSS `@plugin` directive). The `entry` globs cover Next.js app-router files so knip can trace `archiver` and `@types/archiver` (no longer need to be ignored).

## Verification

- `pnpm install --no-frozen-lockfile` — lockfile updated cleanly.
- `npx knip --no-progress` — **exit code 0**. Only `warn`-level output remains (unused exports/types/enumMembers/duplicates), which don't fail CI per the `knip.json` rules config.

## Notes

- The local `.vol` docker bind-mount directory (root-owned, gitignored) causes an
  `EACCES` crash in knip's filesystem walk. This is a local-only artifact — CI
  doesn't have it. Worked around by temporarily moving it out of the project tree
  during verification.
- The `warn`-level rules (55 unused exports, 30 unused exported types, 8 enum
  members, 8 duplicate exports) are pre-existing and intentionally non-failing.
  Addressing them would require code changes beyond the scope of this CI fix.
