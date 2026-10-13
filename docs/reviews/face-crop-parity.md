# Portal/kiosk face crop parity

**SCHEMA CHANGES: none. Template versioning/enforcement is deferred to a separate
PR. OWNER DECISION REQUIRED before merge: select the repair/re-enrollment and
consent procedure below. No deployment or migration has been run.**

## Confirmed problem and reproduction

Both sides pin the same 512-d MobileFaceNet model SHA-256
`9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f`, use
25% box padding and no landmark alignment. The service used full-resolution
Haar; the kiosk live loop and local CLI use half-resolution RGB, dlib HOG with
one upsample, face_recognition bounds trimming, and ×2 box scaling. Detector
geometry, including this downscale step, is part of the recognition pipeline.

The issue report measured Haar/HOG cosine on six images as 0.199, 0.554, 0.644,
0.790, 0.864, 0.907, versus 0.87–0.98 for HOG on 3px-shifted copies. Those
original images were not available here, so these are **reported measurements**,
not reproduced values. No real-person images were downloaded.

Six newly generated fictional adults are committed under
`face-service/fixtures/`; the fixture README records tool, prompt and processing.
The actual pinned ONNX model, dlib 20.0.1 and face_recognition 1.3.0 were run in a
uv Python 3.11 venv. [Raw measurements](evidence/face-crop-parity/measurements.json):

| Fixture | Old Haar vs kiosk | Held-out calibration vs kiosk | Fixed service vs kiosk | Kiosk vs 3px shift |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0.023 | 0.922 | 1.000 | 0.979 |
| 2 | 0.315 | 0.851 | 1.000 | 0.942 |
| 3 | 0.465 | 0.707 | 1.000 | 0.927 |
| 4 | 0.491 | 0.762 | 1.000 | 0.980 |
| 5 | 0.165 | 0.916 | 1.000 | 0.593 |
| 6 | 0.408 | 0.887 | 1.000 | 0.986 |

Four of six old crops fell below the kiosk's 0.45 threshold even on the same
image. Haar's top edge was 34–60 px higher on this set. Exact same-image parity
is necessary but does not establish real-world accuracy: one HOG shift control
scored 0.593, lower than the issue report's control range.

Reproduce after installing face-service deps plus face_recognition 1.3.0,
face_recognition_models 0.3.0 and setuptools 80.9.0 in a uv venv:

```bash
python scripts/measure-face-crop-parity.py --model /path/to/rec_model.onnx
FACE_PARITY_MODEL=/path/to/rec_model.onnx python face-service/test_crop_parity.py
```

The measurement script verifies the model digest, never downloads photos, and
uses the real kiosk API when installed. Without face_recognition, it states that
it uses an equivalent direct-dlib reference adapter. Production needs only dlib.

