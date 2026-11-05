# Closeout acknowledgement for future shifts

A saved early-signoff acknowledgement remained valid after the pending shift roster changed. At 07:00, a supervisor could acknowledge one worker's 08:00 shift with a note about that worker, then complete closeout after another worker was added, without reviewing the changed blocker. A stale acknowledgement submitted directly also succeeded.

`shiftCloseouts.ts` treated not-yet-due workers as blockers but omitted them from `blocker_evidence`. The fix adds sorted worker IDs and assigned start/end times whenever pending workers exist. Worker replacements and schedule-time changes now invalidate the acknowledgement. Names, routine clock ticks and unchanged writes do not. When the final pending worker starts, the evidence changes; any remaining blockers require fresh review.

The field is omitted when there are no pending workers, preserving the exact existing evidence shape for unrelated older acknowledgements. Older saved acknowledgements that did cover pending workers need fresh review after this change. The existing 200,000-character evidence limit still applies. No new database reads, schema, migration, attendance writes, payroll calculation or authorization change.

## Observed proof

Base: `origin/master` at `6d7110fd23520956bb489912b55ddce3563ebba0`.

- Before the production change, `convex/shiftCloseouts.futureShiftEvidence.test.ts`: **9 failed, 2 passed**. Saved acknowledgements did not become stale; stale submitted acknowledgements returned successful completed records. Stable controls passed.
- With the fix, the new suite plus `t3-blocker-ack`, `shiftBriefing.notYetDue`, and `shiftCloseouts`: **36 passed** across four files.
- Related action-retry, signed-evidence composition/review, API and UI blocker-conflict tests: **17 passed** across five files.
- Cases cover worker additions, same-count replacements, start/end changes, renewed successful signoff, stable names/time/unchanged writes, future-to-started transition with another blocker, and compatibility when no pending worker exists.

Focused command: `node_modules/.bin/vitest run convex/shiftCloseouts.futureShiftEvidence.test.ts convex/t3-blocker-ack.test.ts convex/shiftBriefing.notYetDue.test.ts convex/shiftCloseouts.test.ts --maxWorkers=1`.

Scope: closeout signoff data integrity. Open/recent PR file inventory and October 26–29 hunt journals checked; no duplicate or production-file overlap found. Open #252 preserves the page's unsaved form and is separate; its files are unchanged. No push, PR, merge or deployment performed by the implementation worker. Tests use synthetic Convex records and mocked time; no live supervisor workflow was exercised.
