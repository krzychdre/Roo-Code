# Fix: Windows ENOTEMPTY in agent-interchange readers.spec.ts (streamJsonl fd race)

Date: 2026-08-26
Branch: `fix/agent-interchange-streamjsonl-fd-race` (off `main`)

## Symptom

Windows CI, `@roo-code/agent-interchange` test task:

```
FAIL  src/__tests__/readers.spec.ts > Claude Code reader > keeps subagent turns out of the main thread
Error: ENOTEMPTY: directory not empty, rmdir 'C:\Users\RUNNER~1\AppData\Local\Temp\agent-interchange-cc-jrFIRL\projects\-tmp-proj'
```

The failure is flaky (other async reader tests in the same file pass in the
same run) and Windows-only.

## Root cause (proven, not guessed)

`streamJsonl` (`packages/agent-interchange/src/jsonl.ts`) tears down with:

```ts
} finally {
    lines.close()
    stream.destroy()
}
```

`stream.destroy()` only _begins_ the teardown; the underlying file descriptor
is closed asynchronously afterwards. So the promise returned by `streamJsonl`
(and therefore `readClaudeSession`) can resolve while the process still holds
an open descriptor on the session `.jsonl` file.

Evidence (Linux, `/tmp/fd-race-both.mjs`, a verbatim copy of `streamJsonl`
run 300 times, checking `/proc/self/fd` immediately after the awaited call
resolves):

```
fd wciaz otwarty w /proc: 2 /300
zdarzenie close jeszcze nie doszlo: 300 /300
```

So in ~0.7% of runs on a fast Linux box the descriptor is still open at
resolve time (and the stream's `close` event has not fired in 100% of runs;
usually the fd close just happens to win the race). On a slow Windows CI
runner the descriptor loses the race more often, and Windows semantics turn
that into the observed error: deleting a file that has an open handle leaves
it in "delete pending" state, the directory entry survives until the last
handle closes, and the subsequent `rmdir` of the parent inside
`fs.rmSync(recursive)` fails with ENOTEMPTY.

On Linux this can never fail: `unlink` removes the directory entry
immediately regardless of open descriptors, which is why the suite only
flakes on the Windows runner.

The failing test is exactly the code path that hits `streamJsonl`
(`readClaudeSession` -> `streamJsonl`), then `afterEach` immediately
`fs.rmSync`s the temp config dir with the default `maxRetries: 0`.

## Fix

1. **Root cause** - `streamJsonl` waits for the stream's `close` event before
   resolving, so no caller can observe a resolved read with a still-open
   descriptor:

    ```ts
    } finally {
        lines.close()
        stream.destroy()
        if (!stream.closed) {
            await once(stream, "close")
        }
    }
    ```

    Verified with the same repro harness: with this variant the open-fd count
    drops to 0/300 and `stream.closed` is true at resolve time in 300/300.

2. **Hardening** - the temp-dir cleanup in `readers.spec.ts` gets
   `maxRetries: 3, retryDelay: 100` on its recursive `rmSync` calls,
   mirroring the existing precedent (and comment) in
   `handoffs.spec.ts:39-45`. This covers the _other_ Windows holder of fresh
   temp files: antivirus / indexer handles we do not control.

## Not changed

- `readHeadLines` / `readTailLines` use `openSync`/`closeSync` - fully
  synchronous, no race.
- `install.spec.ts` / `mcp-server.spec.ts` cleanups: no observed failures;
  left untouched to keep the change scoped to the proven defect. If they ever
  flake the same way, apply the same two-line hardening.

## Discovered while verifying (pre-existing, NOT fixed here)

`mcp-server.spec.ts > only permits cross-workspace listing after a server
startup opt-in` fails on a developer machine with a live Tumble store, and
only there. Mechanism: `tumbleStorageRoots()` (`src/locate.ts`) treats
`$AGENT_INTERCHANGE_TUMBLE_STORAGE` as an _additional_ root, not a
replacement, so the "list everywhere" call also scans the real VS Code
globalStorage. Real sessions are newer than the fixture, the fixture falls
off the capped listing, and `toContain("Different project")` fails. On CI
there is no real store, so the test passes (it passed in the run this plan
responds to). Candidate follow-up (own branch): make the override exclusive,
or point `vscodeUserDirs()` at a fake HOME in this spec.

## Verification

- Repro harness before/after (above).
- `pnpm --filter @roo-code/agent-interchange test` green on Linux.
- The Windows-only race itself can only be confirmed statistically on CI.
