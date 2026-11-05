# Reject explicit malformed closeout actions

Tier B: closeout data integrity. Base: `3790da196bcd180d68b7bd073f6bd120e8e1041d`.

`PATCH /api/shift-closeout` used `optionalString(body.action) || 'save'`.
Explicit null, boolean, numeric, object, array and blank actions therefore
became a valid save before reaching Convex's action validator. With a valid
portal session, date, request ID and current revision, the route wrote notes,
incremented the closeout revision and persisted a save receipt. The mutation
could not reject the malformed intent because it only received `save`.

Reproduce with an open closeout at revision 0 and an authorized enrollment
session: PATCH `/api/shift-closeout` with
`{"date":"2026-09-10","request_id":"unique-request","expected_revision":0,"action":null,"notes":"Must not be saved"}`.
Before the fix this returns 200 and saves the notes at revision 1. After the
fix it returns 400 (`action must be save, complete, or reopen`) without a write.
The production caller is `sendCloseoutAction` in `src/app/closeout/page.tsx`;
its normal requests already supply valid actions. This is an API boundary
failure, not a claim that the normal UI generates malformed actions.

Only an omitted action now defaults to save. Explicit strings retain trimming
and the existing action allowlist. The regression invokes the actual Next route
and real Convex mutation through convex-test, with only session and transport
adapters mocked. Nine invalid actions must leave the entire closeout, receipts,
history and audit unchanged; an omitted action must still save. No Convex, UI,
kiosk, schema, migration or deployment file changes are involved.

Duplicate check: read the card's open/merged JSON snapshots, current open PR
files, docs/reviews and git history before choosing this finding. No changed
file appears in the open-PR exclusion set. Merged #230 fixes malformed exception
review statuses in a different endpoint; it does not fix closeout actions.
Open #252 changes closeout UI refresh drafts only. The forbidden worker
restoration feature is outside this change.

Proof commands and full logs are retained outside the checkout under
`/home/noah/t3-ui-proof/pQIuEFpq/evidence/closeout-malformed-action/`.
`checks.py` runs the same route regression against the original base product
code, restores the fixed route in a finally block, then runs the candidate and
broader checks, all under `/home/noah/.cache/t3-recovery-heavy.lock`.
The initial shared-tree baseline used Vitest 4.1.10; final proof uses the pinned
lockfile dependencies installed locally with npm ci. Shared node_modules were
never modified.

The verify-gatekeeper package supports Activity Log Add missing punch, not
closeout actions. Its local stack can provide general application/role/persistence
coverage; it cannot substitute for the closeout route regression. Real Command
Center, production Convex/Render, kiosk hardware/ingest, face service and alert
delivery remain uncovered. No UI change or screenshot evidence is required.
Check results and owned-stack evidence are recorded in the draft PR.
