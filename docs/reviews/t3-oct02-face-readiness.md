# Show usable face service enrollment readiness

Rank18 of the next twenty; estimated high operator reliability impact. Cached model existence alone used to show green while a corrupt native model or missing service authentication makes enrollment fail.

Scope: initialize the existing pinned recognition session once in a daemon startup task, track loading/failure/usable state, and return explicit authentication readiness without secrets. Health reads remain cheap and side effect free: no downloads or session initialization per health call. Authenticated enrollment can retry a failed load; failure logs contain no native exception string or complete configuration. Portal requires strict model/auth readiness plus its own configured service key; unknown legacy readiness stays degraded. Existing pinned model, native image and authentication controls remain.

Acceptance: cached-file presence cannot assert ready; missing auth stays degraded; loading health does not wait on native session lock; failed model initialization and later authenticated retry expose honest state; portal rejects malformed fields and old responses conservatively. Synthetic Python state/session adapters and Next route regression code authored. Full exact-source tests/types/lint/build and native image CI, plus isolated normal enrollment app flow, remain PENDING explicit runtime admission behind FWCRM and UnitFlow. No readiness pass claimed. Actual deployed backend/model and physical accuracy remain pending.

Branch fix/t3-oct02-face-readiness; initialbase0ab3795986cb0bad446a644f7b91394a83f2cff8; future PR/commit and source/build/launch mapping retained in delivery ledger. No secret-bearing configs, real photos, production calls or service settings changed.
