# Enrollment identity revision rollout

Existing-worker enrollment and worker metadata edits carry the identity revision
read before capture or editing. The worker mutation checks that revision before
changing biometric data, photos, identity, or the audit trail. Missing or stale
revisions fail closed; a stale draft is retained for explicit review and reload.
The revision fingerprints normalized name, employee ID, and department. It is not
a general worker version and does not claim to detect a change away and back to
the same normalized identity.

## Release order

Follow [the coordinated release procedure](legacy-kiosk-rollout.md#coordinated-production-release),
including `[skip render]` on the eventual merge while deployment is deferred.
Deploy the matching Convex functions before the portal. There is no schema change
or data migration for the identity fingerprint. Old browser tabs cannot submit
an existing-worker enrollment or metadata edit without its captured revision;
reload them after the matching portal is live. A new portal against an old
backend may remain blocked or return an error because the old functions do not
support the revision protocol. Expect temporary editing/enrollment interruption
while the versions differ, rather than weakening the guard.

## Acceptance

Use an isolated environment and existing authorized admin/enrollment accounts.
Open a worker for editing or re-enrollment, then change that worker's identity in
a second admin view. The old view must receive a recoverable conflict and must
not overwrite identity, photos, biometric encoding, or audit history. Explicitly
load the current identity, reconfirm consent, capture fresh photos, and retry.
Verify that enrollment-role users cannot change identity metadata, viewers
cannot write, and cancel, role loss, or navigating to another worker prevents
late responses from repopulating the old editor.

Automated mutation, route, and rendered component tests use synthetic records
and controlled services. They do not establish deployed Convex concurrency,
real authenticated-browser acceptance, or physical-camera recognition quality.
Existing photo ownership, consent freshness, inactive-worker, purge, and deletion
rules continue to apply.

## Complete photo publication follow-up

The dependent photo-publication change (#130) requires every accepted photo to
upload successfully before worker publication. An upload or registration failure
aborts enrollment. Cleanup removes only still-pending, operator-owned uploads;
a lost successful publication response must not delete committed or shared
photos. Deploy it with its prepared identity-revision dependency and verify the
failed-upload, lost-response, and owned-cleanup paths before release.
