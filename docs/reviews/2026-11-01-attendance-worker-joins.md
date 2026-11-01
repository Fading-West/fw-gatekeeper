# Attendance worker joins stay within query limits

On base `6d7110fd23520956bb489912b55ddce3563ebba0`, `attendance.list` fetched the full worker document again for every punch. A 700-worker day with an entry, short break, lunch and final exit has 4,200 punches. Repeated joins exhaust Convex's index-range budget; workers with 512-value biometric templates exhaust the byte budget earlier. The existing worker-read error fallback then masks those failed joins as missing workers in the test runtime. Attendance rows lose their employee IDs and departments, including the identifiers needed for payroll CSV matching.

The query now keeps worker joins in a local map for its own snapshot. Repeated worker IDs, deleted records and malformed legacy references reuse their first result, including null. There is no cache shared between requests. Worker fallback labels, event ordering, correction application, kiosk joins and authorization retain their existing behavior.

## Observed proof

All three new tests in `convex/attendance.workerJoins.test.ts` run with `transactionLimits: true` and failed before the production edit:

- 700 workers, six punches each, without templates: 108 of 4,200 rows lost employee IDs/departments.
- The same day with 512-value worker templates: 847 rows lost those fields.
- 4,200 historical punches referencing one deleted worker: repeated null joins exhausted the budget before the valid worker's punch was joined; that unrelated row lost its name, employee ID and department.

The same three tests pass with the cache. The last case also checks the malformed-ID and deleted-worker display fallbacks. Existing export identity tests verify that later requests see renames, deactivation and deletion.

Proof logs are local review artifacts under `.daily-review/`: `worker-joins-before.log`, `worker-joins-after.log`, `worker-joins-adjacent.log`, `worker-joins-typecheck.log` and `worker-joins-lint.log`. Run from this checkout, with installed dependencies:

```sh
flock -w 30 /home/noah/.cache/t3-recovery-heavy.lock node node_modules/vitest/vitest.mjs run convex/attendance.workerJoins.test.ts --maxWorkers=1
flock -w 30 /home/noah/.cache/t3-recovery-heavy.lock node node_modules/vitest/vitest.mjs run convex/attendance.workerJoins.test.ts convex/attendance.export-identity.test.ts convex/attendance.order.test.ts convex/attendance.dst.test.ts convex/attendance.offsetWindow.test.ts convex/attendance.provenance.test.ts convex/attendance.ingest.test.ts convex/attendance.receipts.test.ts convex/stats.test.ts src/lib/attendance-hours.test.ts src/lib/attendance-export.test.ts src/app/api/attendance/route.test.ts src/app/log/hours-export.test.tsx src/app/log/hours-export-lifecycle.test.tsx --maxWorkers=1
flock -w 30 /home/noah/.cache/t3-recovery-heavy.lock npm run typecheck
flock -w 30 /home/noah/.cache/t3-recovery-heavy.lock npm run lint
```

The focused run passes 3 tests. The adjacent run passes 100 tests across 14 files. Both TypeScript projects pass. Lint did not execute: a 30-second heavy-lock acquisition expired, and the queued retry was canceled at the parent reviewer's request. The parent review will run it. No full build or full suite was run for this focused implementation handoff.

## Scope and related work

Open PR [#274](https://github.com/Fading-West/fw-gatekeeper/pull/274) fixes correction-history reads in `attendanceCorrections.list`; this change fixes the separate attendance-event listing query. Related merged PR [#253](https://github.com/Fading-West/fw-gatekeeper/pull/253) batches reversal reads for closeouts. Open PRs and October 26–31 daily work were checked before implementation, and the changed files do not overlap the open-PR avoid ledger. Searches for `attendance worker join` and `attendance export query limit` found no equivalent fix.

The existing attendance scan and result remain unpaginated, so arbitrary row counts or rosters may still exceed other query limits. This change addresses repeated reads for the demonstrated workload. It needs a normal Convex function deployment to take effect; no schema change or migration is required. No deployment was performed.
