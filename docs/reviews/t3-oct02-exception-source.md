# Bind exception dispositions to their current source

The exception-review mutation previously accepted fabricated or mismatched source keys, dates and types. It now checks the actual derived exception inside the review transaction and rejects an obsolete source with HTTP 409. The normal Exceptions page refreshes the queue without reporting a successful disposition or discarding the operator's note draft. Impossible calendar dates are rejected at both API and Convex boundaries.

Historical dispositions and immutable audit records remain preserved. If their underlying issue disappears, operators cannot reopen or edit that vanished issue through this mutation; they review current source evidence instead. This establishes source validity without inventing historical roster/schedule policy.

Initial dependency base: `fix/oct02-recognition-review-audit`, exact PR108 head `d439aa2`. Complete PR108 audit, actor and rollback behavior remains in the branch. The legacy-key regression now seeds an actual historical stored record, rather than creating an invalid current review. The audit rollback regression seeds a real recognition attempt so it still reaches and verifies the audit-write failure.

Regression sources: `convex/t3-exception-source.test.ts`, route and normal-page conflict tests, and existing PR108 audit suites. Synthetic fixtures only. No deployed backend or production acceptance is claimed.

Acceptance follow-up covers repeated legitimate dispositions on the same still-current source, transitions through ignored/resolved/open, one durable review row and an immutable actor-attributed audit for every accepted call. A later vanished-source retry leaves both the last disposition and every earlier audit unchanged. This adds source acceptance coverage without changing existing request/revision semantics.

## Merge-readiness review

The updated PR108 parent and current master are included, preserving the complete actor audit and kiosk review-authority/replay protections. Merge conflict resolution keeps both prior/new audit attribution and source fingerprints; the parent attribution regression now seeds a real source and submits its fingerprint.

Source fingerprints use a 74-character `v1:sha256:` digest of the unchanged canonical v1 evidence fields. Previously, 500 scans produced 86,539-byte fingerprints repeated across the queue (43,269,500 bytes for 500 exceptions). Fingerprints are computed once per worker/type instead of serializing and hashing the same day for every scan exception. Regression tests cover bounded queue and stored review size, canonical enumeration order, independent SHA-256 verification, and changed-evidence rejection. `@oslojs/crypto` 1.0.1, already used by Convex Auth, is declared directly for the synchronous Convex-compatible digest.

Schema change: `exceptionReviews.sourceFingerprint` is optional to preserve compatibility with existing stored rows; no table or index changes. Existing reviews without matching evidence attribution remain stored and audited but do not suppress current issues, as specified by this PR. Other open correction-source PRs sharing `exceptionSourceFingerprint.ts` must preserve the digest representation when composing their branches. No deployment or physical acceptance is claimed.

Local validation on Node 24.21.0 and Python 3.11.17: 589 Vitest tests (92 files), 21 Python test files, 18 contract files, both TypeScript projects, lint, production build and production dependency audit passed. An initial shared-machine run timed out in an unrelated password-reset test; the complete suite passed with two workers and a 15-second local test timeout. Repository test configuration remains unchanged, and published-head CI uses its normal settings. Authenticated browser, physical-device and deployed-runtime acceptance remain pending.
