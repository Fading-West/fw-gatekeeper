# Ranked gap 11: Reset blink verification when face evidence becomes invalid

Problem: Missing frames or invalid face rectangles return without clearing accumulated closed-eye frames; a later unrelated open-eye frame can complete a nonconsecutive blink.

User: Employees using blink verification.

Benefit: Requires an uninterrupted blink sequence across valid eye measurements.

Priority rationale: Every liveness scan/dropout; false-acceptance prevention impact; small change. Frequency refers to the affected operation, not measured production incident rates; no quantitative time-savings claim is made.

Scope: The implementation and regression tests in this PR. Existing attendance remains preserved; no production configuration, deployed services, real credentials, or real face data are changed.

Acceptance: A missing face, invalid rectangle, or nonfinite/degenerate EAR resets verification; only consecutive valid identity-bound closed and open frames complete a blink.

Dependencies: Independently based on master `0ab3795986cb0bad446a644f7b91394a83f2cff8`. Uses existing Node 22 / locked npm dependencies and isolated Python 3.11 CI dependencies. No new paid service. Other recognition/enrollment PRs touch shared files; combine them deliberately and rerun the suite before release. Physical/native-device acceptance and release verification remain pending.

Test plan: Run the focused regression, all repository tests (Vitest/Convex test runtime, isolated Python tests, source contracts), both TypeScript checks, ESLint, and a production Next.js build. Review permissions, atomic writes, replay and event ordering as applicable. The automated checks use synthetic isolated records and mocked service/network boundaries; they do not establish physical recognition accuracy or production deployment health.

```sh
$PYTHON pi-kiosk/test_oct02_continuous_blink_evidence.py
PYTHON=/path/to/isolated/venv/bin/python npm test
npm run typecheck
npm run lint
NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud NEXT_TELEMETRY_DISABLED=1 npm run build
```

Physical acceptance procedure: On a physical kiosk, test blink/no-blink and interrupt face/landmark tracking between closed/open phases. Reacquisition must require a fresh uninterrupted blink.

Evidence: Automated regression failures before the change and passing checks after it are retained in the task evidence. Final PR descriptions identify the exact published head and its executed checks. No deployment, merge, or physical acceptance is implied.

## Integration review revision

Both kiosk and standalone enrollment call the liveness policy when no face is detected; camera read failure resets enrollment liveness. Each eye measurement must independently be finite and positive before blink progress advances. Tests execute production caller AST paths for a closed-eye, absent-face, open-eye sequence and verify recovery requires fresh valid continuity. Physical blink/model accuracy remains unverified.
