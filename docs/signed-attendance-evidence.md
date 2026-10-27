# Attendance changes after signoff

A new closeout completion stores a server-derived v1 SHA-256 attendance digest
with the signed snapshot and transition history. Reading a completed date compares
that baseline to current persisted attendance; it never changes the signature,
status, timestamps, or history. Use Activity Log to review a warning, then the
existing Reopen → review → Complete flow to sign the current evidence. Repeated
completion requests preserve the original baseline.

## Scope and canonical form

The scope is **attendance evidence for this factory date only**. It excludes
schedule/roster changes, health, recognition, queued uploads that have not arrived,
and adjacent-date pairing rules. The selected date uses the existing
America/Chicago timestamp membership rules, including offset and legacy local
timestamps. Stored timestamp precision and offset spelling are preserved.

v1 hashes JSON containing version, date and ID-sorted arrays of whitelisted fields:

- Raw attendance: ID, workerId, eventType, stored timestamp, kioskId, confidence,
  livenessConfirmed and note.
- All date-owned corrections, including reversed corrections: ID, date, workerId,
  action, eventType, correctedTimestamp, originalAttendanceId, reason,
  supervisorName, actorUserId and createdAt.
- Each such correction's reversal: ID, correctionId, date, workerId, reason,
  actorUserId and createdAt.

Absent optional fields encode as null. Database creation metadata, request IDs,
sync flags, joined labels, source fingerprints, and incidental updatedAt are
excluded. Counts explain volume; the digest establishes equality. A new
correction followed by reversal remains changed even if effective totals return
to their previous values. Only digest/counts are returned, not audit identities
or reasons. No duplicate ledger is stored.

Closeout reads share the conservative timestamp scan (three calendar-date
prefixes, filtered by factory-date membership), the date's correction documents
and their reversals between the briefing, exception and
baseline builders within one transaction (`convex/attendanceReads.ts`), so
capture and comparison re-read none of them. Save/complete/reopen skip the
read-only comparison entirely; only a new completion reads the baseline. Convex's
per-transaction document and index-range limits are exercised with
`transactionLimits` in `convex/signedAttendanceEvidence.capacity.test.ts`,
including 1,000 scheduled workers over five days with 1,900 reversed
corrections arriving after signoff, then reopen and re-sign, and 5,000 unreversed
corrections loaded, reopened and re-signed. Reversals are read with one
`attendanceCorrectionReversals.by_date` range per date range rather than one
lookup per correction (`reverse` copies the correction's date, which never
changes), so correction volume does not consume Convex's 4,096 index-range
limit. The hashed date-owned evidence
is bounded to 8,000 combined rows and 4,000,000 canonical UTF-8 bytes. These caps
bound capture and comparison only; a stored baseline is not invalidated by a
later cap change. Oversized evidence or an ambiguous reversal cannot establish
equality. Comparison failure returns unknown while preserving the signed record;
failure to capture a new baseline aborts completion atomically. A duplicate
reversal still fails the read, as before.

## Compatibility and display

The schema field is optional, including history before/after. Deploy the optional
Convex schema and functions before the portal. No migration or baseline backfill
is provided. Legacy signatures, unknown baseline versions, unavailable or malformed
responses show unknown, never inferred unchanged. Unsigned/reopened dates show
not applicable. An empty day can have a valid signature and compares unchanged
until evidence arrives.

The page and export show signed and current summaries separately, and include the
comparison scope and time. Changed takes precedence over the completed headline;
the recorded completion remains visible. Failed/loading/date-switched requests
cannot show a fresh unchanged result. Viewer users may review the Activity Log;
admin/enrollment users retain the existing Reopen controls.

## Overlapping PRs

Implementation baseline: master `81eb5974c2a08ca9b39447f331903d6ca35ea607`.
At inspection, #132 head was `8842aa739bc2ac6c62602db4878ac8863a19f98c`
and #224 head was `9a0341c275b4cffd4852b931b49265c590bb9cdf`.
Both were open. Preserve #132 receipt-first lookup, expected revisions, and
immutable retries when composing; baseline capture belongs only to a new
successful completion after those checks. Preserve #224 signed/current queue
evidence and mixed-version gate; fleet-wide unknown-date queue observations are
separate from this date-owned persisted attendance digest. This change does not
repair their independent fallback/dependency failures or change queue policy.

## Reproducible focused checks

Use Node 22, install the existing lockfile, and run one Vitest worker:

```sh
npm ci
npx vitest run convex/signedAttendanceEvidence.test.ts convex/shiftCloseouts.test.ts convex/attendanceCorrections.reversal.test.ts --maxWorkers=1
npx vitest run src/lib/attendance-comparison.test.ts src/app/closeout/attendance-comparison.test.tsx src/app/api/shift-closeout/attendance-comparison.test.ts src/app/closeout/closeout-selection.test.tsx --maxWorkers=1
npm run test:shift-closeout
npm run typecheck
npm run lint
```

Follow `docs/testing.md` for full regression and production build checks. Local
in-memory/browser fixtures are synthetic evidence, not deployed-backend, real
portal-login or physical-Pi acceptance. No merge or deployment is part of this
candidate.
