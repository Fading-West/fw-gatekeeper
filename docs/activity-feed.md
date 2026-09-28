# Command Center activity feed

FW Gateway exposes the version-1 operational activity contract at `GET /api/activity` on the dashboard origin. The endpoint is read-only, sends `Cache-Control: no-store`, and accepts only `Authorization: Bearer <token>`. It returns no more than 100 events and 256,000 bytes from the last 30 days, setting `hasMore` if either limit truncates the window. Actor and action text are capped at 160 JavaScript UTF-16 code units and subject text at 240 without splitting surrogate pairs; immutable IDs and original timestamps are not changed. The response `asOf` records the live Convex query time and is returned only when that query succeeds; backend failures are non-2xx and are never represented as a successful empty feed.

## Source configuration

The directory configures `ACTIVITY_FW_GATEWAY_PATH=/api/activity` and an `ACTIVITY_FW_GATEWAY_TOKEN` of at least 32 random characters. Set the same token on the **Convex deployment only**:

```sh
npx convex env set ACTIVITY_FW_GATEWAY_TOKEN '<secret-manager-value>'
npx convex env set ACTIVITY_FW_GATEWAY_ACCOUNT_ID '<existing-convex-user-id>'
```

`ACTIVITY_FW_GATEWAY_ACCOUNT_ID` binds the activity credential to an existing Gateway source account. That account must have an active `portalMembers` row with the `admin` role. Existence, active status, and role are re-read on every request at the Convex database boundary. Removing the token, rotating it, disabling the account, or demoting it revokes access. If either variable or the mapping is absent, the integration stays disabled.

The Next.js service uses its existing `CONVEX_INGEST_URL` (or derives the `.convex.site` origin from `NEXT_PUBLIC_CONVEX_URL`) to reach the protected Convex HTTP action. Do not use a Convex deployment key, kiosk/ingest key, health token, browser cookie, or portal password for the activity token. Do not add either activity variable to `NEXT_PUBLIC_*` or commit its value.

## Coverage and exclusions

The allowlist includes only audit rows whose target is `workers` and whose action is:

- `workers.updateIdentity` → `updated worker record`
- `workers.remove` → `deactivated worker`

Each allowlisted action is selected through the compound `(targetTable, action, createdAt)` index with a fixed scan ceiling. Excluded actions do not consume that ceiling. If malformed rows exhaust a bounded allowlisted scan before the source can prove whether another eligible event exists, the endpoint fails closed with a non-2xx response instead of guessing `hasMore`.

These mutations append their audit row transactionally after the operational change, so the outcome is `succeeded`. Immutable audit document IDs and original audit timestamps are preserved. Actor names (falling back to the source-recorded account email) come from the recorded `actorUserId`. Worker names are resolved only after the mapped account passes the current admin authorization check. Links point to the protected `/workers` source page, which enforces normal portal login and role authorization.

Enrollment/re-enrollment and `workers.purgeBiometrics` are omitted because those audit types represent biometric/privacy workflows and cannot be safely described as general operations. The response never contains biometric templates, face images, consent data, attendance data, HR identity changes, employee IDs, departments, purge reasons, audit details, credentials, or raw metadata. Gateway's `auditLog` does not cover every portal, visitor, attendance, recognition, kiosk, schedule, exception, or closeout action, so this feed intentionally makes no claim to cover them.

## Synthetic contract example (test data only)

This is illustrative test data, not a real Gateway action:

```json
{
  "version": 1,
  "asOf": "2026-09-14T18:00:00.000Z",
  "hasMore": false,
  "items": [{
    "id": "synthetic-audit-id",
    "occurredAt": "2026-09-14T17:00:00.000Z",
    "actor": "Sample Operator",
    "action": "deactivated worker",
    "subject": "Sample Worker",
    "outcome": "succeeded",
    "url": "/workers"
  }]
}
```
