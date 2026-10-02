# Bind acknowledgement to reviewed closeout blockers

Previously, an acknowledged closeout draft could acquire new blockers and still inherit the old boolean. The server now compares canonical evidence containing source identities, attendance/schedule facts and kiosk fault conditions. Same-count replacements cannot reuse acknowledgement. Routine heartbeat timestamps and operator names/notes are excluded. This comparison token contains no secrets and is a canonical serialized value, not an authentication credential or a cryptographic hash.

The Closeout page sends the loaded evidence when the supervisor acknowledges. Conflicting commits return HTTP 409, refresh current evidence, clear acknowledgement and retain note/supervisor drafts. Saved legacy acknowledgements without evidence require explicit reconfirmation. Reopen still preserves the signed history and resets acknowledgement.

Optional schema field `acknowledgedBlockerEvidence` supports existing rows and signed history. Deploy compatible backend functions before the updated portal; older clients cannot newly acknowledge unresolved blockers without the evidence token. Base: master `0ab3795986cb0bad446a644f7b91394a83f2cff8`.

Regression sources exercise replacement blockers, new recognition evidence, legacy state and unchanged retries, plus API/page recovery. Tests/types/lint/build/runtime and independent exact revision QA remain **pending** serialized admission. No readiness or production/hardware acceptance is claimed.

Source follow-up: evidence version 2 binds late-arrival, missing-clock-out and scan-sequence blockers to their contributing effective event IDs, including synthetic correction IDs. Same timestamp/count replacements now require fresh acknowledgement. A conflict refresh that discovers another supervisor's completed record displays its signed name/notes; the rejected draft remains a separate alert and cannot replace the signed display or export. Added regression fixtures cover raw/correction replacement and this completed-refresh race. Their execution remains pending.
