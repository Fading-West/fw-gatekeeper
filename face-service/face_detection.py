"""Kiosk-compatible HOG detection without face_recognition's unused models.

face_recognition 1.3.0 uses dlib.get_frontal_face_detector()(rgb, 1),
converts rectangles to CSS coordinates, then trims them to image bounds.
Both kiosk callers halve the RGB frame first, then multiply coordinates by 2.
Keep the order, rounding and inclusive rectangle endpoints identical.
"""
from functools import lru_cache

import cv2
import numpy as np

DETECTOR_VERSION = "dlib-20.0.1-hog-half-upsample1-pad25-v1"


@lru_cache(maxsize=1)
def _hog_detector():
    # Load only the built-in HOG detector, not the CNN/landmark/dlib recognizer
    # loaded as a side effect of importing face_recognition.api.
    import dlib
    return dlib.get_frontal_face_detector()


def detect_faces_hog(img_bgr: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Return full-frame (left, top, right, bottom) boxes, as the kiosk does."""
    if min(img_bgr.shape[:2]) < 2:
        return []
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    small_rgb = cv2.resize(rgb, (0, 0), fx=0.5, fy=0.5)
    height, width = small_rgb.shape[:2]
    return [
        (max(0, rect.left()) * 2, max(0, rect.top()) * 2,
         min(width, rect.right()) * 2, min(height, rect.bottom()) * 2)
        for rect in _hog_detector()(small_rgb, 1)
    ]
