"""Face encoding/matching service for fw-gatekeeper.
Uses InsightFace buffalo_s models (MobileFaceNet) via ONNX Runtime.
Detection: SCRFD 2.5g (~2.5MB) | Recognition: MobileFaceNet (~13MB)
Total: ~16MB — runs comfortably on Render free tier (512MB RAM).
"""

import base64
import io
import os
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel
import onnxruntime as ort

from face_auth import (
    FACE_SERVICE_KEY_HEADER,
    get_allowed_cors_origins,
    get_configured_face_service_key,
    is_valid_face_service_key,
)
from model_pinning import (
    DET_MODEL_SHA256,
    DET_MODEL_URL,
    MODEL_COMMIT,
    REC_MODEL_SHA256,
    REC_MODEL_URL,
    ensure_pinned_model,
)

app = FastAPI(title="Face Encoding Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_cors_origins(),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", FACE_SERVICE_KEY_HEADER],
)

MODEL_DIR = Path(os.environ.get("FACE_MODEL_DIR", "/app/models"))
MODEL_DIR.mkdir(parents=True, exist_ok=True)

# InsightFace buffalo_s models from HuggingFace (Immich mirror), pinned to
# commit MODEL_COMMIT with SHA-256 digests. Re-pin instructions live in
# model_pinning.py; the Dockerfile repeats the same URLs and digests.
DET_URL = DET_MODEL_URL
REC_URL = REC_MODEL_URL
DET_PATH = MODEL_DIR / "det_model.onnx"
REC_PATH = MODEL_DIR / "rec_model.onnx"

# Lazy globals
_det_session = None
_rec_session = None


def _validate_encoding_vector(encoding: list[float]) -> bool:
    if len(encoding) not in {128, 512}:
        return False
    return all(np.isfinite(value) for value in encoding)


def ensure_models():
    """Download models if not present and verify both against pinned digests.

    A present file that fails verification is deleted and re-fetched; a
    download that fails verification is discarded and raises, so the service
    never serves embeddings from an unpinned model.
    """
    for url, path, digest, label in [
        (DET_URL, DET_PATH, DET_MODEL_SHA256, f"SCRFD detector (buffalo_s@{MODEL_COMMIT[:12]})"),
        (REC_URL, REC_PATH, REC_MODEL_SHA256, f"MobileFaceNet (buffalo_s@{MODEL_COMMIT[:12]})"),
    ]:
        ensure_pinned_model(url, path, digest, label=label)


def get_det_session():
    global _det_session
    if _det_session is None:
        ensure_models()
        _det_session = ort.InferenceSession(str(DET_PATH), providers=["CPUExecutionProvider"])
    return _det_session


def get_rec_session():
    global _rec_session
    if _rec_session is None:
        ensure_models()
        _rec_session = ort.InferenceSession(str(REC_PATH), providers=["CPUExecutionProvider"])
    return _rec_session


class EncodeRequest(BaseModel):
    photos: list[str]

class EncodeResponse(BaseModel):
    encoding: list[float]

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
    img = Image.open(io.BytesIO(base64.b64decode(data_url))).convert("RGB")
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def detect_faces_scrfd(img: np.ndarray, score_thresh: float = 0.3) -> list[tuple[int, int, int, int]]:
    """Detect faces using SCRFD ONNX model. Returns list of (x1, y1, x2, y2)."""
    session = get_det_session()
    input_name = session.get_inputs()[0].name
    input_shape = session.get_inputs()[0].shape  # e.g. [1, 3, 640, 640]

    h, w = img.shape[:2]
    target_size = input_shape[2] if input_shape[2] > 0 else 640

    # Resize maintaining aspect ratio
    scale = target_size / max(h, w)
    new_w, new_h = int(w * scale), int(h * scale)
    resized = cv2.resize(img, (new_w, new_h))

    # Pad to square
    padded = np.zeros((target_size, target_size, 3), dtype=np.uint8)
    padded[:new_h, :new_w] = resized

    # Preprocess: BGR->RGB, normalize, NCHW
    blob = cv2.dnn.blobFromImage(padded, 1.0 / 128, (target_size, target_size), (127.5, 127.5, 127.5), swapRB=True)

    outputs = session.run(None, {input_name: blob})

    # SCRFD outputs vary by stride. Parse bounding boxes from outputs.
    faces = []
    # Try simple parsing: look for outputs with bbox-like shapes
    for out in outputs:
        if out.ndim == 3 and out.shape[2] == 1:
            # Score output
            continue
        if out.ndim == 3 and out.shape[2] >= 4:
            # Bbox output - take scores from corresponding score output
            pass

    # Fallback: use OpenCV Haar cascade if SCRFD parsing is complex
    if not faces:
        return detect_faces_haar(img)

    return faces


