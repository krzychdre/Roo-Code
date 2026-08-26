# Fix agent-interchange test failures on Windows CI

**Date:** 2026-08-26
**Status:** Complete
**Branch:** `fix/agent-interchange-windows-ci`
**CI run:** `windows-latest`, Node 20.19.2, pnpm 10.8.1

## Problem

`@roo-code/agent-interchange#test` failed on `windows-latest` with **6 failed
tests** across two spec files. All 6 pass on Linux/macOS CI and locally.

### Failure inventory

| #   | File                   | Test                                  | Error                                           |
| --- | ---------------------- | ------------------------------------- | ----------------------------------------------- |
| 1   | `install.spec.ts:64`   | uses durable user storage             | `\home\me\...` ≠ `/home/me/...`                 |
| 2   | `install.spec.ts:74`   | preserves unrelated config            | `D:\durable\server.mjs` ≠ `/durable/server.mjs` |
| 3   | `install.spec.ts:95`   | requires explicit Tumble config       | `D:\tmp\...` ≠ `/tmp/...`                       |
| 4   | `install.spec.ts:147`  | rolls back failed update              | mode `0o666`(438) ≠ `0o700`(448)                |
| 5   | `handoffs.spec.ts:332` | serializes independent Node processes | Test timed out in 5000ms                        |
| 6   | `handoffs.spec.ts:367` | crashed paused writer                 | Test timed out in 5000ms                        |
| 7   | `handoffs.spec.ts:41`  | (afterEach cleanup)                   | `ENOTEMPTY: directory not empty, rmdir`         |

Failures 1–4 are **path-separator and file-mode** issues — the tests hardcode
POSIX paths (`/home/me/...`, `/tmp/...`) and Unix mode bits (`0o700`), but the
production code uses `node:path` (`path.join`, `path.resolve`) which produces
Windows-native separators and drive-rooted paths on Windows, and Windows
ignores Unix permission bits.

Failures 5–6 are **test timeouts** — the default vitest timeout is 5000ms, but
these two tests bundle a worker with esbuild and spawn child processes, which
on Windows CI (with antivirus scanning and slower process startup) exceeds 5s.

Failure 7 is a **consequence** of failure 6: when the "crashed paused writer"
test times out at 5s, the spawned child (configured with a 30s rename delay)
is still alive and holds file handles in the temp directory. The `afterEach`
`fs.rmSync(dir, { recursive: true, force: true })` then hits `ENOTEMPTY`
because the orphaned child's handles prevent deletion.

## Root cause (proven with evidence)

### Path separators (failures 1–3)

