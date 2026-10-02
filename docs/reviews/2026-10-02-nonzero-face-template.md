# Ranked gap 6: Reject unusable zero and overflowing face templates

Problem: A 512-value zero vector is stored and reported as recognition-ready even though it can never identify a worker.

User: Enrollment operators and kiosk users.

Benefit: Rejects vectors that cannot represent a usable normalized face template before they reach matching.

Priority rationale: Every face upload or legacy roster check; reliability impact; small change. Frequency refers to the affected operation, not measured production incident rates; no quantitative time-savings claim is made.

Scope: The implementation and regression tests in this PR. Existing attendance remains preserved; no production configuration, deployed services, real credentials, or real face data are changed.

Acceptance: Reject zero-norm and overflowing-norm templates at portal and backend boundaries; preserve valid normalized vectors and metadata-only updates.

Dependencies: Independently based on master `0ab3795986cb0bad446a644f7b91394a83f2cff8`. Uses existing Node 22 / locked npm dependencies and isolated Python 3.11 CI dependencies. No new paid service. Other recognition/enrollment PRs touch shared files; combine them deliberately and rerun the suite before release. Physical/native-device acceptance and release verification remain pending.

Test plan: Run the focused regression, all repository tests (Vitest/Convex test runtime, isolated Python tests, source contracts), both TypeScript checks, ESLint, and a production Next.js build. Review permissions, atomic writes, replay and event ordering as applicable. The automated checks use synthetic isolated records and mocked service/network boundaries; they do not establish physical recognition accuracy or production deployment health.

```sh
npx vitest run convex/oct02-nonzero-face-template.test.ts
PYTHON=/path/to/isolated/venv/bin/python npm test
npm run typecheck
npm run lint
NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud NEXT_TELEMETRY_DISABLED=1 npm run build
```

Physical acceptance procedure: In an isolated staging installation with authorized test users and existing configuration, exercise the changed path and its denial/retry cases, check manager views and audit/attendance preservation, then perform release checks before deploying. No production or physical-device acceptance was run in this task.

Evidence: Automated regression failures before the change and passing checks after it are retained in the task evidence. Final PR descriptions identify the exact published head and its executed checks. No deployment, merge, or physical acceptance is implied.
