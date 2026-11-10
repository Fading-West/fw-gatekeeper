# Kiosk model publication failure leaks complete downloads

Base: `bfaf65769cf0662c0fc68f4ac47a722fd521fbae` (`origin/master`).
Branch: `t3/kiosk-helper-bug`. Trello: JYxTdXIa.

`ensure_pinned_model` created a unique sibling download, verified its digest and
flushed it inside a cleanup guard, then renamed it outside that guard. A failed
rename (for example filesystem metadata exhaustion returning ENOSPC) left the
complete `.part` file. A retry starts a fresh download; it does not reuse or
collect the previous attempt. Repeated startup/recovery attempts could therefore
consume more disk while the model remains unavailable.

Move only the rename into the existing cleanup guard. Errors still propagate;
cleanup removes only that invocation's temporary sibling. Successful publication
still occurs atomically after verification and file fsync, followed by directory
fsync. No model pin, download, matching, update protocol, or face-service code changes.

## Regression evidence

The test was added first and run against unchanged product code at the base SHA:

```
.venv/bin/python pi-kiosk/test_model_pinning.py ModelPinningTests.test_failed_model_publication_does_not_accumulate_downloads_on_retry -v
```

It failed because the directory contained an extra `model.onnx.*.part` after a
simulated ENOSPC rename failure. The test uses real temporary files, downloads,
digest checks and fsync, with synthetic response bytes and rename fault injection.
It checks three retries, propagated errno, no published model, unchanged legacy
cache, preserved unrelated operator `.part` evidence, and no leaked files.

After the fix, `.venv/bin/python pi-kiosk/test_model_pinning.py -v` passes all
14 tests, covering concurrent downloads, corrupt cache replacement, digest and
flush failures, disk reserve, offline migration and fallback preservation.
Six related suites pass (76 tests): matching, clock sync, setup policy, enrollment
samples, worker identity and sync mapping. See `evidence/nov09-kiosk-model-publication/`
for the original red/green output and related-suite output.

## Scope and limitations

Reviewed open PR titles/files and the 150 latest PRs using `gh pr list`; no open
PR edits either changed product/test file. The older overlapping release PR #177
is merged and its changes are present in the base. Assigned exclusions remain
untouched. Read root/kiosk README, testing docs and the verify-gatekeeper skill.
Resources remained above the 5 GiB disk / 6 GiB MemAvailable stop thresholds.
Dependencies live only in this worktree. All heavy operations use
`flock /tmp/fw-gatekeeper-JYxTdXIa-heavy.lock`.

This is a synthetic filesystem failure proof, not a real full-disk or hardware
pilot. No UI changed. The opt-in full-stack verification is blocked by the absent
`~/.cache/convex/binaries/*/convex-local-backend`; no full-stack proof is claimed.
No production calls, deploys, merges or PR watching were performed.

## Broader validation

Using this checkout's Node 24.22.2 and Python 3.11.16 venv, `npm ci` and locked
Python runtime plus constrained test-dependency installation completed. Under the
shared lock, `npm run lint`, `npm run typecheck`, and
`NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud npm run build` all exited 0.

`npm test` exited 1 at Vitest: 212 files / 1,731 tests passed, one file skipped
(9 skipped tests), one test timed out after 5 seconds:
`src/lib/attendance-backlog.test.ts` → “stops starting work at the deadline and
resumes committed progress next time”. It reported 7,398ms duration. This file
and its product code are unchanged; the original failed run is preserved in
`full-vitest.txt`. This short-circuited the Python and contract stages of
`npm test`, which are run separately below.

The committed candidate's `node .agents/skills/verify-gatekeeper/run.mjs prepare`
exited 2 at backend discovery, before creating a run. Exact diagnostic is saved
in `full-stack-blocked.txt`; no doctor/feature/negative-control proof was possible.

The isolated `npx vitest run src/lib/attendance-backlog.test.ts` rerun passed all
15 tests (7.25 seconds for the whole file), supporting a timing-related full-run
failure. The original full-run failure remains recorded; a complete green
`npm test` is not claimed. `npm run test:python` passed all 66 Python test files,
and `npm run test:contracts` passed all 28 contract files. Exit statuses and the
isolated rerun are committed beside the red/green logs. Full installation,
build/lint/typecheck, Python and contract logs remain at
`/tmp/JYxTdXIa-helper-evidence/` on LizardBox.
