# Concurrent approval, evidence integrity and permission attacks

These checks run without live AI. They use real route handlers, validation, approval records, PostgreSQL transactions/locks and database grants. The security fixtures are explicitly prepared synthetic packet states cloned from UR-1042, with completed synthetic agent rows and exact original-source quotations. No model client is created. The existing full integration suite separately exercises the orchestrator using fake clients.

## Reproduced findings and fixes

The first run had six failing checks out of 24, representing four gaps:

| Finding | Reproduction | Correction |
| --- | --- | --- |
| New sources did not consistently invalidate API sign-off | Race upload with approval, or upload after recheck and directly call the approval API. An unverified duplicate source could leave a valid approval or receive a 200 sign-off response. | Recompute source freshness and verification checks server-side. New arrivals require recheck; unverified sources require explicit verification or rejection. Upload-triggered approval revalidation now invalidates stale approval. |
| Source fingerprints were trusted without recomputing the content hash | Fault-inject a change outside the quoted passage while leaving the stored fingerprint unchanged. The quotation still matched, allowing approval. | Recompute every case source's SHA-256 and compare it to its stored fingerprint during validation. A mismatched source blocks sign-off, even after packet hash refresh or a model-generated pass. |
| Edited material claims could lose their evidence requirement | Fault-inject removal of the evidence link from a clinician-edited material claim, then refresh the packet hash. | Require a verified source link for every included, non-rejected material claim, including clinician-edited claims. |
| Queued requests could retain a revoked role | Hold the case row lock, wait until sign-off or reassignment is blocked on that lock, change the actor's role, then release the lock. The old request could still complete with its previous role. | Re-read the current identity/role inside execution, after acquiring the case lock. Hold a shared user-row lock through the mutation transaction, then check role and case scope again. The handler receives this current identity. |

The fingerprint and missing-link reproductions are privileged database fault injections, **not claims that ordinary HTTP users could modify source records**. HTTP clients cannot patch original documents or provide new evidence links, and the application's database role cannot update original source text. These fault tests verify defense in depth when persisted data is damaged. They do not provide protection against an administrator rewriting all data and integrity metadata together.

## Final coverage

All **39 named security scenarios** passed:

- Ten simultaneous sign-offs return the same approval ID and produce one approval and one success audit event.
- Approval races with edits, rejection, upload, reassignment and new runs. Both serialization orders are also forced for each change, producing ten additional deterministic race scenarios.
- Wrong quotations, changed offsets, missing links, rejected sources, cross-case substitution and damaged source content block approval.
- Unverified sources cannot be cleared merely by a newer run timestamp or a refreshed packet hash. Code integrity failures cannot be overridden by a model pass.
- Old packet IDs cannot borrow a new packet's hash after an approved edit.
- Coordinator, manager and packet staff cannot perform clinician-only mutations. Foreign clinicians cannot read or mutate another assigned case by guessing resource IDs.
- Anonymous requests, forged approval fields/hashes, invalid origins, forged upload verification and altered allowlisted content are refused.
- Membership and role changes are checked after lock waits; revoked clinician/manager writes and revoked packet-reader access are refused.
- Original UR-1042 source rows remain unchanged; only independent synthetic security cases are mutated.

For active rechecks, an earlier approval record can remain historical/valid until results establish whether the packet changed. It is **not releasable** while the latest run is incomplete: packet reads and new sign-off are blocked. This preserves the existing requirement that an identical successful rerun can retain its approval.

## Reproduce

Create a fresh, local PostgreSQL database with a name ending `_test` using the existing local service. Supply its `DATABASE_URL`, `APP_DEPLOYMENT=local`, `FREEFORM_UPLOAD_ENABLED=0`, `AGENT_REPLAY=1`, and the existing synthetic `DEMO_NOW` to the test process. Never point this suite at an application database.

```text
npm run db:migrate
npm run test:security -- after
```

The suite refuses nonlocal databases, databases without the `_test` suffix, and populated case databases. It does not reset rate limits or reuse mutated fixtures. Source allowlisting must remain enabled. Real provider credentials and a spend-ledger connection are unnecessary.

PostgreSQL lock waits are detected through `pg_stat_activity` in the isolated database, rather than guessing race order with sleeps. For deterministic ordering tests, one operation executes its real production handler under the held lock while the competing API request is confirmed waiting; the request then resumes after commit. Database fault injections use the test database owner. Normal source-write restrictions are tested separately under `app_rw`.

Detailed before/after evidence is stored locally in ignored `.e2e-results/security-before.json` and `.e2e-results/security-after.json`. The historical before report records the original 24 checks; the expanded final report records all 39.

Also verified after the fixes: all 327 unit/component tests; production build, TypeScript and lint; the existing full clinician/backend integration; the five-account role integration; and real Auth.js cookie/session tests against an isolated production server, including cross-role redirects, API refusal, changed roles and deleted identities. The normal local app and a fresh synthetic demo were restarted with the corrected build.

These results cover deterministic software boundaries. They do not establish live-model accuracy, resistance to every prompt-injection strategy, or readiness for real patient data.
