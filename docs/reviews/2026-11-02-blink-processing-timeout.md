# Blink verification processing timeout

Base: `9783d7c0b3883fb776e24233326ddd8ede844550` (origin/master).
Reviewed all 27 cached open PRs / 138 touched files, refreshed open PR file
conflicts, and the Oct 26–Nov 1 merged PR list. No edited file overlaps those
open PRs. The continuous-blink review covers dropouts and invalid landmarks;
this finding concerns elapsed time during valid prediction/identity work.

`LivenessChecker.update` checked expiry before prediction, then could spend
time in the native predictor and (for kiosk attendance) identity embedding.
If the completing open-eye frame started at 4.9 seconds and finished at 5.1
seconds in a five-second window, it set `_alive` using expired closed-eye
history. The final expiry check then deliberately skipped the alive state.
Both the kiosk and local enrollment use this helper; kiosk pending verification
also extends its deadline when blink confirmation succeeds. No production
incident frequency or model speed is asserted.

The fix checks expiry after prediction and any required identity check, before
advancing blink state. The identity callback still validates every contributing
closed-eye and completing open-eye frame. A fresh blink remains possible after
expiry; already confirmed liveness retains its existing lifecycle.

Regression: deterministic clock and synthetic landmarks run the production
state machine, separately delaying prediction and identity verification across
the deadline. The test also checks fresh recovery and an in-window success.
No sleeps, real biometric data, model downloads, or camera hardware are used.

Sensitivity: biometric/liveness security behavior and the automatic attendance
gate. No auth/session changes, money calculations, deployments, migrations, or
portal/Convex edits. Physical Raspberry Pi camera/model acceptance remains
unverified. This changes timing policy enforcement, not recognition accuracy.

## Executed evidence

Using `/home/noah/.t3/worktrees/fw-gatekeeper/oct18-python-venv/bin/python`:

- `python pi-kiosk/test_blink_processing_timeout.py` on unchanged base helper:
  exit 1, both expiry-crossing subcases fail with `True is not false`;
  [actual output](evidence/nov02-blink-timeout/before.txt).
- Same command with the fix: exit 0, 2 tests pass;
  [actual output](evidence/nov02-blink-timeout/after.txt).
- `python pi-kiosk/test_oct02_continuous_blink_evidence.py`: 3 pass.
- `python pi-kiosk/test_liveness_policy.py`: 6 pass.
- `python pi-kiosk/test_review11_blink_callers.py`: 8 pass.

The focused state-machine tests take under one second. Broad checks are
serialized with `flock -w 60 /home/noah/.cache/t3-recovery-heavy.lock`;
`TMPDIR=/home/noah/.cache/gk-nov02-runtime-tmp`. Supplementary local logs and
runner script are in that directory. The original Oct21 node_modules has
version mismatches; the parent-provided Nov1 tree is reused instead and all
nonoptional installed package versions match this checkout's lockfile.

Broad checks executed with the matched Nov1 dependencies (Node v24.22.1):
`npm run test:python` passes all 65 files; `npm run test:contracts` passes all
28 files; `npm run lint` and `npm run typecheck` pass. Full Vitest is left to
the parent baseline/exact-head verification; this Python-only change does not
alter portal/Convex behavior. The known master arrivalReview failures are not
claimed as fixed.

`NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud npm run build` fails:
Turbopack cannot resolve the Next.js package outside its workspace root through
the reused node_modules symlink. This is a local dependency-layout limitation;
the standard build is not claimed as passing. A webpack fallback is recorded
separately. No local Docker build, deployment, or physical-device test ran.

`NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud NEXT_TELEMETRY_DISABLED=1
npm run build -- --webpack` passes (exit 0), under the shared heavy-work lock.
All raw broad-check logs remain under
`/home/noah/.cache/gk-nov02-runtime-tmp/`: `python.log`, `contracts.log`,
`lint.log`, `typecheck.log`, `build.log`, and `build-webpack.log`.
