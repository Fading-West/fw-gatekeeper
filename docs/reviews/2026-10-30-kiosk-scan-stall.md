# Kiosk scan stall proof — Trello yXfnpLgw

Observed baseline: `origin/master` / branch HEAD was
`382a6145131b675b059ef9009919ed823617a4f8` before implementation (see PR for
the reviewed implementation head and complete check/review ledger).

The new `pi-kiosk/test_scan_progress.py` was run before production edits.
The shared-health test failed because stale camera progress returned
`clock_unsynchronized` instead of `clock_unsynchronized,camera_stalled`.
Threshold override checks also failed; the pure helper did not yet exist.
After implementation all six tests passed, including unchanged stored flags,
derived camera/recognition stalls, mixed reasons, endpoint/wire health,
recovery, startup guards, exact boundaries, and invalid config fallback.

`test_update_health.py` executes the real main/detection loops with synthetic
frames and a stubbed native detector. Event-blocked capture and face detection
each became degraded after the 0.3-second test threshold, then recovered when
released. An empty door kept progressing past the same threshold. Existing
update-trial inference checks remain in that suite; release code is unchanged.

The actual Flask app was run locally with a temporary SQLite database and
synthetic health state, then exercised through headless Chromium. Observed:
the stalled warning replaced idle text, the camera stream disconnected, a
fresh manual confirmation appeared, and the warning returned after its hold.
Screenshots: [stalled door](evidence/kiosk-scan-stall/stalled-door.png) and
[manual confirmation](evidence/kiosk-scan-stall/manual-confirmation.png).

No physical Pi, camera driver, real attendance scan, server heartbeat, alert
cron, email delivery, Render rollout, or kiosk rollout was exercised. Pilot
acceptance remains necessary, including threshold tuning on slow hardware.
This change reports stalls and clears on progress; it does not restart them.