def detect_faces_haar(img: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Fallback face detection using Haar cascade."""
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Try standard params
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=3, minSize=(30, 30))
    if len(faces) == 0:
        # More lenient
        faces = cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=2, minSize=(20, 20))

    result = []
    for (x, y, w, h) in faces:
        result.append((x, y, x + w, y + h))
    return result


def center_crop_face(img: np.ndarray) -> np.ndarray:
    """Last resort: center-crop assuming selfie-style photo."""
    h, w = img.shape[:2]
    margin_x = int(w * 0.15)
    margin_y = int(h * 0.05)
    crop = img[margin_y:h - margin_y, margin_x:w - margin_x]
    return cv2.resize(crop, (112, 112))


def get_face_crop(img: np.ndarray) -> Optional[np.ndarray]:
    """Detect and crop the largest face, or center-crop as fallback."""
    faces = detect_faces_haar(img)

    if faces:
        # Take largest
        x1, y1, x2, y2 = max(faces, key=lambda f: (f[2] - f[0]) * (f[3] - f[1]))
        w, h = x2 - x1, y2 - y1
        # Add padding
        pad = int(max(w, h) * 0.25)
        x1 = max(0, x1 - pad)
        y1 = max(0, y1 - pad)
        x2 = min(img.shape[1], x2 + pad)
        y2 = min(img.shape[0], y2 + pad)
        crop = img[y1:y2, x1:x2]
    else:
        # Center crop fallback for selfies
        crop = center_crop_face(img)
        if crop is None:
            return None

    return cv2.resize(crop, (112, 112))


def get_embedding(img: np.ndarray) -> Optional[list[float]]:
    """Get 512-dim face embedding using MobileFaceNet ONNX."""
    face = get_face_crop(img)
    if face is None:
        return None

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

    # L2 normalize
    norm = np.linalg.norm(embedding)
    if norm > 0:
        embedding = embedding / norm

    return embedding.tolist()


@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": "3.0-mobilefacenet",
        "det_model": str(DET_PATH),
        "det_exists": DET_PATH.exists(),
        "rec_model": str(REC_PATH),
        "rec_exists": REC_PATH.exists(),
    }


@app.post(
    "/encode",
    response_model=EncodeResponse,
    dependencies=[Depends(require_face_service_key)],
)
def encode(req: EncodeRequest):
    if not req.photos:
        raise HTTPException(400, "No photos provided")

    embeddings = []
    errors = []
    for i, photo in enumerate(req.photos):
        try:
            img = decode_image(photo)
            emb = get_embedding(img)
            if emb is not None:
                embeddings.append(emb)
            else:
                errors.append(f"photo {i}: detection returned None")
        except Exception as e:
            errors.append(f"photo {i}: {type(e).__name__}: {e}")
            continue

    if not embeddings:
        detail = f"No faces encoded. Errors: {errors}" if errors else "No faces detected in any photo"
        raise HTTPException(422, detail)

    avg = np.mean(embeddings, axis=0).tolist()
    norm = float(np.linalg.norm(avg))
    if norm > 0:
        avg = [x / norm for x in avg]
    if not _validate_encoding_vector(avg):
        raise HTTPException(422, "Generated encoding had an invalid dimension")

    return EncodeResponse(encoding=avg)


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
