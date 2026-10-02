# Enforce supervisor lock on the kiosk server

Locking previously cleared one browser cookie while copies remained authorized until expiry. Session issuance now has unique random identity and an in-process registry; lock revokes that session, including copies, while independent supervisor sessions remain usable. Restart requires a fresh unlock, so revoked tokens cannot revive. TTL, PIN/UI-key signing and existing attempt limits remain enforced. The UI hides controls immediately and offers a retry if server locking cannot be confirmed.

Scope: master-based supervisor-session lifecycle only. Compose with PR98 history authorization and rank1 manual-operation durability without altering their behavior.

Regression code: test_t3_supervisor_lock.py covers copied-client replay, repeated lock, unique same-second sessions, expiry, pruning, key rotation and simulated process restart. test-t3-supervisor-lock.mjs exercises the actual UI lock function under recoverable failure.

Validation status: source-only. No tests/runtime/builds run pending explicit serialized host admission behind FWCRM and UnitFlow. Exact-head checks and supervisor role-transition app acceptance required before PR readiness. Physical device/deployed backend/production release acceptance pending. A first documentation write failed because branch switching removed the previous branch's docs/reviews directory; the directory was created and the write completed without changing earlier source/evidence.
