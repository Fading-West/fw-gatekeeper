# Worker attendance reads amidst unrelated history

Trello: gAbK480n. Base: `8c6c8ba4446cf7cfef2d4cac2a520da299d43e7b`.
This branch starts from freshly fetched master and does not contain PR304.

`attendance:list({ date: '2026-09-01', workerId, includeCorrections })`
returned four punches on an otherwise empty disposable local backend. After
inserting 33,000 unrelated attendance rows inside the same conservative timestamp
range, both `includeCorrections: false` and `true` failed with:

```
Your request timed out performing too many system operations.
```

The backend recorded `SystemTimeout` after approximately 15 seconds, paused in
`database_syscall(1.0/queryStreamNext)`. The target worker still had four punches.
The failure reproduced with minimal unrelated rows and with 1 KiB attendance
notes. Neither run reported a document-read or byte-limit error: those specific
limits remain unproven. This is a demonstrated worker-read capacity failure,
not a claim about production incidence or a measured document-limit threshold.

The timestamp index selected every worker in the date range before applying the
worker filter. The fix uses the existing `by_worker_and_timestamp` index for
worker-specific reads. The timestamp bounds, unscoped reads, ordering, and shared
read scope/key remain unchanged. No schema change is needed.

## Reproduction and validation

Install locked dependencies only in the owned checkout. All heavy commands below
use `/home/noah/.cache/t3-recovery-heavy.lock`; check disk and memory before each.
Stop below 5 GiB available disk or 6 GiB MemAvailable. The regression additionally
checks these thresholds itself.

```
flock /home/noah/.cache/t3-recovery-heavy.lock node scripts/verify-attendance-worker-capacity.mjs --baseline --notes --backend-bin /home/noah/.cache/convex/binaries/precompiled-2026-10-22-1447815/convex-local-backend
flock /home/noah/.cache/t3-recovery-heavy.lock node scripts/verify-attendance-worker-capacity.mjs --backend-bin /home/noah/.cache/convex/binaries/precompiled-2026-10-22-1447815/convex-local-backend
```

The first command must exit 1: it replaces only `attendanceReads.ts` in the
**disposable copy** with the base version. The candidate command must exit 0.
The regression checks both raw and effective reads, exact four-row membership
and chronological output for local, UTC and offset timestamps. It updates a
target punch before the capacity reads so cached small-fixture results cannot
satisfy the assertions. `--notes` optionally adds 1 KiB notes to unrelated rows.

The opt-in script is named `verify-` so the standard contract runner does not
invoke a local-backend prerequisite absent from CI. It copies source and links this checkout's installed dependencies into
an owned run. It generates local-only instance credentials, binds both backend
ports to loopback, and deploys only to that backend with an isolated environment.
A fixture module exists only in the disposable copy. Admin impersonation invokes
the real public query and portal authorization checks; it does not test JWT
issuance. No production service or caller credentials are used. Cleanup checks
process identity, stops only the owned backend, removes its source/database/home,
and keeps `evidence/result.json` plus private logs in the printed run directory.

- Focused tests: 10 files, 98 tests passed, including the new worker/shared-read
  contract tests and existing attendance ordering, DST, offset, identity,
  provenance, worker joins, shift pairing and signed-closeout composition tests.
- `npm run typecheck`: both app and Convex TypeScript projects passed.
- Real backend: baseline exits 1 with two capacity-query timeouts; candidate
  exits 0 with four exact punches in both raw/effective capacity reads, with
  and without 1 KiB notes on the unrelated rows.
- Backend binary SHA-256:
  `044eedfe569b1550d5003683aec7fceb4dcee3f82abf00ab9baf1c10d3ca0b4c`.
- Evidence/log root for this investigation:
  `/tmp/gAbK480n-evidence/attendance-worker-capacity/`.

## Owner integration check

The first GitHub run at `d38d336e` failed because the contract runner auto-discovered
the original `test-` filename and invoked the opt-in backend probe without its
required binary. Rename it to `verify-attendance-worker-capacity.mjs`; the regular
contract suite remains independent of the local backend prerequisite. This was
a PR-introduced validation failure, not a known-main failure.

## Remaining work

An independent fresh Sol audit belongs to the parent/owner. No full Next stack,
UI screenshot, production deployment, merge or hardware validation is part of
this backend proof. After merge, the owner removes this worktree and settles the
thread.
