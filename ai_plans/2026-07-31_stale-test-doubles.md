# Seven tests that were red on main, and the one method nothing covered

Date: 2026-07-31
Scope: `src/` and `packages/cloud/` — test doubles and one stale payload
Branch: `fix/stale-test-doubles`, off `main`

---

## 1. What was failing

`main` carried **7 failing tests** across 4 files. Not flakes, not environment:
every one is a test double that drifted away from the code it stands in for,
and none of the drift was caused by a bad production change.

| File                                                      | Failing | Cause                                            |
| --------------------------------------------------------- | ------- | ------------------------------------------------ |
| `__tests__/single-open-invariant.spec.ts`                 | 1       | fake provider has no `rehydrateSubagents`        |
| `__tests__/task-resume-ui.spec.ts`                        | 2       | same                                             |
| `core/webview/__tests__/backgroundTask.spec.ts`           | 2       | stubs `getProfile`, code calls `activateProfile` |
| `core/webview/__tests__/messageEnhancer.test.ts`          | 2       | same                                             |
| `packages/cloud/.../CloudSettingsService.parsing.test.ts` | 1       | payload on the pre-#126 profile shape            |

## 2. Diagnosis (why none of these is a product bug)

**A — `this.rehydrateSubagents is not a function`.** The method is real
(`ClineProvider.ts:3973`) and is called from `createTaskWithHistoryItem`
(`:1335`). These specs invoke the prototype method against a hand-built `this`,
and the object literal was never extended when the call was added.

**B — `getProfile` vs `activateProfile`.** `resolveMemoryWriterApiConfiguration`
(`ClineProvider.ts:3767`) and `MessageEnhancer.enhanceMessage` both call
`providerSettingsManager.activateProfile`. Both doubles stub only `getProfile`,
so `activateProfile` was `undefined`, the call threw, and the catch swallowed it.
The tests did not merely fail — the two in each file that _passed_ were passing
through the error branch they were written to avoid.

**C — the cloud settings payload.** Traced with `git log -L`:

```
6792f2a0b Refactor/provider simplification (#126)
-	providerProfiles: z.record(z.string(), providerSettingsWithIdSchema).optional(),
+	providerProfiles: z.record(z.string(), opaqueProviderProfileSchema).optional(),
```

`#126` moved a profile from flat (`apiProvider`, `apiKey`, …) to nested
(`{ id?, provider: { providerId, opaqueLegacyPayload } }`) and did not update
this test. Probed directly against the schema, the old payload fails with
`providerProfiles.default.provider: Required`, the organization blob is rejected
whole, and `getSettings()` returns `undefined` — which is what the assertions
were reporting, for a reason that had nothing to do with "complex nested
provider settings".

## 3. The fixes

- **A**: the doubles carry the _real_ prototype method rather than `vi.fn()`.
  The history items in these specs have no `parallelChildIds`, so it returns at
  its first guard and touches nothing — and a double that drifts again fails on
  something meaningful instead of on "is not a function".
- **B**: stub the method the code calls.
- **C**: the payload states a profile in the shape the schema has declared since
  `#126`.

## 4. The gap underneath A

`rehydrateSubagents` had **no test of its own**. The only thing exercising it
was these resume specs, indirectly — which is exactly why the drift surfaced as
a `TypeError` and not as anything about subagents. It now has one
(`core/webview/__tests__/rehydrateSubagents.spec.ts`, 5 cases): the no-children
no-op, the restore-and-post path, the filter that keeps a half-written sidecar
from inventing panel rows, and the best-effort behaviour when the sidecar cannot
be read. Mutation-checked — deleting the `allowed` filter turns the third red.

## 5. Deliberately not fixed

**A three-way shape mismatch around organization-pushed provider profiles**,
found while diagnosing C. It is latent, and out of scope for a test fix:

- the schema validates `opaqueProviderProfileSchema` — nested, opaque-only;
- the exported type claims `PersistedProviderProfile` — the union that also
  admits _known_ provider profiles, which the schema would reject;
- the consumer, `ProviderSettingsManager.syncCloudProfiles`, is typed
  `Record<string, ProviderSettingsWithId>` — the **flat pre-#126 shape**, and
  reads `p.id` / `p.apiProvider` off it.

So a real organization profile arriving from the cloud would either be rejected
by the schema or mis-read by the consumer. It affects only cloud-pushed
profiles, which this deployment's self-hosted backend never sends, and fixing it
properly means deciding what the wire shape is — a product decision, not a test
repair. Recorded here rather than guessed at.

## 6. Outcome

`src`: **6956 pass, 0 fail**. Before: 6951 tests, of which 7 failed (6944
passing). Seven repaired, five added.
`packages/cloud`: **299 pass, 0 fail**.

### Merge note

`messageEnhancer.test.ts` is also fixed on `feat/telemetry-side-call-usage`,
where the same double additionally moves to `singleCompletionWithUsage`. The two
edits overlap; take the branch's version when merging that stack.
