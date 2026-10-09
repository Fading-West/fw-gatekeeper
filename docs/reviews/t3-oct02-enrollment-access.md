# Stop enrollment capture when access is lost

Rank3 of the next twenty; impact is an engineering privacy estimate, not measured usage. Existing94–108 are excluded from this count.

An enrollment operator whose role changes can leave a camera stream and capture timer active behind review-only UI. The change stops collection when current access is absent, invalidates late camera grants, clears captured frames and consent, aborts processing requests, and prevents old responses from appearing after regrant. Authorized access must start a new employee/camera/consent flow. Server role checks remain authoritative; aborting a request cannot undo a transaction already committed before access loss.

Scope: enrollment page lifecycle and behavioral tests. Dependency: preserve96 fresh-consent behavior when composing; original API role enforcement remains. No owner policy decision needed.

Acceptance: downgrade or membership disappearance during opening, preview, capture or processing must stop tracks/timers; late grants are released; stale callbacks cannot submit; late responses do not restore results. Regrant requires a fresh flow. Synthetic component regressions cover each stage. Normal admin/enrollment/viewer app acceptance, full exact final tests/types/lint/build and matching CI are PENDING runtime admission behind FWCRM then UnitFlow. No runtime test or readiness pass is claimed by this source commit. Physical/deployed backend and production release acceptance remain pending.

Branch: fix/t3-oct02-enrollment-access; initialbase0ab3795986cb0bad446a644f7b91394a83f2cff8. PR and final tested source/build/launch identities will be recorded after exact checks. Original source/evidence preserved; no real biometric data used.
