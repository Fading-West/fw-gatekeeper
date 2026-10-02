# Ranked gap 15: Record who changed recognition review decisions

Problem: Recognition reviews close exceptions but currently record no authenticated actor or before/after trail; operators cannot explain subsequent review changes.

User: Administrators tracing exception decisions.

Benefit: Records who changed recognition review state and the before/after values.

Priority rationale: Every manager review change; accountability and investigation time impact; small change. Frequency refers to the affected operation, not measured production incident rates; no quantitative time-savings claim is made.

Scope: The implementation and regression tests in this PR. Existing attendance remains preserved; no production configuration, deployed services, real credentials, or real face data are changed.

Acceptance: Every authorized review change writes an append-only actor-linked before/after audit record in the same transaction; viewer/unauthenticated changes remain blocked.

Dependencies: Independently based on master `0ab3795986cb0bad446a644f7b91394a83f2cff8`. Uses existing Node 22 / locked npm dependencies and isolated Python 3.11 CI dependencies. No new paid service. Other recognition/enrollment PRs touch shared files; combine them deliberately and rerun the suite before release. Physical/native-device acceptance and release verification remain pending.

Test plan: Run the focused regression, all repository tests (Vitest/Convex test runtime, isolated Python tests, source contracts), both TypeScript checks, ESLint, and a production Next.js build. Review permissions, atomic writes, replay and event ordering as applicable. The automated checks use synthetic isolated records and mocked service/network boundaries; they do not establish physical recognition accuracy or production deployment health.

```sh
npx vitest run convex/oct02-recognition-review-audit.test.ts
PYTHON=/path/to/isolated/venv/bin/python npm test
npm run typecheck
npm run lint
NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud NEXT_TELEMETRY_DISABLED=1 npm run build
```

Physical acceptance procedure: In an isolated staging installation with authorized test users and existing configuration, exercise the changed path and its denial/retry cases, check manager views and audit/attendance preservation, then perform release checks before deploying. No production or physical-device acceptance was run in this task.

Evidence: Automated regression failures before the change and passing checks after it are retained in the task evidence. Final PR descriptions identify the exact published head and its executed checks. No deployment, merge, or physical acceptance is implied.