The direct adapter is checked against the installed face_recognition 1.3.0 API;
upstream references: [face_recognition adapter](https://github.com/ageitgey/face_recognition/blob/master/face_recognition/api.py)
and [dlib build documentation](https://dlib.net/compile.html).

## Options and decision

1. **Chosen: direct dlib HOG in the face service.** 6/6 identical crops and
   embeddings (cosine 1.000), including the kiosk's half-frame step; 0 changes to
   the deployed kiosk pipeline or existing HOG templates. Calling only
   `get_frontal_face_detector()(rgb, 1)` reproduces face_recognition 1.3.0 HOG
   without importing its unused landmark/CNN/dlib recognition models. The local
   compiled dlib extension is 12 MiB. Import peak RSS was 108 MiB with
   direct HOG versus 209 MiB with full face_recognition in the same process. Production compiles hash-locked source in a
   builder stage and excludes compilers/cmake/build tools from the runtime.
   First local attempt failed (no C++/make); a user-space Ubuntu toolchain under
   `/dev/shm` allowed a successful 4m19s build. CI verifies the actual Docker
   build on its 4-vCPU runner; build parallelism is limited to 2.
2. **YuNet/SCRFD on both sides:** could provide deterministic parity, but changes
   all three detector callers, adds another pinned model, and invalidates the
   assumed crop compatibility of **every existing portal and local HOG template**.
   No alternative detector accuracy figures are claimed; it was rejected on
   migration/disruption cost before implementation. Existing HOG has proven exact
   parity with the minimal service-only change.
3. **Haar box offset/scale:** fit normalized center translation and independent
   width/height ratios on five fixtures, evaluated on the held-out sixth. Cosine
   0.707–0.922, all above 0.45 on this small set but materially below 1.000.
   Detection window quantization and pose variation cannot be recovered from
   Haar geometry alone. Six frontal synthetic fixtures cannot justify a universal
   calibration or a high-severity production fix using it.

The crop, resize, BGR→RGB, [-1,1] normalization and pinned recognition model are
unchanged. `/health` exposes service `3.2-hog-crop-parity` and diagnostic detector
`dlib-20.0.1-hog-half-upsample1-pad25-v1`. This is **not template version storage**.
ONNX thread counts are limited to one; image work in `/encode` and `/match` is
serialized to avoid concurrent decoded images and HOG pyramids. Locally, a fresh
service process peaked at 94 MiB on import, 140 MiB after model loading, and
249 MiB with six maximum-size 2000×2000 photos (11.13 seconds for encoding).
Docker CI runs native parity plus that batch under a 512 MiB hard limit and
checks peak RSS <450 MiB, leaving headroom. These are bounded workload checks,
not a promise about unbounded request volume. Queueing/cold-start latency must
be checked on Render; the portal request timeout remains 60 seconds.

That in-process figure excludes HTTP bodies, and the serialization lock does not
cover them: each waiting request has already read and parsed up to 24 MB of
JSON. Review measurements over HTTP (uvicorn child process, six 3.6–3.8 MB
photos per request, one pinned core) peaked at **288 MiB** for one request,
**424 MiB** for two concurrent requests and **498–535 MiB** for three, at or
above the 512 MB instance (master's Haar service: 382/638/914 MiB). `image_admission.py` therefore
admits authenticated `/encode` and `/match` requests by declared body size
(32 MiB in flight, with a hard 24,065,536-byte limit on each received body). Portal captures (three 640px JPEGs,
~45 KB each) are never refused for one another; a second maximum-size request
gets 503 with `Retry-After`; the response completes immediately and uvicorn
discards unread input. With admission, three
concurrent maximum requests returned one 200 and two 503s and peaked at
**303 MiB**; five concurrent portal-sized requests all returned 200 (184 MiB). CI runs
`scripts/check-face-service-memory.py` in the built image under 512 MiB.

Review hardened admission against chunked/unknown lengths and bodies larger than
their declared length: actual bytes reserve capacity before being passed to the
application, oversized bodies return 413, and all reservations are released on
validation failure, decode/model errors, disconnect or cancellation. Invalid
credentials are rejected before FastAPI buffers or parses JSON. `/match` also
discards its decoded frame before releasing the image lock. The HTTP memory
check additionally fills the budget with a maximum request plus a two-photo
request and tests oversized chunked and unauthenticated bodies.

A separate `/match` request with 15,500 512-d vectors (30.9 MiB body)
peaked at **687 MiB**, demonstrating that raw-body accounting alone does not
bound parsed numeric rosters. Round 1's 8 MiB limit was too small for the supported
production roster; round 2 restores the 24,065,536-byte allowance and bounds the
roster to 1,001 workers, each with at most 512 numbers. A streaming ijson pass
checks array lengths, scalar types, nesting, key/string lengths and total events
before FastAPI allocates objects. This also rejects hostile compact arrays before
they expand. Each match reserves at least 16 MiB against the shared 32 MiB budget.
Authentication/admission applies under an ASGI root path too. Refused uploads
and body overflows respond without draining, so a slow client cannot indefinitely
delay rejection or retain a rejected request's reservation.

The current portal/Convex callers use `/encode` and `/health`; neither calls
`/match`. Both kiosk callers use local ONNX matching. Nevertheless, the match
contract must accommodate the roster allowed by `convex/workers.ts`: its identity
scan permits 1,000 existing workers and one final insertion. A full roster has
**512,512 numbers**. Normalized binary64 values serialized by JavaScript/Python
can need roughly 20–25 characters each, plus separators and 1,001 IDs/row wrappers.
A conservative 25-character spelling plus one comma per number, 128 bytes per
row and a 4,000,000-character photo totals **17,453,440 bytes**, below the restored
cap but above 8 MiB. A generated normalized-vector roster with 32-character IDs
and the maximum photo measured **15,331,348 bytes** with Python JSON encoding.
JavaScript `JSON.stringify` produced **14,815,831 bytes** for the same payload
(longest observed float spelling: 23 characters). Tests accept the Python body
with Content-Length and chunked framing.

The expanded HTTP check uses one uvicorn worker pinned to one core, real HOG and
ONNX, a noisy near-limit 4 MP photo, 1,001-worker rosters with realistic long float
spellings and compact `0.1` spellings, two admitted full rosters plus one refused
roster, and matching beside four-photo enrollment. A locally rerun process peaked
at **421.2 MiB** across all these workloads (the final rerun peaked at 411.9 MiB);
statuses were the expected 200/503,
413 for oversized bodies and 422 for hostile numeric arrays. Docker CI repeats
the complete check under its 512 MiB hard limit and requires peak RSS <450 MiB.

Overlap: PR #152 adds a 24,065,536-byte body cap and a 1,001-worker roster cap to
`main.py`; these limits now agree. Its oversized-body-before-auth precedence
differs: this PR intentionally authenticates first (401 for invalid credentials,
503 without `Retry-After` for missing configuration), then checks declared/actual
bytes and JSON structure. Keep a single admission/structure implementation when
reconciling #152; its tests expecting pre-auth 413 or draining semantics require
reconciliation. PR #149 adds `telemetry={"auto_configure": False}` to FastAPI
construction and an OTEL startup CI test; those changes are independent of the
crop/memory behavior and should be retained when resolving the shared-file edits.

CPU per photo on one host core: HOG at 640×480 57 ms, 1280×720 178 ms,
2000×2000 880 ms. A real portal request (three 640×480 photos) used 1.4 s of
service CPU end to end; six ~4 MP photos used 7.8 s. `render.yaml` uses the free
plan (0.1 CPU), so expect roughly 10× longer wall time: about 14 s for a portal
enrollment, but over the portal's 60 s timeout for six 4 MP photos, which the
portal UI never sends (it captures at most 640 px wide).

## Existing templates: opt-in repair plan

`RETENTION.md` explicitly retains enrollment JPEGs to regenerate templates.
`workers.photoStorageIds` points to Convex storage; the portal saves only the
photos accepted by the quality gate. Committed attachments do not have an
automatic expiry. Superseded, purged, absent or failed-upload photos may be
unavailable. **Do not restore purged data or resurrect inactive workers.** The
local enroller saves JPEGs and HOG templates in local SQLite/files and does not
upload them to Convex; its templates do not need blanket re-enrollment.

There is no reliable historical source/detector version. Identify the conservative
candidate set as active cloud workers with a 512-d template enrolled before the
corrected-service rollout. Inspect retained photo references and enrollment audit
records through authorized admin/internal access, plus operator provenance where
available. Dates/photos are candidates, not proof of Haar provenance. Do not infer
compatibility from vector length or silently relabel unknown encodings.

**OWNER DECISION REQUIRED:** approve one of these procedures before rollout:

- Preferred when photos remain: an explicit admin-authorized, small allowlist
  repair action/tool (to be implemented/reviewed separately). Obtain a fresh
  worker consent acknowledgement under the current policy before each write;
  server-side repair does not require new camera captures. Process the attached
  JPEGs in memory through authenticated `/encode`, enforcing the same quality gate
  (minimum two consistent photos). Stop for re-enrollment if photos are missing,
  decoding fails, or quality fails. No broad automatic scan or scheduled repair.
- Otherwise: portal re-enrollment on the corrected service, with fresh consent
  and new photos. Until repaired, route affected workers through the approved
  alternate attendance procedure; keep kiosk match/liveness thresholds intact.

For the future tool, re-read and compare worker active/purge state, template,
photo ID set and revision immediately before committing so a concurrent purge,
re-enrollment or identity change wins. Write only to that worker; retain the
original attached photos (or apply normal superseded-photo deletion for rejected
ones). Pass `photoStorageIds` explicitly: `workers.update` otherwise deletes the
old attachments when writing a new encoding. Existing attachments are accepted
by `consumeEnrollmentPhotos`, and `workers.update` enforces fresh consent and
writes an operator-attributed audit record. Add a repair-specific audit record
with old/new detector identity, timestamp, accepted indexes and authorized actor;
never log vectors, photos, storage URLs or secrets. An internal commit path must
preserve these checks instead of bypassing consent or purge rules. Do not export
biometric backups or add a retention exception as part of this repair.

After each approved write, verify roster sync on every kiosk and run a supervised
door check. An offline device keeps its old cached template until it reconnects;
last contact alone does not prove application. Track per-worker repair status
privately. This PR provides the design only; it installs no migration endpoint,
does not read production biometrics, and executes no repair.

## Template versioning follow-up

This PR deliberately has **no Convex schema change**. A follow-up should add
optional `workers.facePipelineVersion`, propagate it through enrollment,
worker queries/roster payloads, SQLite cache and local enrollment, clear it on
purge or unversioned template replacement, and enforce it before matching.
The version must cover model digest, dlib version, half-frame/upsample behavior,
coordinate rounding, padding and preprocessing. Explicit mismatches must be
excluded from candidate matching and counted in kiosk telemetry/health even when
other workers remain usable. Owner approval is required for unknown-version
policy and verified legacy HOG attestation; do not label all existing 512-d
vectors as current. Include cached/offline templates and in-flight candidates in
the enforcement tests. This broader data rollout belongs in its own reviewed PR.

## Deploy order and validation

1. Owner approves migration/consent plan and supervised pilot; coordinate overlapping
   face-service PRs #149/#150/#152 before merge (none were modified here).
2. Release the corrected face-service image only; verify health detector/version,
   memory and cold-start latency. No Convex/portal/kiosk deploy is required for parity.
3. Execute only separately authorized repair/re-enrollment; confirm every kiosk
   has applied the updated roster, including devices that were offline.
4. Complete supervised camera checks before expanding the repair batch. Rollback
   of the service does not revert repaired encodings; preserve the compatible HOG
   repair state and pause enrollment if rollout must be halted.

Tests cover native synthetic detections (six faces at three sizes, including odd
sizes), edge clipping/padding rounding, exact crop pixels and model input tensors
against `pi-kiosk/embeddings.py`, real 512-d embeddings, blank/crowded quality
gates, and the maximum photo batch. Standard lint, both TypeScript projects,
Vitest, Python, contract suites and production build are required. Docker CI must
build, load the pinned model and pass the memory-limited native tests.
Physical kiosk camera/factory lighting, field false acceptance/rejection rates,
Render behavior under traffic, and actual retained-photo coverage remain owner
pilot checks. The synthetic test set is small and mostly frontal.
