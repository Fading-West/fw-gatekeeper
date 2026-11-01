---
name: verify-gatekeeper
description: Prove an FW Gatekeeper candidate in an owned, disposable local stack (local Convex backend + production Next build on loopback) — prepare, read-only Doctor, the Activity Log "Add missing punch" correction (persistence plus viewer/anonymous server denial), a negative control and cleanup that keeps evidence. Use only when FW Gatekeeper verification is explicitly requested; never for production, deploys or kiosks.
disable-model-invocation: true
---

Opt-in package; run every command from the repository root. Read
[environment.md](environment.md) for prerequisites and bindings and
[features.json](features.json) for the pilot contract. It archives the committed
candidate (`git archive HEAD`), installs its locked dependencies, starts its own
`convex-local-backend` (SQLite inside the run) and a production `next build` /
`next start` of that archive, both on loopback-only ports. Convex Auth signing
keys, fixture passwords and tokens are generated per run. It never reads caller
environment variables, `.env*` files, `~/.convex` credentials, a cloud Convex
deployment, Render, kiosks or the face service.

1. Commit the candidate, then
   `node .agents/skills/verify-gatekeeper/run.mjs prepare` and keep the printed
   `RUN=` directory. Prepare deploys the candidate's `convex/` to the owned backend,
   seeds the repository's synthetic `seed:run` roster, creates one portal account
   per role (`admin`, `enrollment`, `viewer`, `@verify-gatekeeper.invalid`) and
   signs each in through the real `/login` page.
2. `node .agents/skills/verify-gatekeeper/run.mjs doctor --run RUN` (read-only):
   caller checkout equals the candidate; archived `convex/` and `src/` are
   blob-identical to it with no extra files; lockfile and installed dependency
   identity; identity-checked backend/app processes listening only on 127.0.0.1;
   backend instance, binary hash and deployed function hashes; `/api/health`;
   the served `_buildManifest.js` equals the archived build and served client
   chunks target the owned backend (no `*.convex.cloud`); fixture roles, workers
   and live sessions (only admin reaches `/kiosks`); the Command Center
   `/api/activity` feed with a run-owned token (200) and without one (401). Every
   table is compared before and after; only auth-token and cron tables may change.
3. `node .agents/skills/verify-gatekeeper/run.mjs feature --run RUN`: the
   `enrollment` user adds a missing clock-in through Activity Log → **Add missing
   punch** (yesterday's factory date). It proves a fresh database read of exactly
   one `attendanceCorrections` row matching the UI request with `actorUserId` =
   the enrollment user, the row after reload and in a fresh admin session, and
   that `viewer` sees the row but no control. A viewer replay of the UI request
   gets 401 from the app; the same mutation called straight at Convex with the
   viewer's token fails `Insufficient permissions`; anonymous gets 401 /
   `Unauthorized`. A whole-database diff must show only the allowed row. It then
   runs the existing `src/app/log/direct-corrections.browser.test.ts` and
   `src/components/AttendanceCorrectionDialog.browser.test.ts` unchanged (no skips).
4. `node .agents/skills/verify-gatekeeper/run.mjs negative-control --run RUN`
   deploys a disposable defect to the owned backend only (`viewer` added to
   `attendanceCorrections.create`'s role list). The same feature check must fail at
   `viewer-convex-mutation-denied`; the file is restored byte-for-byte, the
   redeployed function hashes must equal prepare's, and the check must pass again.
5. Always `node .agents/skills/verify-gatekeeper/run.mjs cleanup --run RUN`, also
   after failures. It stops only processes whose pid, kernel start time and run
   directory match, deletes `app/`, `backend/`, `home/` and `sessions/`, empties
   the secrets in `state.json`, and keeps `RUN/evidence/` and private `RUN/logs/`.
   Repeating it is safe.

Exit status: 0 pass, 1 check failed (the output names the first failed
assertion), 2 usage/ownership error. `state.json`, `sessions/` and `logs/` are
private (mode 0600/0700); never print them or process environments. Stop on any
ownership or identity mismatch. An interrupted command leaves `RUN/operation.lock`;
confirm its pid is gone before deleting it. Prepare a new run rather than editing
state or attaching to another server.

Report the candidate SHA, commands, evidence paths, assertions and limitations.
Independent reviewers confirm their own checkout SHA and replay in a fresh run.
Kiosk hardware and ingest, the face service, Resend/webhook alert delivery, the
real Command Center consumer, Render and the production Convex deployment stay
unverified unless separately exercised; never infer them from this local pass.
[discovery.md](discovery.md) records discovery and [proof.md](proof.md) the pilot
proof. The package is proven on its branch only until Noah merges it; it grants no
merge or deployment authority.
