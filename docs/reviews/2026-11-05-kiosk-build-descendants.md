# Kiosk build workers survive their exited leader

Tier B: deployment/update process cleanup. Base: master
`3790da196bcd180d68b7bd073f6bd120e8e1041d`.

`guard()` runs dependency builds in an owned process group and calls
`stop_child()` in `finally`. Previously, `stop_child()` skipped the entire group
when `poll()` had already reaped the leader. A worker left behind by a completed
or failed build could therefore continue writing after the updater returned or
collected staging. It also escaped further disk-reserve monitoring.

The fix signals the group even after its leader exits, retains the leader's
existing 20-second graceful shutdown window, then kills remaining members of
that group. An already-empty group is harmless. No state format, dependencies,
attendance code, API, or interface changes are involved.

## Reproduction and proof

Run from the repository root, under the host's heavy-work lock:

```sh
flock /home/noah/.cache/t3-recovery-heavy.lock \
  python3 pi-kiosk/test_release_build_descendants.py
```

The test runs the real `guard()` with real isolated Linux process groups. Its
build leader spawns a worker, waits until it is ready, then exits with 0 or 9.
Both cooperative and SIGTERM-ignoring workers must stop. The test also verifies
that the failed build retains exit code 9 and an empty group can be stopped
repeatedly. Its own cleanup kills only its fixture's process group even when
the regression fails.

With the original product helper, all four worker cases fail with
`dependency worker survived guard's cleanup after its leader exited`.
The identical regression is then run against the fixed helper.

Proof logs, the original helper, commands and dependency/check limitations are
retained outside the checkout:
`/home/noah/t3-ui-proof/pQIuEFpq/evidence/kiosk-orphan-build/`.

## Local validation

The focused regression passes all four worker cases and the empty-group control.
All 20 existing release tests pass under an isolated CPython 3.11.16 environment.
`npm ci`, lint, both TypeScript checks, production build and production dependency
audit pass (zero vulnerabilities). The shared checkout's older node_modules was
not used or modified.

`npm test` passes 1,721 Vitest tests (three existing skips) and all 65 Python test
files, then exits 1 in the contract phase: this host's Node 22.22.1 lacks native
TypeScript support (`ERR_NO_TYPESCRIPT`). A cached Node 22.23.2 supports stripping,
but its contract replay could not acquire the shared lock after more than ten
minutes and was cancelled before starting. The remaining contracts are blocked,
not claimed passing. An earlier release-suite attempt with bare Python 3.14
failed one fixture for missing NumPy; the prepared Python 3.11 run resolves it.
All runtime checks and installs were serialized under the required host lock.

## Scope and limits

Duplicate checks covered the supplied open/merged PR evidence, current history,
`docs/reviews`, and a fresh open-PR file listing. Neither changed Python path was
claimed by an open PR. This finding concerns leftover build processes, distinct
from prior build disk-reserve checks and update fallback work.

The verify-gatekeeper skill, environment reference and feature catalog were
read. Its sole supported journey is portal Activity Log attendance correction;
this helper affects none of that journey, so prepare/doctor/feature/cleanup are
not applicable to this fix. Real kiosk hardware, native dependency builds,
systemd, deployed updates, cameras/recognition and production data are
uncovered. The existing release suite uses disposable Git repositories, real
venvs/processes and stubbed pip/systemd.

Existing installations retain their permanent `.git/kiosk-launch.py` helper
across normal app updates. This source change applies when the corrected helper
is installed; it does not replace those existing copies or provide that separate
migration. No kiosk or production deployment was performed.
