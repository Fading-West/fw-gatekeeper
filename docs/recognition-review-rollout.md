# Recognition review version rollout

Recognition Lab reads now include an opaque `review_version`. Confirm and Reopen
must echo the displayed version. The Convex mutation compares it before changing
the review or writing its audit entry; a stale or missing version is rejected.
The portal returns HTTP 409 for this conflict, reloads the current attempts, and
leaves the operator to review the newer decision before trying again.

## Merge and release order

Keep the existing coordinated-release procedure in
[legacy-kiosk-rollout.md](legacy-kiosk-rollout.md#coordinated-production-release).
Use `[skip render]` in the eventual merge commit message to defer Render deployment
until the backend and portal can be released together. `render.yaml` declares
`autoDeployTrigger: checksPass`; GitHub CI builds and tests the app but does not
deploy its Convex functions. The repository configuration does not establish the
current settings of existing Render services.

1. From the approved final source revision, deploy the Convex schema and functions
   to the intended deployment using the existing release procedure. The optional
   `recognitionAttempts.reviewRevision` field treats legacy records as revision
   zero. No backfill, credential change, or data migration is required.
2. Deploy the matching portal only after the backend deploy succeeds. A new portal
   against an old backend can return HTTP 500 because the backend does not accept
   `expectedReviewVersion`. Do not deploy in that order.
3. Reload existing Recognition Lab tabs after the portal deploy. Old browser code
   does not submit a version; it cannot save reviews against the new backend.
   Depending on which portal version handles the request, a missing version is
   rejected as a conflict or a generic error. Reloading an old tab before the
   portal update is complete does not fix that mismatch. Expect a temporary review
   interruption while the backend and portal versions differ.

This is an intentional fail-closed transition: no compatibility fallback may
apply a review without checking the version. Attendance ingestion, recognition
capture, and kiosk software do not need to change for this protocol.

## Acceptance after deployment

Using existing authorized test accounts and synthetic attempts in an isolated
environment, open the same attempt as two operators. Save a correction and note
from the second view, then Confirm or Reopen from the older view. Verify HTTP 409,
the unchanged newer review and audit history, and a refreshed Lab display. Review
the new decision and retry deliberately; verify one successful update and audit
entry. Confirm that viewers cannot write and that an old tab with no version is
rejected until it reloads the matching portal.

These are release acceptance steps, not claims that a deployed Convex backend,
real authenticated browser, or production service was tested during PR
preparation. Automated route, mutation, and component tests use isolated records
and controlled service boundaries.

## Scope and rollback

The version covers the Recognition Lab review record. The separate Exceptions
disposition protocol does not advance this version, so this change does not claim
to prevent an older Lab action from superseding a newer Exceptions disposition.

If deployment fails, keep review writes unavailable until the matching backend
and portal are restored. Do not remove the version check to restore old-client
writes. A rollback to the previous complete protocol also restores the stale-write
defect; retained review records and audit entries must be preserved. The optional
revision field can remain stored during a rollback.
