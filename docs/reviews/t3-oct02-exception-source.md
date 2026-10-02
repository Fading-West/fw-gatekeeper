# Bind exception dispositions to their current source

The exception-review mutation previously accepted fabricated or mismatched source keys, dates and types. It now checks the actual derived exception inside the review transaction and rejects an obsolete source with HTTP 409. The normal Exceptions page refreshes the queue without reporting a successful disposition or discarding the operator's note draft. Impossible calendar dates are rejected at both API and Convex boundaries.

Historical dispositions and immutable audit records remain preserved. If their underlying issue disappears, operators cannot reopen or edit that vanished issue through this mutation; they review current source evidence instead. This establishes source validity without inventing historical roster/schedule policy.

Initial dependency base: `fix/oct02-recognition-review-audit`, exact PR108 head `d439aa2`. Complete PR108 audit, actor and rollback behavior remains in the branch. The legacy-key regression now seeds an actual historical stored record, rather than creating an invalid current review. The audit rollback regression seeds a real recognition attempt so it still reaches and verifies the audit-write failure.

Regression sources: `convex/t3-exception-source.test.ts`, route and normal-page conflict tests, and existing PR108 audit suites. All tests/types/lint/build/real-app gates remain **pending** serialized admission; source-only implementation is not ready for review. Synthetic fixtures only. No deployed backend or production acceptance is claimed.

Acceptance follow-up covers repeated legitimate dispositions on the same still-current source, transitions through ignored/resolved/open, one durable review row and an immutable actor-attributed audit for every accepted call. A later vanished-source retry leaves both the last disposition and every earlier audit unchanged. This adds source acceptance coverage without changing existing request/revision semantics. Execution remains pending.
