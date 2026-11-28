# Face-service JPEG orientation

Baseline: `bfaf65769cf0662c0fc68f4ac47a722fd521fbae` (`origin/master`).
Branch: `t3/face-service-correctness`.

## Finding and fix

`decode_image` converted the stored raster directly to RGB, ignoring the EXIF
orientation used to display JPEGs. A valid orientation-6 portrait therefore reached
Haar detection rotated 90 degrees from its displayed appearance. Both `/encode`
and `/match` share this decoder: the former can reject clear photos as `no_face`,
and the latter can return no match. Mirrored orientations also changed the pixels
supplied to recognition. The decoder now applies Pillow's EXIF transpose before
RGB/BGR conversion. Pixel-count and still-image checks remain before conversion.
No dependency changes, face thresholds, model changes or UI changes.

## Regression evidence

First added `face-service/test_image_orientation.py`, then ran it against unchanged
product code with `outputs/face-venv/bin/python face-service/test_image_orientation.py`.
The test creates real asymmetric JPEG bytes with EXIF metadata and compares decoded
BGR pixels with the eight explicit orientation transforms; it also checks an
untagged JPEG and the two authenticated endpoint paths. Native OpenCV, Pillow and
NumPy execute; endpoint detection and embedding are deterministic mocks, not a real
face/model accuracy test. No model load or production call occurs.

- [Before](evidence/nov09-face-orientation/before.txt): 3 tests, 8 failures
  (seven orientation subtests and the enrollment endpoint assertion).
- [After](evidence/nov09-face-orientation/after.txt): same 3 tests pass.

Inspected open and recent PR titles AND changed files via
`gh pr list --state all --limit 55 --json number,title,state,files` before edits.
The face-service overlaps were dependency-only #268 and #291; requirements are
untouched. All provided kiosk/portal exclusions are untouched. Related paths
reviewed: `/encode`, `/match`, image size checks, enrollment consistency selection,
readiness/model loading, portal `/api/enroll` photo forwarding and storage.

## Validation and limits

All checks ran in this worktree; heavy operations used
`flock /tmp/fw-gatekeeper-JYxTdXIa-heavy.lock`. The resource gate remained above
5 GB disk / 6 GB MemAvailable. Runtime installs used the unchanged hash-locked
requirements in `outputs/face-venv` (Python 3.11); npm dependencies and Chromium
were installed inside this worktree. System Python lacked venv support, resolved
by using uv's Python 3.11 interpreter.

- Face-service suite: all 63 tests in 8 files pass, no skips.
- `npm run lint`: exit 0, six warnings in unchanged TypeScript files.
- `npm run typecheck`: exit 0 (app and Convex checks).
- `NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud npm run build`: exit 0.
- Full suite, split into its three constituent commands to bound Vitest workers:
  `npx vitest run --maxWorkers=2`: 213 files / 1,738 tests pass, one opt-in
  closeout browser file / three tests skipped by the normal local guard;
  `PYTHON="$PWD/outputs/face-venv/bin/python" npm run test:python`: all 67 files pass;
  `npm run test:contracts`: all 28 files pass.
- `git diff --cached --check`: pass.

Full output and individual exit codes: `outputs/validation/`; runtime installation
and face-only suite logs: `outputs/runtime-install.log`, `outputs/face-suite.log`.
[Compact validation record](evidence/nov09-face-orientation/validation.txt).

Read `.agents/skills/verify-gatekeeper/SKILL.md`, `environment.md`, `features.json`,
root README, face-service README and `docs/testing.md`. The local Convex backend
binary is absent; no full-stack proof is claimed. No actual face JPEG, camera,
ONNX inference, Docker image, Render deployment or production data was exercised.
