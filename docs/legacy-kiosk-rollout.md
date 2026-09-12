# Cloud release while kiosks remain on older software

Deploy the Convex schema and functions before the web API. Deploy the face service before the portal because new enrollment requires its accepted-photo metadata. Existing kiosk installations do not have to update at the same time.

## Attendance backlog compatibility

Older kiosks send their entire unsynced attendance queue and mark every submitted row synced on HTTP 200. The portal therefore validates the complete request before writing, divides large uploads into transactions of at most 500 events, and returns success only when every event is acknowledged. A failed transaction or incomplete upload returns a retryable error, leaving the old kiosk's queue intact.

Large uploads save an atomic receipt for each completed chunk in Convex. A receipt contains the SHA-256 digest of normalized event data and the acknowledged count, not the event contents. On retry the portal checks these receipts and skips completed chunks. This permits progress across the older kiosk's 15-second request timeout. Chunk writes are atomic; the entire large request is not one transaction. Event-level idempotency prevents duplicate rows when a partial final chunk grows as new scans join the queue.

Normal uploads of 500 events or fewer retain the existing direct transaction path. The updated kiosk uses batches of 100 and can be installed later. Malformed events and conflicting retry keys still require correction; retrying cannot repair invalid evidence.

## Deferred device work

Merging kiosk source does not install it on physical boxes. Until installation, devices retain their existing worker-identity handling, recognition smoothing, local photo cleanup, queue pagination, and liveness behavior. Pilot the update on one supported Raspberry Pi OS Bookworm 64-bit / Python 3.11 box before fleet rollout, including camera capture, offline/reconnect attendance, same-name workers, and configured liveness policy.

Recognition embedding dimensions and preprocessing remain compatible in source. Actual cached model hashes and installed software on the boxes must be checked during that pilot.

## Coordinated production release

Use `[skip render]` in merge commit messages to defer Render auto-deploy during this stack. After all approved changes are merged and checks pass, deploy Convex, manually deploy the face service and verify `/health`, then deploy the portal and verify `/api/health`. Confirm the deployed commit matches the final main-branch commit. Do not apply the entire Blueprint to existing services merely to deploy code; their current plans and configuration may differ.

Alert checks can run without notification delivery configured. Set up recipients and a provider separately when notification delivery is desired.
