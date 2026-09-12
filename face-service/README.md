# Face Encoding Service

FastAPI service for face encoding and matching, used by fw-gatekeeper.

## Endpoints

- `GET /health` — health check
- `POST /encode` — `{ photos: string[] }` → `{ encoding: number[] }` (512-dim normalized average embedding)
- `POST /match` — `{ photo: string, encodings: [{ worker_id, encoding }] }` → `{ match: { worker_id, confidence } | null }`

Photos are base64 JPEG data URLs. Matching uses cosine similarity with a 0.4 threshold.

`POST /encode` and `POST /match` require the `x-face-service-key` header to match
`FACE_SERVICE_KEY`. `GET /health` remains public for deployment and dashboard health checks.
Set `FACE_SERVICE_ALLOWED_ORIGINS` to a comma-separated list of trusted dashboard origins;
it defaults to `https://fw-gatekeeper.onrender.com` and rejects wildcard configuration.

## Reproducible production install

The Docker image installs `requirements.lock` with SHA-256 verification. It locks
all 26 runtime packages for CPython 3.11, Linux x86_64; `requirements.txt` is the
editable direct-dependency input. The image and OS packages remain separately
maintained. On another OS, use the development inputs below instead of this
platform-specific production lock.

Regenerate both server and Pi locks with uv 0.12.13, from the repository root:

```bash
bash scripts/lock-python-dependencies.sh
# Deliberate upgrades: edit the input requirements files first; to refresh
# transitive versions, remove the corresponding .lock file before regenerating.
```

Review the generated diff, install into a fresh Python 3.11 environment with
`pip install --require-hashes --only-binary=:all: -r requirements.lock`, run the
face-service tests, and load the pinned ONNX model before rollout.

## Development run

```bash
export FACE_SERVICE_KEY="replace-with-a-long-random-secret"
py -m pip install -r requirements.txt
py main.py
# or: start.bat
```

Runs on port 5557.
