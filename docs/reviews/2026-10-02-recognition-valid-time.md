# Ranked gap 10: Reject recognition evidence that cannot belong to a factory date

Problem: Recognition ingest accepts arbitrary timestamps; malformed or nonexistent DST wall times disappear from dated reviews and shift exceptions.

User: Supervisors reviewing chronological evidence.

Benefit: Rejects impossible evidence dates so the review timeline remains sortable and attributable.

Priority rationale: Every evidence batch; ordering and diagnostic reliability impact; small change. Frequency refers to the affected operation, not measured production incident rates; no quantitative time-savings claim is made.

Scope: The implementation and regression tests in this PR. Existing attendance remains preserved; no production configuration, deployed services, real credentials, or real face data are changed.

Acceptance: Reject malformed, overflow and nonexistent factory-local timestamps atomically; accept UTC, offsets and supported legacy local formats.

Dependencies: Independently based on master `0ab3795986cb0bad446a644f7b91394a83f2cff8`. Uses existing Node 22 / locked npm dependencies and isolated Python 3.11 CI dependencies. No new paid service. Other recognition/enrollment PRs touch shared files; combine them deliberately and rerun the suite before release. Physical/native-device acceptance and release verification remain pending.

Test plan: Run the focused regression, all repository tests (Vitest/Convex test runtime, isolated Python tests, source contracts), both TypeScript checks, ESLint, and a production Next.js build. Review permissions, atomic writes, replay and event ordering as applicable. The automated checks use synthetic isolated records and mocked service/network boundaries; they do not establish physical recognition accuracy or production deployment health.

```sh
npx vitest run convex/oct02-recognition-valid-time.test.ts
PYTHON=/path/to/isolated/venv/bin/python npm test
npm run typecheck
npm run lint
NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud NEXT_TELEMETRY_DISABLED=1 npm run build
```

Physical acceptance procedure: In an isolated staging installation with authorized test users and existing configuration, exercise the changed path and its denial/retry cases, check manager views and audit/attendance preservation, then perform release checks before deploying. No production or physical-device acceptance was run in this task.

Evidence: Automated regression failures before the change and passing checks after it are retained in the task evidence. Final PR descriptions identify the exact published head and its executed checks. No deployment, merge, or physical acceptance is implied.

## Integration review revision

Invalid timestamps return HTTP 400 with INVALID_RECOGNITION_TIMESTAMP through Convex and Next.js. Missing captured timestamps are rejected rather than rewritten. The Python replay path isolates permanent timestamp/metric rejections with bounded binary splitting (64 operations, 60-second start deadline, up to 15-second socket inactivity timeout). Deterministic nonfinite JSON serialization failures are also isolated before HTTP. Original source rows and sourceAttemptId remain unchanged and unsynced; an additive recognition_rejections audit table excludes only active quarantines from retry selection. Transient failures, auth errors, 409 conflicts and partial acknowledgements stay queued. Tests preserve the rejected oldest row while 120 later rows drain within three cycles, use real requests JSON encoding without network, and cover operator release audit.

Operator procedure (local, authorized support session only): run `python recognition_rejections.py list` from `pi-kiosk` using the kiosk's existing configured database. Inspect the recorded reason and original evidence. After an authorized repair or restored compatible validation, use `python recognition_rejections.py retry REJECTION_ID --note "reason for safe retry"`. Release alone does not modify an event or claim ingestion; an unchanged invalid event will be quarantined again. Review the retained rejection/release audit and subsequent acknowledgement. No real kiosk database or this command against production was used here.

Integration dependency: PRs #97, #103 and #107 touch recognition replay acknowledgement. PRs #103 and #107 include the same rejection-isolation foundation so each is independently testable; merge the common foundation once and retain the focused validator and regression additions from both. PRs #102 and #103 both require a captured upload timestamp; preserve that common check once. Rerun combined tests before release.
