# Portal selection reads can permanently block refresh

Base: `9783d7c0b3883fb776e24233326ddd8ede844550` (origin/master).
Card: https://trello.com/c/TR6gdTIZ. One finding; no migrations or Convex/Python edits.

`useSelectedData` waited indefinitely for its loader. A transport or JSON-body
read that never settles leaves Briefing and Exceptions loading, with their Refresh
buttons disabled. Workers also remains loading without exposing a read error.
AbortController alone does not provide a deadline. This is a reproducible stalled
transport path, not a claim about production incident frequency.

Reuse the dashboard's existing `boundedRead` helper: after 20 seconds it aborts
the read and rejects with the existing readable timeout message. The hook's
request/selection ownership guards still suppress obsolete results. This bounds
read requests only; no mutation is canceled or automatically retried. A server
operation can continue after browser cancellation. Slow successful reads taking
more than 20 seconds now require a retry, matching the dashboard's existing policy.

## Proof

The deterministic tests use fake timers and controllable promises. Hook cases
cover stalled fetch and stalled decoding, the aborted loader signal, a successful
retry, and a late old response that must not overwrite the retry. Rendered-page
cases mount the actual Briefing, Exceptions and Workers pages with stalled body
reads; they assert a visible timeout and enabled Refresh where one exists.
Workers has no existing Refresh control; this change exposes its read error.
No real browser or live backend was used.

Before/after outputs are committed in `evidence/nov04-selected-data-timeout/`.
Parent can reproduce base failure by running the new tests with
`git show 9783d7c0:src/hooks/useSelectedData.ts` substituted for only the hook,
then restoring the committed hook and rerunning the identical command.

Dependencies: reused
`/home/noah/.t3/worktrees/fw-gatekeeper/nov01-attendance-worker-joins/node_modules`
through a local symlink; every nonoptional installed package version matches the
current lockfile (zero mismatches). Node v24.22.1. No installation or lockfile edit.
Disk before heavy work: 106 GB available on `/`; 711,276 free `/tmp` inodes.
All heavy commands use `flock -w 600 /home/noah/.cache/t3-recovery-heavy.lock`.
Additional raw outputs and the refreshed open PR ledger remain at
`/home/noah/.cache/gk-nov04-portal-proof/` in the retained implementation checkout.

## Scope review

Reviewed the cached 30-open/100-merged PR inventory and searched their full
bodies for duplicate request/deadline work, then read relevant bodies; refreshed
all 30 open PR file lists before validation. No edited path overlaps an open PR or the supplied
exclusion ledger. Especially #284 handles invalid JSON from the activity API;
this fix handles requests that never settle in a separate shared client hook.
The existing dashboard deadline (#123; `t3-oct02-dashboard-refresh.md`) is reused,
not modified. Reviewed October 26–29 cached journals, October 30 hunt/final PR
records, October 31 review docs, November 1 checked-in reviews and November 2
review docs/bodies; no November 3 review doc was present in those sources.
No equivalent shared-hook deadline fix found.

Rejected inspected candidates: Workers PATCH validation errors are already
covered by #255; inactive recognition counts are already covered by #216;
Activity Log non-array-response handling is too close to excluded #284;
neighboring-date export cancellation and missed-punch pairing already have
focused lifecycle/policy coverage and no distinct bug was established.

Sensitivity: auth/permissions no; security policy no; money calculations no;
deployment/configuration no. This affects read availability on operational pages.
No ready/merge/deploy/Trello edits. Independent exact-head audit belongs to parent.

## Executed checks

Each following command ran under the heavy lock. Raw outputs are named below
in the cache proof directory. The final serialized runner is `checks.sh` and
its exit ledger is `results.txt`.

```sh
node_modules/.bin/vitest run src/hooks/useSelectedData.timeout.test.tsx src/app/selected-data-timeout.test.tsx --maxWorkers=1
# Original base hook: exit 1, 5 failed (before-all.txt).
node_modules/.bin/vitest run src/hooks src/app/selected-data-timeout.test.tsx src/app/workers src/app/briefing src/app/exceptions src/app/failed-load-empty-states.test.tsx src/app/date-selection.test.tsx src/app/filter-select-active-value.test.tsx --maxWorkers=1
# Final fix: exit 0, 19 files / 99 passed (adjacent-final.txt).
npm run lint
# Exit 0, six existing warnings (lint-final.txt).
npm run typecheck
# Exit 0, both projects (typecheck-final.txt).
npm run test:contracts
# Exit 0, all 28 files (contracts.txt).
NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud NEXT_TELEMETRY_DISABLED=1 npm run build
# Exit 1: Turbopack cannot resolve Next outside workspace through symlink (build.txt).
NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud NEXT_TELEMETRY_DISABLED=1 npm run build -- --webpack
# Exit 0 (build-webpack.txt).
```

An earlier run passed both hook regressions and both existing ownership tests
(`after.txt` in cache). The first adjacent run was 98 pass / 1 fail because the
new Workers test incorrectly expected a Refresh button. Corrected that test
assumption, reran the expanded regressions against base (all five failed), then
ran the final 99-test group above. No application change followed the first fix.

Full Vitest/Python and physical/live-backend checks were not run for this
shared-client-hook change. No claim of a full green suite. Exact-base GitHub run
https://github.com/Fading-West/fw-gatekeeper/actions/runs/41398123572 is red on
`9783d7c0b3883fb776e24233326ddd8ede844550`; its failed log is preserved as
`base-ci-failed.txt`. The five known arrivalReview test names are visible there.
No local broad-suite result was encountered that needs baseline attribution.
Git whitespace checks pass. Shared-lock waits eventually acquired; no check was
abandoned for lock contention. Standard build remains the separately recorded
local environment limitation. The independent audit and exact-head CI review
remain with parent.
