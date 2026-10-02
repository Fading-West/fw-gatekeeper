# Recover disconnected kiosk capture devices

Capture failure previously retried the same failed handle indefinitely. Camera now releases failed devices, retries reopen after bounded backoff, and cleans partial Pi initialization before USB fallback. Requested backend mode remains explicit across recovery. The kiosk clears its frame and reports reconnection while unavailable; the UI hides the old image on camera-health failure.

Master-based; no existing base changed. Compose with PR100 camera evidence interruption/expiry: its evidence invalidation remains required and unchanged. This improvement restores device acquisition, rather than recounting stale-result fixes.

Regression code: test_t3_camera_recovery.py executes the production Camera class with synthetic USB/Pi adapters, covering failure/reopen/backoff/partial initialization and cleanup. No real camera/model/data used.

Validation is source-only with git diff --check. No tests/runtime/builds performed pending serialized resource admission. Exact-head checks and normal kiosk fault/recovery app acceptance required before PR readiness. Physical camera reconnect, deployed backend and release remain pending.
