"""Face encoding/matching service for fw-gatekeeper.
Recognition: InsightFace buffalo_s MobileFaceNet (~13MB) via ONNX Runtime.
Detection: OpenCV Haar cascade (bundled with opencv-python-headless).
Runs comfortably on Render free tier (512MB RAM).

Enrollment quality gate (POST /encode):
- a photo is only used when exactly one clearly detected face is present
  (no center-crop fallback, no lenient second detection pass);
- embeddings of the usable photos must agree pairwise at
  >= MIN_PAIRWISE_SIMILARITY cosine, otherwise the outlier is dropped;
- at least MIN_GOOD_PHOTOS consistent photos are required, otherwise the
  request fails with 422 and per-photo reasons so the operator can retake.
"""

import base64
import io
import os
import threading
from pathlib import Path
from typing import Annotated, Optional

import cv2
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel, Field
import onnxruntime as ort

from model_pinning import REC_MODEL_URL, REC_MODEL_SHA256, ensure_pinned_model

from enrollment_quality import (
    MIN_GOOD_PHOTOS,
    MIN_PAIRWISE_SIMILARITY,
    has_competing_faces,
    largest_face,
    select_consistent_embeddings,
)
from face_auth import (
    FACE_SERVICE_KEY_HEADER,
    get_allowed_cors_origins,
    get_configured_face_service_key,
    is_valid_face_service_key,
)

SERVICE_VERSION = "3.1-quality-gate"

app = FastAPI(title="Face Encoding Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_cors_origins(),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", FACE_SERVICE_KEY_HEADER],
)

MODEL_DIR = Path(os.environ.get("FACE_MODEL_DIR", "/app/models"))
MODEL_DIR.mkdir(parents=True, exist_ok=True)

# InsightFace buffalo_s recognition model from HuggingFace (Immich mirror)
REC_URL = REC_MODEL_URL
REC_PATH = MODEL_DIR / "rec_model.onnx"

# Lazy global
_rec_session = None
_rec_lock = threading.Lock()


class MultipleFacesError(ValueError):
    """Raised when a photo contains more than one face of comparable size."""


def _validate_encoding_vector(encoding: list[float]) -> bool:
    return len(encoding) == 512 and bool(np.isfinite(encoding).all()) and float(np.linalg.norm(encoding)) > 0


def ensure_models():
    """Verify the pinned recognition model before loading it."""
    ensure_pinned_model(REC_URL, REC_PATH, REC_MODEL_SHA256, label="MobileFaceNet")


def get_rec_session():
    global _rec_session
    # FastAPI sync handlers run in multiple threads; load only one native session.
    with _rec_lock:
        if _rec_session is None:
            ensure_models()
            _rec_session = ort.InferenceSession(str(REC_PATH), providers=["CPUExecutionProvider"])
    return _rec_session


PhotoInput = Annotated[str, Field(min_length=1, max_length=4_000_000)]


class EncodeRequest(BaseModel):
    photos: list[PhotoInput] = Field(min_length=1, max_length=6)

class PhotoResult(BaseModel):
    index: int
    ok: bool
    reason: str  # "ok" | "no_face" | "multiple_faces" | "decode_error"

class EncodeResponse(BaseModel):
    encoding: list[float]
    photos: list[PhotoResult]
    used_photo_indexes: list[int]

class WorkerEncoding(BaseModel):
    worker_id: str
    encoding: list[float]

class MatchRequest(BaseModel):
    photo: str
    encodings: list[WorkerEncoding]

class MatchResult(BaseModel):
    worker_id: str
    confidence: float

class MatchResponse(BaseModel):
    match: Optional[MatchResult] = None


def require_face_service_key(
    provided_key: Optional[str] = Header(default=None, alias=FACE_SERVICE_KEY_HEADER),
):
    if not get_configured_face_service_key():
        raise HTTPException(503, "Face service authentication is not configured")
    if not is_valid_face_service_key(provided_key):
        raise HTTPException(401, "Unauthorized")


