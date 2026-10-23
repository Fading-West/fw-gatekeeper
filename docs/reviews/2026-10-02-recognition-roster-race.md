# Ranked gap 2: Check the current biometric roster before recording a face scan

Problem: An in-flight recognized face result still records attendance after the worker is removed or its template changes during sync; main currently trusts the stale snapshot deliberately.

User: Employees and attendance administrators.

Benefit: Prevents incorrect attendance after a worker is revoked or re-enrolled during an in-flight scan.

Priority rationale: Every recognition/sync overlap; high attendance integrity impact; moderate change. Frequency refers to the affected operation, not measured production incident rates; no quantitative time-savings claim is made.

Scope: The implementation and regression tests in this PR. Existing attendance remains preserved; no production configuration, deployed services, real credentials, or real face data are changed.

Acceptance: Automatic writes recheck immutable server identity and template in a SQLite write transaction; removed/replaced identities are blocked; prior offline attendance remains intact.

Dependencies: Independently based on master `0ab3795986cb0bad446a644f7b91394a83f2cff8`. Uses existing Node 22 / locked npm dependencies and isolated Python 3.11 CI dependencies. No new paid service. Other recognition/enrollment PRs touch shared files; combine them deliberately and rerun the suite before release. Physical/native-device acceptance and release verification remain pending.

Test plan: Run the focused regression, all repository tests (Vitest/Convex test runtime, isolated Python tests, source contracts), both TypeScript checks, ESLint, and a production Next.js build. Review permissions, atomic writes, replay and event ordering as applicable. The automated checks use synthetic isolated records and mocked service/network boundaries; they do not establish physical recognition accuracy or production deployment health.

```sh
$PYTHON pi-kiosk/test_oct02_recognition_roster_race.py; $PYTHON pi-kiosk/test_oct02_roster_transaction_concurrency.py
PYTHON=/path/to/isolated/venv/bin/python npm test
npm run typecheck
npm run lint
NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud NEXT_TELEMETRY_DISABLED=1 npm run build
```

Physical acceptance procedure: On an isolated physical kiosk, pause inference after matching a synthetic consenting tester; remove/re-enroll that tester through an authorized test portal and resume. The old result must ask for another scan; previously queued attendance must remain replayable.

Evidence: Automated regression failures before the change and passing checks after it are retained in the task evidence. Final PR descriptions identify the exact published head and its executed checks. No deployment, merge, or physical acceptance is implied.
