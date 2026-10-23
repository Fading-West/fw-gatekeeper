# Ranked gap 5: Require supervisor unlock to view kiosk attendance history

Problem: The ordinary worker-display credential can fetch /log and /today while supervisor controls are locked, revealing names and attendance patterns to any kiosk user.

User: Employees passing a shared kiosk.

Benefit: Limits attendance history to unlocked supervisor controls and removes it on relock.

Priority rationale: Every shared kiosk visit; high privacy impact; small change. Frequency refers to the affected operation, not measured production incident rates; no quantitative time-savings claim is made.

Scope: The implementation and regression tests in this PR. Existing attendance remains preserved; no production configuration, deployed services, real credentials, or real face data are changed.

Acceptance: Both routes deny locked callers without returning history, permit unlocked supervisors, and deny access again after relock; worker scan status remains available.

Dependencies: Independently based on master `0ab3795986cb0bad446a644f7b91394a83f2cff8`. Uses existing Node 22 / locked npm dependencies and isolated Python 3.11 CI dependencies. No new paid service. Other recognition/enrollment PRs touch shared files; combine them deliberately and rerun the suite before release. Physical/native-device acceptance and release verification remain pending.

Test plan: Run the focused regression, all repository tests (Vitest/Convex test runtime, isolated Python tests, source contracts), both TypeScript checks, ESLint, and a production Next.js build. Review permissions, atomic writes, replay and event ordering as applicable. The automated checks use synthetic isolated records and mocked service/network boundaries; they do not establish physical recognition accuracy or production deployment health.

```sh
$PYTHON pi-kiosk/test_oct02_kiosk_attendance_privacy.py; node scripts/test-oct02-kiosk-history-race.mjs
PYTHON=/path/to/isolated/venv/bin/python npm test
npm run typecheck
npm run lint
NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud NEXT_TELEMETRY_DISABLED=1 npm run build
```

Physical acceptance procedure: On a shared physical kiosk, start locked, unlock with existing supervisor credentials, verify history, relock, and wait through several refresh intervals. No names or history may appear while locked, including a delayed prior response.

Evidence: Automated regression failures before the change and passing checks after it are retained in the task evidence. Final PR descriptions identify the exact published head and its executed checks. No deployment, merge, or physical acceptance is implied.
