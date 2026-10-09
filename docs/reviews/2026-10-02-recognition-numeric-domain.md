# Ranked gap 14: Reject calibration telemetry outside valid score and quality ranges

Problem: Ingest accepts nonfinite and impossible scores, thresholds and quality values, poisoning confidence bands and supervisor calibration decisions.

User: Managers using recognition diagnostics.

Benefit: Rejects corrupt numerical measurements before they contaminate calibration and review evidence.

Priority rationale: Every recognition upload; diagnostic trust impact; small change. Frequency refers to the affected operation, not measured production incident rates; no quantitative time-savings claim is made.

Scope: The implementation and regression tests in this PR. Existing attendance remains preserved; no production configuration, deployed services, real credentials, or real face data are changed.

Acceptance: Reject nonfinite/out-of-domain metrics before any write; preserve legitimate negative cosine similarity and floating-point boundary tolerance.

Dependencies: Independently based on master `0ab3795986cb0bad446a644f7b91394a83f2cff8`. Uses existing Node 22 / locked npm dependencies and isolated Python 3.11 CI dependencies. No new paid service. Other recognition/enrollment PRs touch shared files; combine them deliberately and rerun the suite before release. Physical/native-device acceptance and release verification remain pending.

Test plan: Run the focused regression, all repository tests (Vitest/Convex test runtime, isolated Python tests, source contracts), both TypeScript checks, ESLint, and a production Next.js build. Review permissions, atomic writes, replay and event ordering as applicable. The automated checks use synthetic isolated records and mocked service/network boundaries; they do not establish physical recognition accuracy or production deployment health.

```sh
npx vitest run convex/oct02-recognition-numeric-domain.test.ts
PYTHON=/path/to/isolated/venv/bin/python npm test
npm run typecheck
npm run lint
NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud NEXT_TELEMETRY_DISABLED=1 npm run build
```

Physical acceptance procedure: In an isolated staging installation with authorized test users and existing configuration, exercise the changed path and its denial/retry cases, check manager views and audit/attendance preservation, then perform release checks before deploying. No production or physical-device acceptance was run in this task.

Evidence: Automated regression failures before the change and passing checks after it are retained in the task evidence. Final PR descriptions identify the exact published head and its executed checks. No deployment, merge, or physical acceptance is implied.

## Integration review revision

The Next.js route validates raw metric aliases before optional normalization, rejecting JSON exponent overflow (1e400), nonnumbers and out-of-domain finite values with INVALID_RECOGNITION_METRIC. The Convex HTTP boundary propagates this validator code as 400. The shared bounded replay/quarantine path preserves rejected metric evidence and source IDs without marking it synced, isolates nonfinite JSON serialization before HTTP, and lets later valid records drain. Authentication, conflicts, unknown 400s, server failures and incomplete acknowledgements remain retryable. Operator inspection/release retains the original rejection audit.

Operator procedure (local, authorized support session only): run `python recognition_rejections.py list` from `pi-kiosk` using the kiosk's existing configured database. Inspect the recorded reason and original evidence. After an authorized repair or restored compatible validation, use `python recognition_rejections.py retry REJECTION_ID --note "reason for safe retry"`. Release alone does not modify an event or claim ingestion; an unchanged invalid event will be quarantined again. Review the retained rejection/release audit and subsequent acknowledgement. No real kiosk database or this command against production was used here.

Integration dependency: PRs #97, #103 and #107 touch recognition replay acknowledgement. PRs #103 and #107 include the same rejection-isolation foundation so each is independently testable; merge the common foundation once and retain the focused validator and regression additions from both. PRs #102 and #103 both require a captured upload timestamp; preserve that common check once. Rerun combined tests before release.

## Follow-up review revision

Follow-up review: shared quarantine health reporting separates retryable depth from retained rejected attempts, with local Needs attention and authenticated manager health visibility. An additive optional rejectedAttempts field traverses the actual Next/Convex ingest boundaries; public health exposes only aggregate counts. This is the same common foundation as PR #103 and must be integrated once.
