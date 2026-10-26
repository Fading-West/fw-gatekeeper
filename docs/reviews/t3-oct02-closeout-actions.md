# Closeout action receipts and concurrent draft protection

A delayed completion retry could re-sign a deliberately reopened record, and an old draft could replace another supervisor's newer notes. Each closeout action now requires a stable request ID and expected revision. Transactional, actor-scoped receipts replay the original outcome without touching newer state. A changed request payload or stale revision returns HTTP 409. Authorization precedes receipt lookup, including after a role is revoked.

The normal Closeout page stores the complete immutable action under its authenticated actor and date: request ID, original revision, action, supervisor, notes, acknowledgement and blocker evidence. Reload restores that action separately from the current server record. Retry sends precisely those original details, even after another supervisor changes notes or reopens. A second action cannot replace an uncertain action. A known 409 rejection is stored and requires explicit review of the current record before a new action. Completed records display signed notes/name; a rejected draft remains separate. Receipt and closeout/history updates share the mutation transaction. Legacy closeouts without revision are revision zero; new rows use an explicit null expected revision. The schema additions are optional or new tables, and require no destructive migration.

Acknowledgement requires a typed result with the original request ID, authenticated actor, expected transition status and valid revision. Missing, malformed or mismatched 2xx data retain the pending action; the API also rejects malformed backend acknowledgements. Receipt replay reports the original result, then refreshes the actual current state without announcing it has been re-signed. Role changes retain the stored intent but disable retry until write authority returns. Other accounts and dates cannot inherit it. Recovery storage is confined to the same browser tab; if disabled the page warns to remain open, and only current-page recovery is available. No cross-tab/browser restart durability is claimed.

Initial dependency base: `fix/t3-oct02-blocker-ack`, exact commit `7d11cf228e77dd25cb1867b3cdfd60f096605f64`. This PR counts only action receipts/revisions and their normal API/UI recovery; blocker acknowledgement remains the separate preceding milestone. Deploy backend schema/functions before the portal; old clients cannot mutate through the revised boundary without action identity.

Original incomplete draft identity is preserved at WIP checkpoint `20d8d5d` (not a ready milestone). Composition merge `29a4eac` adds rank 6 source follow-up `5435cd7` and resolves the overlapping signed-display draft without deleting its intent. The final focused follow-up adds full intent restoration/receipt validation and regression fixtures. When composing, count rank 6 separately and exclude its inherited changes from the rank 8 action scope. Other protected PR108 audit/PR101 correction-reversal paths are unchanged by this branch.

Regression sources cover delayed completion after reopen, conflicting note drafts, repeated reopen, revoked receipt authority, legacy rows, route validation and normal-page lost-response/conflict handling. All tests/types/lint/build/runtime and independent exact-head review are **pending** explicit serialized host admission. Source-only status; no readiness, production or physical-device acceptance claimed.

Independent source review follow-up moves the recovery panel outside the summary-row map and renders it once. Blank acknowledgement notes are rejected before preserving a new client intent. Server note/new-blocker rejections use structured HTTP 409 conflicts, preserve no record/receipt, refresh evidence and allow deliberate reconciliation into a new intent. Untyped 500 or lost responses still preserve the original request and cannot silently become new actions. Added normal-flow fixtures cover blank-note preflight, new-blocker race/reconcile/completion, and original exact retry after untyped 500. Execution remains pending serialized QA.

Serialized source-contract correction: the old completion-message assertion now checks the actual guarded completion rejection, its typed changed-evidence/acknowledgement conflict codes, the required refresh-and-note instructions, and the route's HTTP 409 mapping. Production error behavior and existing acknowledgement semantics remain unchanged; unknown 500 responses still retain the immutable action. Original failed 49181a5750b7933d962dd888c51d4bb287a509a4 evidence remains at runtime/evidence/rank8-49181a5750b7/test.log. Source correction and diff check only; root serialized exact-head rerun remains pending.

Serialized nullable-ownership correction: pending-action selection now first requires an actual action before checking its actor/date. When actor identity is initially undefined and no receipt exists, optional actor comparison previously matched two undefined values and reached a null action's date. The explicit presence guard restores the intended empty selection and narrows its type without a suppression. A normal loading-to-known-actor component regression checks that the empty page renders, no saved receipt appears, and completion stays disabled until actor ownership is known. Failed e186328d912401bbb74d0f1807b551e2001e5420 typecheck evidence is retained at runtime/evidence/rank8-e186328d9124/typecheck.log. New source fixture only; root serialized rerun remains pending.

October 8 review update: merged the updated #119 parent including current master, keeping API field validation and explicit clears. A rejected action restored after reload now preserves its supervisor/name draft during deliberate reconciliation: editable records recover the draft with acknowledgement reset, and completed records keep the draft separate from signed values. Confirmed actions stay cleared in memory if tab storage removal fails. Regression fixtures fail before these fixes and pass afterward; inherited master/parent fixtures now use request identities and expected revisions. No additional schema changes were needed.

## Current integration and release

The dependency in #119 is now merged. This branch integrates `master` at
`893d47596a627fdc85a976d5a73d152f7ae06f90`; the action-receipt change can be
reviewed against `master` directly. Existing overnight, DST, inactive-worker,
early-closeout, error-privacy and date-selection regressions now supply the
required action identity and authenticated actor rather than bypassing those
guards. Their assertions are retained.

Follow [the coordinated release procedure](../legacy-kiosk-rollout.md#coordinated-production-release),
including `[skip render]` on the eventual merge commit when deployment is deferred.
Deploy the schema/functions before the matching portal. An old page cannot write
without a request ID and revision; a new portal against an older backend also
cannot complete the protocol. Expect a temporary write interruption and reload
existing Closeout tabs after both versions match. Do not remove the identity or
revision checks to restore old-client writes. Preserve stored action receipts,
closeouts and history during recovery or rollback.

Automated checks use isolated records and controlled service boundaries. They do
not establish deployed Convex/OCC behavior, real authenticated-browser acceptance,
or physical kiosk offline/reconnect behavior. The branch includes #249 as its prerequisite and preserves its signed-attendance
baseline, comparison and shared-read transaction bounds. The action-receipt diff
is reviewed against #249; queue evidence remains the separate #224 layer.
A receipt replay returns before baseline capture, and only a new, successful
completion captures a new signed-attendance baseline.