def decode_image(data_url: str) -> np.ndarray:
    """Decode base64 data URL to BGR numpy array."""
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    with Image.open(io.BytesIO(base64.b64decode(data_url, validate=True))) as source:
        if source.width * source.height > 4_000_000 or getattr(source, "n_frames", 1) != 1:
            raise ValueError("Use a single photo no larger than four megapixels")
        img = source.convert("RGB")
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def detect_faces_haar(img: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Detect faces with the OpenCV Haar cascade. Returns list of (x1, y1, x2, y2)."""
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=3, minSize=(30, 30))
    return [(int(x), int(y), int(x + w), int(y + h)) for (x, y, w, h) in faces]


def get_face_crop(img: np.ndarray, reject_competing_faces: bool = False) -> Optional[np.ndarray]:
    """Crop the largest detected face to 112x112.

    Returns None when no face is detected.  With ``reject_competing_faces`` a photo
    containing more than one face of comparable size raises MultipleFacesError instead
    of silently picking one of them.
    """
    faces = detect_faces_haar(img)
    if not faces:
        return None
    if reject_competing_faces and has_competing_faces(faces):
        raise MultipleFacesError(f"{len(faces)} faces detected")

    x1, y1, x2, y2 = largest_face(faces)
    w, h = x2 - x1, y2 - y1
    pad = int(max(w, h) * 0.25)
    x1 = max(0, x1 - pad)
    y1 = max(0, y1 - pad)
    x2 = min(img.shape[1], x2 + pad)
    y2 = min(img.shape[0], y2 + pad)
    crop = img[y1:y2, x1:x2]
    return cv2.resize(crop, (112, 112))


def embed_face_crop(face: np.ndarray) -> list[float]:
    """Get the L2-normalised 512-dim embedding of a 112x112 BGR face crop."""
    session = get_rec_session()

    # Preprocess: BGR -> RGB, normalize to [-1, 1], NCHW
    face_rgb = cv2.cvtColor(face, cv2.COLOR_BGR2RGB)
    face_float = face_rgb.astype(np.float32) / 255.0
    face_float = (face_float - 0.5) / 0.5
    face_chw = np.transpose(face_float, (2, 0, 1))
    batch = np.expand_dims(face_chw, axis=0)

    input_name = session.get_inputs()[0].name
    outputs = session.run(None, {input_name: batch})
    embedding = outputs[0][0]

    norm = np.linalg.norm(embedding)
    if norm > 0:
        embedding = embedding / norm

    return embedding.tolist()


def get_embedding(img: np.ndarray) -> Optional[list[float]]:
    """Embedding of the largest face in ``img``, or None when no face is detected."""
    face = get_face_crop(img)
    if face is None:
        return None
    return embed_face_crop(face)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": SERVICE_VERSION,
        "rec_model": str(REC_PATH),
        "rec_exists": REC_PATH.exists(),
        "min_pairwise_similarity": MIN_PAIRWISE_SIMILARITY,
        "min_good_photos": MIN_GOOD_PHOTOS,
    }


def _inspect_enrollment_photo(index: int, photo: str) -> tuple[PhotoResult, Optional[np.ndarray]]:
    """Classify one enrollment photo and embed it when it is usable."""
    try:
        img = decode_image(photo)
    except Exception as exc:
        print(f"photo {index}: decode failed: {type(exc).__name__}: {exc}")
        return PhotoResult(index=index, ok=False, reason="decode_error"), None

    try:
        face = get_face_crop(img, reject_competing_faces=True)
    except MultipleFacesError:
        return PhotoResult(index=index, ok=False, reason="multiple_faces"), None
    if face is None:
        return PhotoResult(index=index, ok=False, reason="no_face"), None

    embedding = embed_face_crop(face)
    if not _validate_encoding_vector(embedding):
        raise HTTPException(503, "Recognition model returned an invalid embedding")
    return PhotoResult(index=index, ok=True, reason="ok"), np.asarray(embedding, dtype=np.float64)


_REASON_LABELS = {
    "no_face": "no face detected",
    "multiple_faces": "more than one face",
    "decode_error": "image could not be read",
}


def _quality_failure_message(photos: list[PhotoResult], disagreeing_pairs: list[tuple[int, int, float]]) -> str:
    problems = []
    rejected = [p for p in photos if not p.ok]
    if rejected:
        reasons = sorted({_REASON_LABELS.get(p.reason, p.reason) for p in rejected})
        problems.append(f"{len(rejected)} of {len(photos)} photos could not be used ({', '.join(reasons)})")
    if disagreeing_pairs:
        pair_text = ", ".join(f"{i + 1} and {j + 1}" for i, j, _ in disagreeing_pairs)
        problems.append(f"photos {pair_text} do not look like the same person")
    detail = "; ".join(problems) if problems else "not enough usable photos"
    return (
        f"Enrollment needs at least {MIN_GOOD_PHOTOS} clear, matching photos of one face: "
        f"{detail}. Retake the photos facing the camera in good light."
    )


@app.post(
    "/encode",
    response_model=EncodeResponse,
    dependencies=[Depends(require_face_service_key)],
)
def encode(req: EncodeRequest):
    if not req.photos:
        raise HTTPException(400, "No photos provided")

    photos: list[PhotoResult] = []
    usable_indexes: list[int] = []
    embeddings: list[np.ndarray] = []
    for i, photo in enumerate(req.photos):
        try:
            result, embedding = _inspect_enrollment_photo(i, photo)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, "Recognition service is unavailable. Please try again.") from None
        photos.append(result)
        if embedding is not None:
            usable_indexes.append(i)
            embeddings.append(embedding)

    kept_positions, bad_pairs = select_consistent_embeddings(embeddings, MIN_PAIRWISE_SIMILARITY)
    used_photo_indexes = [usable_indexes[k] for k in kept_positions]
    disagreeing_pairs = [(usable_indexes[a], usable_indexes[b], sim) for a, b, sim in bad_pairs]

    if len(used_photo_indexes) < MIN_GOOD_PHOTOS:
        raise HTTPException(
            422,
            detail={
                "message": _quality_failure_message(photos, disagreeing_pairs),
                "photos": [p.model_dump() for p in photos],
                "disagreeing_pairs": [[i, j, sim] for i, j, sim in disagreeing_pairs],
            },
        )

    avg = np.mean([embeddings[k] for k in kept_positions], axis=0)
    norm = float(np.linalg.norm(avg))
    if norm > 0:
        avg = avg / norm
    encoding = [float(x) for x in avg]
    if not _validate_encoding_vector(encoding):
        raise HTTPException(422, "Generated encoding had an invalid dimension")

    return EncodeResponse(encoding=encoding, photos=photos, used_photo_indexes=used_photo_indexes)


@app.post(
    "/match",
    response_model=MatchResponse,
    dependencies=[Depends(require_face_service_key)],
)
def match(req: MatchRequest):
    if not req.encodings:
        return MatchResponse(match=None)

    try:
        img = decode_image(req.photo)
        emb = get_embedding(img)
    except Exception:
        raise HTTPException(422, "Could not process photo")

    if emb is None:
        return MatchResponse(match=None)

    emb_arr = np.array(emb)
    valid_encodings = [w for w in req.encodings if _validate_encoding_vector(w.encoding) and len(w.encoding) == len(emb)]
    if not valid_encodings:
        return MatchResponse(match=None)
    known = np.array([w.encoding for w in valid_encodings])
    known = known / np.linalg.norm(known, axis=1, keepdims=True)

    # Cosine similarity (embeddings are already L2-normalized)
    similarities = known @ emb_arr
    best_idx = int(np.argmax(similarities))
    best_sim = float(similarities[best_idx])

    if best_sim < 0.4:
        return MatchResponse(match=None)

    return MatchResponse(match=MatchResult(
        worker_id=valid_encodings[best_idx].worker_id,
        confidence=round(best_sim, 4),
    ))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5557)
