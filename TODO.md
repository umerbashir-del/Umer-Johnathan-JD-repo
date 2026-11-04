# Backend handoff — 2026-11-04

Paused at the user's request. Resume from `.worktrees/build`, branch `feature/backend-base`. The root checkout's README is older than the backend work. Setup/API notes: `BACKEND.md`.

## Saved and verified

- Backend implementation commit `3425c7d` pushed to shared `upstream/development` and fork `origin/feature/backend-base`.
- 286 unit tests pass; TypeScript, lint and production build pass (Next.js 15.5.29).
- Fresh PostgreSQL integration on `ur_backend_final_test` passes: full UR-1042 upload/verify/resolve/rerun/approve flow, concurrent approval, identical rerun, duplicate execution, immutable history, cross-case API access, failed/skipped agents, audit trigger, document grants, spend controls and login throttling.
- Fake model clients only. Zero live model calls. Hosted/live quality verification is not complete.

## Remaining work (next session)

- [ ] Verify the final `lib/db/security.ts` composite constraints. Two parent `(id, case_id)` unique constraints and five same-case foreign keys were added after the fresh-database run. This last change is coherent but **not yet applied or integration-tested**. Run `db:migrate` against an isolated `_test` database and add direct cross-case FK rejection assertions; rerun the full integration suite on a fresh database.
- [ ] Include `testInvariantChecks(db)` from `scripts/security-integration.ts` in the main integration runner. Its 28 CHECK constraints were separately tested; new composite FK tests are still needed.
- [ ] Rerun `npm run eval` after the CLI `.env.local` loader addition. The prior deterministic evaluation passed; the latest attempt was blocked by the sandbox's tsx IPC restriction and needs an escalated rerun. No paid API calls are needed.
- [ ] Rerun unit tests, TypeScript, lint and production build after final changes. Commit and push any follow-up to shared `development` and the fork feature branch.
- [ ] Review remaining dependency advisories. The scaffold's critical Next.js advisories were patched; the last install still reported 11 moderate and 2 high advisories, including transitive packages. Inspect production vs development exposure and apply compatible fixes; do not blindly force upgrades.
- [ ] Verify actual Auth.js HTTP sign-in/session cookies with the running app and configured demo credential. Pure auth tests and actual PostgreSQL login/throttle checks pass; full browser/HTTP cookie roundtrip has not been run.
- [ ] Verify stale run recovery during polling. `sweepStaleRuns()` runs before a new start; polling currently does not invoke it. Check the desired UI recovery behavior against TRD §2.7.
- [ ] Configure hosted app/runtime roles and shared spend ledger; run concurrency checks against hosted Neon. Local PostgreSQL verification does not prove hosted deployment behavior.
- [ ] Verify configured provider model identifiers and pricing before live calls. Preserve human decisions/spend limits; never print/read secret files. Once the tested shared ledger is configured, record real replays and run live structural/grounding checks under the authorized $26 ordinary testing stop. The $10 demo reserve needs human unlock.
- [ ] Frontend handoff to Umer: API routes and JSON shapes in `BACKEND.md`, no frontend screens implemented by this track. No submission path. Denial/appeal/letter features and Should work remain deferred by D8.

## Test setup notes

Temporary local Postgres cluster: `/tmp/ur-backend-pg`, user `urtest`, host `127.0.0.1`, port `55432`. Databases `ur_backend_test` and `ur_backend_final_test` contain synthetic test mutations. The full-flow runner requires a fresh database ending `_test`; do not run it against application data or reset an application's spend ledger.

CLI: set `APP_DEPLOYMENT=local`, a test `DATABASE_URL`, `AGENT_REPLAY=1`, and `DEMO_NOW=2026-11-03T09:00:00-05:00`. Run `npm run db:migrate`, then `npm run test:integration`. The runner supplies fake clients internally. Sandbox local connections/tsx/build workers may require escalation.

## Recorded contract changes

- Login adds `login_throttles` for rolling windows and exact 15-minute blocks.
- Database runtime ledger role is named `spend_rw` (older schema notes name it differently).
- Quote exemptions require whole-string equality or explicit quotation context, tightening spec 006 to avoid masking an unquoted clinical determination.
- `docs/` kept read-only; update canonical team docs through the agreed handoff process.
