# Correction history capacity — October 31, 2026

Daily review: https://trello.com/c/1Rja8Qip
Base: origin/master at 382a6145131b675b059ef9009919ed823617a4f8.
Checked all open PRs and recent daily PRs through October 30 before selecting this issue.
PR #253 fixed closeout/attendance readers, but did not change this history query.
No files overlap the existing open PRs.

`attendanceCorrections.list` performed a reversal index lookup and repeated
actor/worker reads for each correction. A scanner outage requiring two audited
punches for 700 workers produced 1,400 corrections and exceeded the enforced
4,096 index-range limit. The history API consequently returned 500 and Activity
Log could not load or export the day's attendance.

Observed proof in this session: both tests in
`convex/attendanceCorrections.capacity.test.ts` failed with the original
`attendanceCorrections.ts` and `transactionLimits: true`:
`Too many index ranges read in a single function execution (limit: 4096)`.
The second fixture represents 700 workers with two corrections each; the first
also checks reversed rows and worker-filtered history.

The query now batches reversal reads by date and caches actor and worker joins.
Small worker-filtered histories retain correction-scoped reversal reads to avoid
reading unrelated workers' reversal evidence. Multiple reversals still fail
closed; actor identities remain admin-only. Existing indexes are reused.

Run `npx vitest run convex/attendanceCorrections.capacity.test.ts` for proof.
Full lint, typecheck, test, build and exact-head GitHub CI results are recorded in
the PR description. This fixes the demonstrated index-range exhaustion; it does
not introduce pagination or promise arbitrary-sized responses.

Scope: attendance/payroll history reads. No schema migration, authentication
change, attendance write change, deployment configuration change, merge or deploy.
