# Biometric Data Retention Policy

FW Gatekeeper recognizes workers at the factory door using a facial template. This page states exactly what biometric data the system stores, where it lives, how consent is captured, how long it is kept, and how to delete it.

## What is stored

For each enrolled worker:

| Data | Description |
| --- | --- |
| Facial template | A 512-dimension floating-point vector (MobileFaceNet embedding) derived from the enrollment photos. This is the only thing the kiosk matches against. Treat the template as sensitive biometric data. |
| Enrollment photos | Up to 6 JPEG frames captured during enrollment. Used to (re)generate the template and to show a thumbnail on the kiosk. |
| Identity metadata | Name, employee ID, department, enrollment timestamp, consent timestamp. |

Attendance events (clock in/out, kiosk ID, timestamp, match confidence) reference the worker by ID but do not contain biometric data.

## Where it is stored

- **Convex database** (`workers` table): the template (`faceEncoding`), the identity metadata, `consentAt`, and references to the photos (`photoStorageIds`).
- **Convex file storage**: the JPEG enrollment photos.
- **Each kiosk's local SQLite database** (`pi-kiosk`): a cached copy of the template, name, and one photo so the door keeps working offline. Kiosks refresh this cache from the server on every sync cycle (about 30 seconds when online).

The dashboard HTTP worker responses expose readiness metadata (`has_face_encoding`, `encoding_status`). Authenticated admin and enrollment roles can also access templates through the protected Convex worker queries; viewer roles cannot.

## How consent is captured

Before photo capture can start, the enrolling operator must confirm a required checkbox stating that the worker has been told a facial template will be stored for attendance and has agreed. The enrollment API rejects requests without this acknowledgement (HTTP 400). The Convex mutations also require consent confirmation for every template or photo write. The server records its receipt time as `consentAt`, the authenticated operator as `consentRecordedBy`, and an immutable audit row on every enrollment; it does not trust a client-supplied time as the receipt time. Re-enrollment deletes superseded cloud photos.

## How long it is kept

- Deactivation stops recognition after kiosks sync, but keeps cloud biometric data until an admin explicitly purges it.
- It is **purged on request or on termination** using the admin "Purge face data" action (below). Enrolled worker data has no automatic time-based expiry; purge is an explicit, audited action. Incomplete uploads have a separate cleanup policy below.
- Online kiosks remove cached templates on their next successful sync after deactivation. Offline devices retain cached data until connectivity returns. Existing kiosk versions may retain thumbnail files on disk; operators must remove those cached files during device cleanup and verify each device separately.
- Attendance history (non-biometric) is retained for operational and payroll reconciliation and is not deleted by a purge.

## Incomplete enrollment uploads

The enrollment API stores each accepted photo through an authenticated Convex action. Before returning its storage ID, the action records an owner-bound pending receipt and schedules cleanup after **one hour**. A successful worker save consumes those receipts in the same transaction that attaches the photos. Immediate cleanup after the request deletes only uploads still pending for that operator; it cannot delete attached photos even when the save committed but its response was lost.

An abandoned request, lost upload response, or failed immediate cleanup leaves pending photos eligible for scheduled deletion after the one-hour grace period. Expired or already-deleted photos cannot be attached by a late save. This expiry applies only to incomplete uploads, not enrolled workers' retained photos. Scheduled execution can run later than its target time during outages.

This protects new uploads through the enrollment API. It does not identify or retroactively purge pre-existing orphan files, or track legacy uploads made directly through `workers.generateUploadUrl`. File storage and database registration are separate operations: a hard process termination between storing a file and registering its receipt can still leave an unidentified orphan. Ordinary registration failures trigger immediate deletion; failed deletion is logged for operator investigation.

### Deployment order

Deploy the `pendingEnrollmentPhotos` schema, `enrollmentPhotos` action/mutations, and updated worker mutations to Convex before deploying the portal enrollment route that calls them. Keep the portal's automatic Render deployment skipped until the backend deployment is verified. Existing worker photo references remain compatible; cleanup never deletes untracked storage IDs.

## How to purge a worker's face data

1. Sign in with an **admin** account and open **Workers**.
2. Find the worker and click **Purge face data**. If already deactivated, enable **Show inactive workers** first.
3. Enter a reason (for example, "Terminated 2026-09-01" or "Worker requested deletion"). The reason is required.
4. Confirm. The system then, in one transaction:
   - deletes every enrollment photo from Convex file storage,
   - removes the template and photo references from the worker record,
   - marks the worker inactive and sets `biometricsPurgedAt`,
   - writes an `auditLog` row recording who purged, which worker, when, and why.
5. Wait for each online kiosk to complete a successful sync. Offline kiosks remove the cached template on their next successful sync; check and clean legacy thumbnail files separately. Check the Kiosks page to confirm every kiosk has synced since the purge time.

Purging is irreversible. If the person later returns to work, enroll them again from scratch (new consent, new photos, new template).

Deactivating a worker without purging keeps the template and photos in Convex (the kiosks still drop it). Use Purge when the biometric data itself must be deleted.

## Who to contact

Questions or deletion requests: contact the Fading West system administrator responsible for FW Gatekeeper (the admin account owner listed on the Accounts page). Deletion requests from workers should be actioned through the purge steps above and the audit row retained as evidence.
