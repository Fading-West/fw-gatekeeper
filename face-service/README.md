# Face Encoding Service

FastAPI service for face encoding and matching, used by fw-gatekeeper.

Detection uses dlib 20.0.1 HOG, at half resolution with one upsample, exactly as
the kiosk live loop and local enroller do (including endpoint clamping and ×2
scaling). Only the HOG API is imported; no extra dlib recognition/landmark models
are loaded. Cropping keeps 25% padding and no landmark alignment;
recognition uses the InsightFace buffalo_s MobileFaceNet ONNX model (~13MB, downloaded
at image build time).

## Endpoints

- `GET /health` — `{ status, version, rec_model, rec_exists, detector_version, min_pairwise_similarity, min_good_photos }`
- `POST /encode` — `{ photos: string[] }` → `{ encoding: number[], photos: PhotoResult[], used_photo_indexes: number[] }`
- `POST /match` — `{ photo: string, encodings: [{ worker_id, encoding }] }` → `{ match: { worker_id, confidence } | null }`

Photos are base64 JPEG data URLs. Matching uses cosine similarity with a 0.4 threshold.

`POST /encode` and `POST /match` require the `x-face-service-key` header to match
`FACE_SERVICE_KEY`. `GET /health` remains public for deployment and dashboard health checks.
Set `FACE_SERVICE_ALLOWED_ORIGINS` to a comma-separated list of trusted dashboard origins;
it defaults to `https://fw-gatekeeper.onrender.com` and rejects wildcard configuration.

## Enrollment quality gate (`POST /encode`)

Every enrollment photo is checked before it can contribute to a worker's reference
vector. There is no center-crop fallback: a frame without a detectable face is never
encoded.

Each photo gets a `PhotoResult` of `{ index, ok, reason }` where `reason` is one of:

- `ok` — exactly one clearly detected face
- `no_face` — nothing detected
- `multiple_faces` — a second face at least 40% the area of the largest one
- `decode_error` — the data URL could not be decoded as an image

Embeddings of the `ok` photos must agree pairwise at cosine >= `MIN_PAIRWISE_SIMILARITY`.
If they do not, the photo with the lowest mean similarity to the others is dropped once;
if the remainder still disagree, none are used. At least `MIN_GOOD_PHOTOS` consistent
photos are required. The `encoding` is the L2-normalised mean of the used photos only,
and `used_photo_indexes` lists which request indexes contributed.

When the gate fails the service responds `422` with a structured `detail`:

```json
{
  "detail": {
    "message": "Enrollment needs at least 2 clear, matching photos of one face: 2 of 3 photos could not be used (no face detected). Retake the photos facing the camera in good light.",
    "photos": [
      { "index": 0, "ok": false, "reason": "no_face" },
      { "index": 1, "ok": true, "reason": "ok" },
      { "index": 2, "ok": false, "reason": "no_face" }
    ],
    "disagreeing_pairs": [[0, 2, 0.31]]
  }
}
```

`disagreeing_pairs` entries are `[index_a, index_b, cosine_similarity]` over the request
photo indexes. The dashboard's `/api/enroll` route forwards `message` as `error` together
with `photos` and `disagreeing_pairs`, and the enrollment page lists them under the error.

### Environment knobs

| Variable | Default | Purpose |
| --- | --- | --- |
| `MIN_PAIRWISE_SIMILARITY` | `0.6` | Minimum cosine similarity between every pair of used enrollment embeddings |
| `MIN_GOOD_PHOTOS` | `2` | Minimum consistent photos: `2` or `3`. The portal captures three photos, so other values fail at startup. |
| `FACE_MODEL_DIR` | `/app/models` | Where the recognition model is stored/downloaded |

Both thresholds are read at startup, so they can be tuned on the deployment without a
rebuild. `GET /health` echoes the active values.

## Reproducible production install

The Docker image installs `requirements.lock` with SHA-256 verification. It locks
all runtime packages for CPython 3.11, Linux x86_64; `requirements.txt` is the
editable direct-dependency input. dlib is built from its hash-verified source using the separately locked
`requirements-build.lock` tools in a Docker builder stage. Compilers, cmake,
and build tools are excluded from the final image. `CMAKE_BUILD_PARALLEL_LEVEL=2`
bounds build memory. The image and OS packages remain separately maintained. On another OS, use the development inputs below instead of this
platform-specific production lock.

Regenerate both server and Pi locks with uv 0.12.13, from the repository root:

```bash
bash scripts/lock-python-dependencies.sh
# Deliberate upgrades: edit the input requirements files first; to refresh
# transitive versions, remove the corresponding .lock file before regenerating.
```

Review the generated diff, install into a fresh Python 3.11 environment with a
C++ compiler and make available, then run the tests and load the pinned model:

```bash
pip install --require-hashes --only-binary=:all: -r requirements-build.lock
CMAKE_BUILD_PARALLEL_LEVEL=2 pip install --require-hashes --no-build-isolation \
  --only-binary=:all: --no-binary=dlib -r requirements.lock
```

## Development run

```bash
export FACE_SERVICE_KEY="replace-with-a-long-random-secret"
py -m pip install -r requirements.txt  # dlib needs C++ and cmake
py main.py
# or: start.bat
```

Runs on port 5557.

## Tests

```bash
python3 face-service/test_face_auth.py
python3 face-service/test_encode_quality.py
```

`test_encode_quality.py` needs `numpy` for the consistency unit tests and `fastapi` +
`httpx2` for the `/encode` endpoint tests (OpenCV and ONNX Runtime are stubbed; no model
or image is needed). If the system `python3` lacks them, either
`python3 -m pip install numpy fastapi httpx2 Pillow` or run the file with a venv
interpreter, e.g. `~/fsvenv/bin/python face-service/test_encode_quality.py`. Missing
packages make the affected tests skip with a warning rather than fail.

Enrollment requests accept at most six photos and four million base64 characters
per photo. Images must be still images of at most four million pixels. Invalid or
zero model embeddings fail closed. Similarity thresholds must be finite in (0,1],
and at least two consistent photos are required. Only accepted photo indexes are
stored by the dashboard. Concurrent cold starts share one recognition session.

Rollout: deploy the face service with this quality gate before the corresponding
portal code. The portal rejects encoders that omit accepted-photo metadata, so an
old encoder cannot silently bypass the new gate.

## Crop parity and rollout

See [the investigation and migration plan](../docs/reviews/face-crop-parity.md).
`npm run test:python` covers native detector, crop pixels and preprocessing tensors
against the kiosk embedding implementation. The image CI job repeats these tests
with the real, digest-verified ONNX model under a 512 MiB container memory limit.
To run that part locally, set `FACE_PARITY_MODEL` to the verified model file.

ONNX uses one inference thread. Enrollment and match image work is serialized
so concurrent requests do not hold multiple HOG pyramids/decoded arrays at once.
The public health endpoint identifies this detector as
`dlib-20.0.1-hog-half-upsample1-pad25-v1`; this is diagnostic metadata, not stored
template versioning. No schema or kiosk pipeline changes are included.

**OWNER DECISION REQUIRED before merge:** approve repair/re-enrollment of existing
portal templates and the consent procedure. Old Haar embeddings cannot be fixed
by deploying the new encoder alone. No migration or deployment is performed by
this change. Template version enforcement is a separate follow-up.
