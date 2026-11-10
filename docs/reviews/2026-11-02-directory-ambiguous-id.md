# Ambiguous employee IDs must block directory name fallback

Base: `9783d7c0b3883fb776e24233326ddd8ede844550` (current origin/master).

`reconcileEmployeeDirectory` already rejects duplicate legacy employee IDs, but
only reserves the workers in the duplicate group. If a third worker has no ID
and uniquely matches the directory name, name fallback assigns that third worker
to the conflicting directory row. A valid encoding then marks the row enrolled,
hides it from the remaining list, and returns that worker as the re-enrollment
target. Existing-worker enrollment loads the returned worker's current identity;
this finding does not claim an authorization bypass or a proven biometric write.

The fix prevents name fallback when the directory employee ID has multiple
worker matches. Unique ID matches and ordinary legacy name fallback retain their
existing behavior. No UI, Convex code, schema, or migration changes.

Two regression tests exercise the helper (including reversed input order) and
the actual employee-directory GET handler with its real reconciliation/filtering
logic. On the base implementation both fail: the helper reports `enrolled` and
the API omits the conflicted employee from `remaining` suggestions. With the
fix both pass; the three-file focused run passes all 43 tests.

Proof logs: [before](evidence/nov02-directory-ambiguous-id/before.txt),
[after](evidence/nov02-directory-ambiguous-id/after.txt).

Commands (prefix every test/check with
`TMPDIR=/home/noah/.cache/gk-nov02-portal-tmp flock -w 60 /home/noah/.cache/t3-recovery-heavy.lock`):

```
node node_modules/vitest/vitest.mjs run src/app/api/employee-directory/ambiguous-id.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run src/app/api/employee-directory/ambiguous-id.test.ts src/lib/employee-directory.test.ts src/app/api/roster-read-errors.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run src/lib src/app/api src/app/enroll/enrollment.test.tsx src/app/enroll/t3-directory-revision.test.tsx --maxWorkers=1
```

Final validation uses the parent-verified Nov 1 node_modules tree. All declared
package versions match package-lock.json (0 mismatches). Earlier exploratory
runs used the requested Oct 21 tree, which differed from the lockfile; the
committed fail/pass proof was recaptured with the matching dependencies.

The cached and freshly queried open PR file ledgers have no overlap with this
change. October 26–November 1 merged work and existing directory ambiguity tests
were inspected; this closes a remaining bypass of the earlier ambiguity guard,
not a duplicate of roster read errors (#266) or enrollment identity locking.

Sensitivity: identity/re-enrollment target selection is security-sensitive;
authorization rules, money/payroll, deployment, and migrations are unchanged.

Final checks with matching dependencies:
- Broad API/library/enrollment run: 71 files, 678 tests pass.
- `npm run lint`: pass.
- `npm run typecheck`: pass (portal and Convex TypeScript).
- `npm run test:contracts`: pass, 28 files.
- `npm run build`: blocked by Turbopack's workspace-root restriction on the
  required external node_modules symlink (`Could not find the Next.js package`).
- `npm run test:python`: blocked at the first test by system Python missing NumPy.
  No Python code changed.
- A follow-up webpack build / existing-Python-environment attempt timed out
  acquiring the shared lock after 60 seconds; neither fallback started.

Complete local logs and scripts remain in `.task-logs/` in this worktree:
`exact-results.txt`, `exact-focused.txt`, `exact-lint.txt`, `exact-typecheck.txt`,
`exact-build.txt`, `exact-contracts.txt`, `exact-python.txt`,
`dependencies-exact.txt`, `run-exact.sh`, and `run-fallback.sh`.
The parent's master baseline and independent exact-head review remain pending.