[`durableBundlePath`](packages/agent-interchange/src/install/config.ts:21) uses
`path.join(home, ".local", "share", SERVER_NAME, "mcp-server.mjs")`. On Windows
`path.join("/home/me", ".local", ...)` produces `\home\me\.local\share\...`
(backslashes, leading `/` stripped — Windows `path` does not treat `/` as a
drive root, so it's treated as a separator that gets normalized to `\`).

[`registration`](packages/agent-interchange/src/install/config.ts:29) calls
`path.resolve(bundlePath)`. On Windows,
`path.resolve("/durable/server.mjs")` resolves against the current drive
root → `D:\durable\server.mjs`.

[`parseArgs`](packages/agent-interchange/src/install/index.ts:88) calls
`path.resolve` on `--claude-config`, `--tumble-config`, and `--destination`
values. On Windows, `path.resolve("/tmp/claude.json")` → `D:\tmp\claude.json`.

The tests assert against literal POSIX strings:

- [`install.spec.ts:64`](packages/agent-interchange/src/__tests__/install.spec.ts:64): `.toBe("/home/me/.local/share/...")`
- [`install.spec.ts:74`](packages/agent-interchange/src/__tests__/install.spec.ts:74): `args: ["/durable/server.mjs"]`
- [`install.spec.ts:95`](packages/agent-interchange/src/__tests__/install.spec.ts:95): `claudeConfig: "/tmp/claude.json"` etc.

On Linux these match because `path.resolve("/tmp/x")` → `/tmp/x`. On Windows
they don't.

### File mode bits (failure 4)

[`install.spec.ts:41`](packages/agent-interchange/src/__tests__/install.spec.ts:41)
creates the "old bundle" fixture with `fs.writeFileSync(..., { mode: 0o700 })`.
[`install.spec.ts:147`](packages/agent-interchange/src/__tests__/install.spec.ts:147)
then asserts `fs.statSync(...).mode & 0o777` is `0o700` after rollback restores
the file.

On Windows, the `mode` option to `fs.writeFileSync` / `fs.open` does not set
Unix permission bits — files always get `0o666` (read/write for everyone),
which is the Windows default. `0o666` = 438, `0o700` = 448 — matching the error
exactly (`expected 438 to be 448`).

### Test timeouts (failures 5–6)

Both tests use the same pattern:

1. `await build({ ... })` — esbuild bundles `handoff-update-worker.ts` to disk
2. `spawn(process.execPath, [worker])` — start a child Node process
3. Wait for a marker file or exit

On `windows-latest` CI runners, esbuild bundling + Node process startup (with
Windows Defender scanning the newly-written `.mjs`) routinely takes 3–6s,
exceeding the 5000ms default vitest timeout.

### Orphaned child cleanup (failure 7)

When test 6 times out, vitest aborts the test body but the spawned child
(configured with `HANDOFF_RENAME_DELAY_MS: "30000"`) is still running. The
`afterEach` hook at
[`handoffs.spec.ts:41`](packages/agent-interchange/src/__tests__/handoffs.spec.ts:41)
runs `fs.rmSync(dir, { recursive: true, force: true })` while the child still
has the worker file and journal directory open → `ENOTEMPTY` on Windows
(where `rmdir` fails if any handle is open in the directory).

## Fix

### install.spec.ts — path separators (tests 1–3)

Build expected path values with the same `node:path` functions the production
code uses, so the test validates the _logic_ (path segments) rather than
hardcoded separators:

```ts
// test 1 (line 64)
expect(durableBundlePath("/home/me", "")).toBe(
	path.join("/home/me", ".local", "share", "agent-interchange", "mcp-server.mjs"),
)
expect(claudeConfigPath("/home/me")).toBe(path.join("/home/me", ".claude.json"))

// test 2 (line 74)
expect(updated.mcpServers?.[SERVER_NAME]).toMatchObject({
	command: "node",
	args: [path.resolve("/durable/server.mjs")],
})

// test 3 (line 95)
expect(args).toMatchObject({
	action: "install",
	claudeConfig: path.resolve("/tmp/claude.json"),
	tumbleConfig: path.resolve("/tmp/tumble.json"),
	destination: path.resolve("/tmp/server.mjs"),
})
```

`path` is already imported at the top of `install.spec.ts` (line 2).

### install.spec.ts — file mode bits (test 4)

The `0o700` mode assertion is only meaningful on Unix. On Windows, files always
report `0o666` regardless of the `mode` option. Guard the assertion:

```ts
if (process.platform !== "win32") {
	expect(fs.statSync(fixture.args.destination).mode & 0o777).toBe(0o700)
}
```

### handoffs.spec.ts — test timeouts (tests 5–6)

Increase the per-test timeout to 30s for both integration tests that bundle +
spawn. Vitest's `it()` accepts a timeout as the third argument:

```ts
it("serializes updates made by independent Node processes", async () => { ... }, 30_000)
it("does not let a crashed paused writer block or erase a later process update", async () => { ... }, 30_000)
```

30s is generous: the actual work (esbuild a tiny file + 2 spawns) completes in
under 10s even on slow Windows CI, but 30s gives headroom for antivirus
scanning and runner contention.

### handoffs.spec.ts — cleanup robustness (test 7)

Add `maxRetries` to the `afterEach` `fs.rmSync` call so Windows retries on
`ENOTEMPTY` / `EBUSY` / `EPERM` (file handles released asynchronously after
child kill):

```ts
fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
```

This is a defensive measure — the primary fix is the timeout increase, which
ensures the child is killed before `afterEach` runs. The retries handle any
residual handle-release delay on Windows.

## Verification

- `cd packages/agent-interchange && npx vitest run` → all tests pass on Linux
  (unchanged behavior; `path.resolve("/tmp/x")` still produces `/tmp/x`).
- Windows CI: the 6 previously-failing tests now pass (path assertions match
  via `path.join`/`path.resolve`, mode assertion is skipped, timeouts allow
  the integration tests to complete, cleanup retries handle handle-release
  races).

## Out of scope

- The `mcp-server.spec.ts` cross-workspace opt-in test mentioned in the
  prior plan doc (`2026-08-25_fix-handoffs-rename-mock-crash.md`) is a
  separate issue and not addressed here.
- The symlink tests in `handoffs.spec.ts` are already guarded with
  `it.runIf(process.platform !== "win32")` and were correctly skipped on
  Windows CI (9 skipped in the log).
