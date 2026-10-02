# Keep local attendance controls available during model startup

Startup previously downloaded/loaded recognition before starting the local web UI. An offline/missing model could delay manual fallback for the network timeout. The local UI now starts first; one background worker initializes recognition and retries with backoff. Detection cannot race or duplicate cold model loads, and automatic scanning stays blocked with an honest supervisor fallback until readiness is published. Camera display and durable sync continue while recognition is unavailable.

Scope: master-based startup ordering and initial model recovery. Compose with PR100 fresh-evidence invalidation, camera-recovery and sync-isolation without removing their behavior. This does not change model pinning, recognition thresholds or liveness policy. No stack dependency/base change required.

Regression code: test_t3_startup_fallback.py covers blocked initialization, one in-flight load, failed/recovered loads, cancellation and production startup ordering executed with synthetic IO adapters. No physical camera/model/data used.

Validation status: source-only; git diff --check. No tests/runtime/builds performed pending explicit serialized host admission. Exact checks and normal kiosk supervisor fallback/recovery acceptance remain required before PR readiness. Physical device, deployed backend and production release remain pending.
