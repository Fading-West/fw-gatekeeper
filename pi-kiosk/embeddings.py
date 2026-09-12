"""MobileFaceNet ONNX face embeddings (512-dim), shared by the kiosk scan
loop and the local enrollment CLI.

Every code path that writes or matches encodings must use this module so the
roster never mixes embedding models: a 128-dim dlib enrollment would make the
512-dim scan path reject every worker as an encoding mismatch.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from model_pinning import MODEL_COMMIT, REC_MODEL_SHA256, REC_MODEL_URL, ensure_pinned_model

logger = logging.getLogger(__name__)

# REC_MODEL_URL / REC_MODEL_SHA256 pin immich-app/buffalo_s @ MODEL_COMMIT.
# Re-pin instructions live in model_pinning.py (kiosk and face service must match).
REC_MODEL_PATH = Path("data/models/mobilefacenet.onnx")
EXPECTED_EMBEDDING_DIM = 512

_rec_session = None


def ensure_rec_model() -> bool:
    """Download the pinned MobileFaceNet model if missing and verify its digest.

    A cached file that fails verification is deleted and re-fetched; a download
    that fails verification is discarded. Returns False (after logging) when the
    model cannot be made available, so callers keep the kiosk degraded rather
    than scanning with an unknown model.
    """
    try:
        ensure_pinned_model(
            REC_MODEL_URL,
            REC_MODEL_PATH,
            REC_MODEL_SHA256,
            label=f"MobileFaceNet (buffalo_s@{MODEL_COMMIT[:12]})",
        )
    except Exception as exc:
        logger.error("MobileFaceNet model unavailable: %s", exc)
        return False
    return True


def model_ready() -> bool:
    """Ensure the model file exists, matches its pinned digest, AND loads.

    A present-but-corrupt/truncated file must not report a working scanner;
    this also warms the session so the first scan doesn't pay the load cost.
    """
    try:
        get_rec_session()
        return True
    except Exception as exc:
        logger.error("Recognition model not ready: %s", exc)
        return False


def get_rec_session():
    global _rec_session
    if _rec_session is None:
        import onnxruntime as ort
        if not ensure_rec_model():
            raise RuntimeError("Recognition model unavailable")
        try:
            _rec_session = ort.InferenceSession(str(REC_MODEL_PATH), providers=["CPUExecutionProvider"])
            logger.info("MobileFaceNet ONNX session loaded")
        except Exception as exc:
            raise RuntimeError(f"Recognition model failed to initialize: {exc}") from exc
    return _rec_session


def normalize_embedding(embedding: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(embedding)
    if norm > 0:
        return embedding / norm
    return embedding


def get_512_embedding(face_crop_bgr: np.ndarray) -> np.ndarray:
    """Get a normalized 512-dim MobileFaceNet embedding from a BGR face crop."""
    session = get_rec_session()
    face = cv2.resize(face_crop_bgr, (112, 112))
    face_rgb = cv2.cvtColor(face, cv2.COLOR_BGR2RGB)
    face_float = face_rgb.astype(np.float32) / 255.0
    face_float = (face_float - 0.5) / 0.5
    face_chw = np.transpose(face_float, (2, 0, 1))
    batch = np.expand_dims(face_chw, axis=0)
    input_name = session.get_inputs()[0].name
    outputs = session.run(None, {input_name: batch})
    return normalize_embedding(outputs[0][0])


def embed_face(frame_bgr: np.ndarray, face_loc: tuple[int, int, int, int], pad_ratio: float = 0.25) -> Optional[np.ndarray]:
    """Crop the face (with padding) from a BGR frame and embed it.

    Returns None when the crop is empty; raises when the model is unavailable.
    """
    top, right, bottom, left = face_loc
    height, width = frame_bgr.shape[:2]
    pad = int(max(bottom - top, right - left) * pad_ratio)
    y1 = max(0, top - pad)
    y2 = min(height, bottom + pad)
    x1 = max(0, left - pad)
    x2 = min(width, right + pad)
    face_crop = frame_bgr[y1:y2, x1:x2]
    if face_crop.size == 0:
        return None
    return get_512_embedding(face_crop)
