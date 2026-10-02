# Ranked gap 13: Preserve newer kiosk health when delayed sync requests arrive

Problem: A delayed heartbeat blindly overwrites a newer lastSync and device health, falsely clearing faults or raising offline alarms out of order.

User: Managers responding to kiosk health alerts.

Benefit: Keeps an older delayed heartbeat from replacing newer camera/queue health.

Priority rationale: Every reordered heartbeat; alert reliability impact; small change. Frequency refers to the affected operation, not measured production incident rates; no quantitative time-savings claim is made.

Scope: The implementation and regression tests in this PR. Existing attendance remains preserved; no production configuration, deployed services, real credentials, or real face data are changed.

Acceptance: Older valid sync reports are acknowledged without replacing latest health; newer reports update; malformed clocks cannot erase evidence.

Dependencies: Independently based on master `0ab3795986cb0bad446a644f7b91394a83f2cff8`. Uses existing Node 22 / locked npm dependencies and isolated Python 3.11 CI dependencies. No new paid service. Other recognition/enrollment PRs touch shared files; combine them deliberately and rerun the suite before release. Physical/native-device acceptance and release verification remain pending.

Test plan: Run the focused regression, all repository tests (Vitest/Convex test runtime, isolated Python tests, source contracts), both TypeScript checks, ESLint, and a production Next.js build. Review permissions, atomic writes, replay and event ordering as applicable. The automated checks use synthetic isolated records and mocked service/network boundaries; they do not establish physical recognition accuracy or production deployment health.

```sh
npx vitest run convex/oct02-monotonic-kiosk-health.test.ts
PYTHON=/path/to/isolated/venv/bin/python npm test
npm run typecheck
npm run lint
NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud NEXT_TELEMETRY_DISABLED=1 npm run build
```

Physical acceptance procedure: In an isolated staging installation with authorized test users and existing configuration, exercise the changed path and its denial/retry cases, check manager views and audit/attendance preservation, then perform release checks before deploying. No production or physical-device acceptance was run in this task.

Evidence: Automated regression failures before the change and passing checks after it are retained in the task evidence. Final PR descriptions identify the exact published head and its executed checks. No deployment, merge, or physical acceptance is implied.
