# Roster confirmation alert proof

Card: https://trello.com/c/VOktcIf3

Implemented from the user's authoritative summary. No Trello connector or credentials
were available, and the public card JSON could not be read. Base: `382a6145`
(`origin/master`), including merged PR #261. No deployment was performed.

## Observed regression proof

Before implementation, the new tests were run against the base implementation:

```text
Test Files  5 failed (5)
     Tests  8 failed | 28 passed (36)
```

Failures included missing receipt retry evidence, missing nullable sequence comparison,
missing shared helper, absent system-health warnings and amber rendered tile, false
recovery while held, missing retry-based episode start, and stale notification history
when replacing a roster episode. The helper suite failed to import because the helper
did not exist yet. Raw output: `/tmp/gk-roster-proof/before.log`.

After implementation, the focused command passed:

```sh
npx vitest run src/lib/kiosk-roster-confirmation.test.ts \
  convex/kiosks.rosterReceipts.test.ts convex/alerts.test.ts \
  src/app/api/system-health/roster-confirmation.test.ts \
  src/app/kiosks/roster-confirmation.test.tsx \
  src/app/api/system-health/clock-health.test.ts \
  src/app/kiosks/credentials-ui.test.tsx
```

```text
Test Files  7 passed (7)
     Tests  55 passed (55)
```

The rendered page test mounts the real `KiosksPage`, verifies the applied time remains
visible, checks amber styling on stalled tiles only, and checks awaiting Yes/No/Unknown.
The action test exercises real Convex receipt issuance/reuse, state loading, alert
planning, persisted notification timing, stubbed webhook payloads, revoked/offline
holds, resumed reminders, and exactly one recovery after acknowledgement.
The receipt test advances the clock between retries to prove `retriedAt` never resets.
New-episode tests prove a changed retry bypasses the reminder interval and clears old
notification history even if the new delivery fails.

## Local validation

- `node scripts/test-kiosk-readiness-contract.mjs`: passed.
- `npm run lint`: exit 0, six existing warnings (no errors).
- `npm run typecheck`: exit 0 (portal and Convex TypeScript projects).
- `NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud NEXT_TELEMETRY_DISABLED=1 npm run build`:
  exit 0; compiled successfully and generated all 18 static pages.

Raw validation output is in `/tmp/gk-roster-proof/` in the implementer's workspace.

## Pre-existing full-suite failure

An additional full Vitest run initially reported 1,700 passing tests, three skipped,
and five failures, all in `convex/shiftExceptions.arrivalReview.test.ts`. Running that
file from a fresh `git archive origin/master` snapshot reproduced all five failures
(`/tmp/gk-roster-proof/baseline-unrelated.log`). The fixture created its worker at
10:00 on the shift date, after the 07:00 shift start; roster membership correctly
suppressed arrival checks. The fixture now creates the worker the preceding day,
then restores the original evaluation time. No application behavior changed.
The eight focused files, including this corrected fixture, passed all 60 tests.

The full Vitest rerun passed:

```sh
NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud npx vitest run --maxWorkers=2
```

```text
Test Files  209 passed | 1 skipped (210)
     Tests  1705 passed | 3 skipped (1708)
```

This is the JavaScript/TypeScript part of local CI validation; Python suites and the
face-service Docker build were not run for this portal/Convex-only change.
