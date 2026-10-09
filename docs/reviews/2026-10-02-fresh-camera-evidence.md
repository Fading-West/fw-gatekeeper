# Ranked gap 7: Discard stale face results across camera interruption and recovery

Problem: Camera capture failures retain pending recognition/blink state; delayed results can record a scan after the worker has left and the camera has recovered.

User: Employees scanning at entry and exit kiosks.

Benefit: Stops stale frames from creating attendance after camera interruption while preserving current fault diagnostics.

Priority rationale: Every camera interruption/delayed inference; high false-attendance prevention impact; moderate change. Frequency refers to the affected operation, not measured production incident rates; no quantitative time-savings claim is made.

Scope: The implementation and regression tests in this PR. Existing attendance remains preserved; no production configuration, deployed services, real credentials, or real face data are changed.

Acceptance: Old, future and pre-interruption results are discarded; camera failure cancels pending blink and queued frames; a current post-recovery result can record normally.

Dependencies: Independently based on master `0ab3795986cb0bad446a644f7b91394a83f2cff8`. Uses existing Node 22 / locked npm dependencies and isolated Python 3.11 CI dependencies. No new paid service. Other recognition/enrollment PRs touch shared files; combine them deliberately and rerun the suite before release. Physical/native-device acceptance and release verification remain pending.

Test plan: Run the focused regression, all repository tests (Vitest/Convex test runtime, isolated Python tests, source contracts), both TypeScript checks, ESLint, and a production Next.js build. Review permissions, atomic writes, replay and event ordering as applicable. The automated checks use synthetic isolated records and mocked service/network boundaries; they do not establish physical recognition accuracy or production deployment health.

```sh
$PYTHON pi-kiosk/test_oct02_fresh_camera_evidence.py; $PYTHON pi-kiosk/test_oct02_camera_fault_integration.py
PYTHON=/path/to/isolated/venv/bin/python npm test
npm run typecheck
npm run lint
NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud NEXT_TELEMETRY_DISABLED=1 npm run build
```

Physical acceptance procedure: On an isolated kiosk with a consenting tester, interrupt the camera during recognition and during blink verification. No cached scan may clock the tester; reconnecting must require a fresh frame and expose fault/recovery status.

Evidence: Automated regression failures before the change and passing checks after it are retained in the task evidence. Final PR descriptions identify the exact published head and its executed checks. No deployment, merge, or physical acceptance is implied.
