# Recognition name aliases must preserve retry evidence

Daily card: cawRMeA5. Base: origin/master
`cd4d9e87908929d84a3a21a60fb0f81cf261e7ba` (verified against HEAD).

## Defect and scope

The bulk recognition API accepts `candidate_worker_name`,
`candidateWorkerName`, `worker_name`, and `workerName` as the same candidate
name. When both face-detection and score fields are omitted, only the first
alias previously inferred `faceDetected: true`; the others inferred false.
Thus changing only the accepted name alias on a retry changed immutable
evidence and caused HTTP 409 `RECOGNITION_ATTEMPT_CONFLICT` instead of an
idempotent success. A fresh camel-case payload also stored the wrong inferred
face-detection flag relative to the equivalent snake-case payload.

The fix derives the name once using the existing alias precedence and uses
that value for both inference and storage. Explicit false values still win.
The real Convex conflict check remains intact for actual evidence changes.
This changes only the portal bulk-ingest normalization, not review, timestamps,
attendance, worker reads, or the UI. No excluded file is modified.

Current Pi uploads explicitly send `faceDetected`; those uploads are unaffected.
This fix covers the API's already accepted fallback payloads. It does not repair
old rows whose inferred flag was previously stored as false; conflicting
retries against those rows remain conflicts. No production incident is claimed.

## Before/after proof

New test calls the actual Next POST handler, forwarding its secured HTTP request
to the real in-memory Convex HTTP action and mutation. Authentication is stubbed
to a synthetic kiosk; normalization, conflict detection, and persistence are real.

Before the production edit, with the first seven regression cases added:

```sh
./node_modules/.bin/vitest run src/app/api/recognition-attempts/bulk/alias-retry.test.ts
```

Result: **3 failed, 4 passed**. Each retry under a different accepted alias
returned 409 where 201 was expected. Captured output:
`/tmp/cawRMeA5-alias-retry-evidence/before.txt`.

After the fix, including a further true-conflict control:

```sh
./node_modules/.bin/vitest run src/app/api/recognition-attempts/bulk
./node_modules/.bin/eslint src/app/api/recognition-attempts/bulk/route.ts src/app/api/recognition-attempts/bulk/alias-retry.test.ts
npm run typecheck
node scripts/test-recognition-attempts-contract.mjs
node scripts/test-secured-ingest-contract.mjs
git diff --check
```

All pass: **5 test files, 23 tests**, including eight new cases. The successful
retry returns `ingested: 0, skipped: 1` with exactly one persisted row. Controls
cover explicit boolean/numeric/string false, blank names, and a genuine changed
face-detection report returning 409 without altering the stored row. Test output:
`/tmp/cawRMeA5-alias-retry-evidence/after.txt`.

No install, Next build, full-stack verification, audit, push, PR, production
access, or deployment performed. Matching-lockfile dependencies were copied
into the owned worktree under the shared heavy-resource lock for these checks,
then removed along with generated TypeScript output.
