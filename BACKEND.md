# UR-1042 backend

Implemented in the backend track: Postgres/Drizzle migrations and synthetic seed, Auth.js demo login, case/document/claim/issue APIs, three-agent execution, evidence verification, shared spend controls, packet hashing, transactional approval and invalidation. The frontend scaffold is separate work.

## Local setup

1. `npm ci`.
2. Copy `.env.example` to `.env.local`. Set `APP_DEPLOYMENT=local`, `DATABASE_URL`, `AUTH_SECRET` (at least 32 characters), `APP_ORIGIN=http://localhost:3000`, and `DEMO_CREDENTIAL_CLINICIAN_A` (at least 20 characters). Credentials have no defaults. Never commit the populated file.
3. Run `npm run db:migrate` as the database owner, then `npm run db:seed`.
4. Use a restricted application database login with membership in `app_rw` for serving. Migrations and seed need a separate owner/migrator connection. For a separate shared spend database, run the migrations there and give its runtime login membership in `spend_rw`. Runtime logins must not own the tables or be superusers.
5. `npm run dev`. Auth.js sign-in is `/api/auth/signin`: account `clinician_a`, credential from the environment.

CLI commands load `.env.local`. Seed is idempotent and never resets spend or creates agent outputs/packets/approvals. Hosted uploads accept only exact allowlisted synthetic fixtures; the late Nov 2 note's parsed body is the upload content, without its Markdown front matter.

## Model execution

`runAgent()` is the only model caller. Live calls require `ANTHROPIC_API_KEY`, a reachable shared `SPEND_LEDGER_URL`, and available budget. Preview live calls are refused. Every attempt reserves budget atomically; ordinary spending stops at $26, with the separately unlocked demo stop at $36.

`AGENT_REPLAY=1` requires actual recordings matching the agent version, model and prompt. A missing recording fails visibly; the repo does not contain fabricated recordings. `AGENT_RECORD=1` records successful live responses. Production replay requires `REPLAY_PRODUCTION_LABELED=1`. `DEMO_NOW=2026-11-03T09:00:00-05:00` freezes business time only; audit, throttling and expiry use real time.

Model identifiers and prices retain the agreed configuration. They must be verified against the provider before live execution. No live model calls were made during this build.

## API

All case resources require the assigned clinician's session. Writes require an exact configured Origin and strict JSON bodies. Auth.js additionally uses its own CSRF protection.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/cases` | Assigned queue |
| GET | `/api/cases/:id` | Case, periods, authorization, latest packet/run, demo clock |
| GET / POST | `/api/cases/:id/documents` | List / upload source |
| GET | `/api/documents/:id` | Exact source text |
| POST | `/api/documents/:id/verify` | Verify or reject; clinical verification schedules full rerun |
| POST | `/api/cases/:id/runs` | Start fixed three-agent plan; body `{}` |
| GET | `/api/runs/:id` | Agent status, attempts, error kinds, costs |
| GET | `/api/cases/:id/claims` | Claims and source spans; optional `packetVersion` UUID |
| PATCH | `/api/claims/:id` | `{text}` or `{status:"rejected"}` |
| POST | `/api/claims/:id/flags` | `{reason}` marks citation unsupported |
| GET | `/api/cases/:id/issues` | Issues and allowed resolutions |
| POST | `/api/issues/:id/resolve` | Evidence-backed resolution |
| GET | `/api/cases/:id/validation` | Current hash, checks and approval blockers |
| POST | `/api/cases/:id/approve` | `{packetVersionId,contentHash,acknowledgement}` |

Missing-note resolution: `{resolution:"attach_document",reason,evidenceDocumentId}`. Date-conflict resolution: `{resolution:"verify_period",reason,evidenceDocumentId,verifiedPeriod:{start,end}}`; the verified request remains separate from authorization. Approval is idempotent, bound to the latest packet/hash, and cannot change clinical claim statuses. Editing an approved packet creates a new version. An identical rerun preserves the prior packet and approval.

There is no submission route. Denials, appeal matching, letter parsing, extra roles and Should features remain deferred by D8.

## Verification

- `npm test`: deterministic unit tests with fake clients; no paid calls.
- `npx tsc --noEmit`, `npm run lint`, `npm run build`.
- `npm run eval`: deterministic fixture/source/coverage/gate metrics, explicitly fake-client.
- `npm run test:integration`: real PostgreSQL plus fake model clients. Use a **fresh, isolated database whose name ends `_test`**, migrate it first, set `APP_DEPLOYMENT=local`, `AGENT_REPLAY=1`, `DEMO_NOW=2026-11-03T09:00:00-05:00`. It mutates only test fixtures and ledger state. Never point it at an application database.

The integration suite covers the full missing-note/date-conflict/approval flow, duplicate execution, concurrent approval, no false invalidation, immutable history, foreign-case route denial, failed/skipped runs, database grants/audit protection, login throttling and spend settlement/expiry. Hosted Neon concurrency and live-model output quality still need environment-specific verification.

## Contract notes for review

- Backend API lives in the shared server dispatcher `lib/http/api.ts`, mounted by `app/api/[...path]/route.ts`; auth has its own route.
- Login uses an additional `login_throttles` table for exact rolling windows and blocks lasting 15 minutes from the fifth failure.
- Enum-like text columns have database CHECK constraints installed by `db:migrate`, alongside role grants and append-only audit triggers.
- Verified quote exemptions require either the whole output string to equal the quote or explicit quotation context. This deliberately tightens spec 006's broad every-occurrence rule, preventing an unquoted determination from hiding behind a matching source substring.
- `docs/` was kept read-only per the backend rules; earlier README/build-plan scope descriptions may be stale.
