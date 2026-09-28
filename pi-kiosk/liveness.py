"""Blink-based liveness detection using dlib facial landmarks."""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Iterable

import cv2
import dlib
import numpy as np
from scipy.spatial.distance import euclidean

import config

logger = logging.getLogger(__name__)

_MODEL_URL = "http://dlib.net/files/shape_predictor_68_face_landmarks.dat.bz2"


def _shape_to_np(shape: dlib.full_object_detection) -> np.ndarray:
    points = np.zeros((68, 2), dtype=np.float32)
    for idx in range(68):
        points[idx] = (shape.part(idx).x, shape.part(idx).y)
    return points


def _eye_aspect_ratio(eye_points: Iterable[np.ndarray]) -> float:
    p1, p2, p3, p4, p5, p6 = eye_points
    vertical_1 = euclidean(p2, p6)
    vertical_2 = euclidean(p3, p5)
    horizontal = euclidean(p1, p4)
    if horizontal == 0:
        return 0.0
    return (vertical_1 + vertical_2) / (2.0 * horizontal)


class LivenessChecker:
    """Tracks blink events over a short window to verify a live person."""

    def __init__(
        self,
        predictor_path: str = config.SHAPE_PREDICTOR_PATH,
        ear_threshold: float = config.LIVENESS_EAR_THRESHOLD,
        blink_frames: int = config.LIVENESS_BLINK_FRAMES,
        timeout_sec: int = config.LIVENESS_TIMEOUT_SEC,
    ):
        self.ear_threshold = ear_threshold
        self.blink_frames = max(1, int(blink_frames))
        self.timeout_sec = max(1, int(timeout_sec))
        self.predictor_path = predictor_path

        path = Path(self.predictor_path)
        if not path.exists():
            raise FileNotFoundError(self._missing_model_message(path))

        self._predictor = dlib.shape_predictor(str(path))
        self.failed = False
        self._current_ear = 0.0
        self.reset()

    @staticmethod
    def _missing_model_message(path: Path) -> str:
        return (
            "Missing liveness model file: "
            f"{path}. Download shape_predictor_68_face_landmarks.dat from {_MODEL_URL} "
            f"and place it at {path}."
        )

    def reset(self):
        """Reset blink/liveness state for a new attempt."""
        self._window_start = time.monotonic()
        self._alive = False
        self._blink_count = 0
        self._low_ear_frames = 0
        self._current_ear = 0.0

    def is_alive(self) -> bool:
        """Return whether liveness has been confirmed in the active window."""
        return self._alive

    def get_ear(self) -> float:
        """Return latest Eye Aspect Ratio value for debug overlays."""
        return float(self._current_ear)

    def _reset_window_if_expired(self):
        if self._alive:
            return
        elapsed = time.monotonic() - self._window_start
        if elapsed > self.timeout_sec:
            self._window_start = time.monotonic()
            self._blink_count = 0
            self._low_ear_frames = 0

    def update(self, frame: np.ndarray, face_location: tuple[int, int, int, int], frame_check=None) -> bool:
        """Feed a frame + face box. Returns True once liveness is confirmed.

        frame_check, when given, is called as frame_check(frame, face_location)
        for every frame that would advance blink state (closed-eye frames and
        the completing open-eye frame). If it returns False the whole attempt
        resets, so no frame from an unverified face can contribute to a blink.
        """
        self._reset_window_if_expired()
        if frame is None or face_location is None:
            return False

        top, right, bottom, left = [int(v) for v in face_location]
        height, width = frame.shape[:2]
        top = max(0, min(top, height - 1))
        bottom = max(0, min(bottom, height - 1))
        left = max(0, min(left, width - 1))
        right = max(0, min(right, width - 1))
        if right <= left or bottom <= top:
            return False

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        rect = dlib.rectangle(left, top, right, bottom)

        try:
            shape = self._predictor(gray, rect)
        except RuntimeError:
            # Surface a broken predictor to the kiosk policy so it can block
            # attendance and reload the model instead of timing out forever.
            self.failed = True
            self.reset()
            logger.warning("Liveness predictor failed for supplied face rectangle.")
            return False

        landmarks = _shape_to_np(shape)
        left_eye = landmarks[36:42]
        right_eye = landmarks[42:48]
        left_ear = _eye_aspect_ratio(left_eye)
        right_ear = _eye_aspect_ratio(right_eye)
        self._current_ear = (left_ear + right_ear) / 2.0

        if self._current_ear < self.ear_threshold:
            if frame_check is not None and not frame_check(frame, face_location):
                self.reset()
                return False
            self._low_ear_frames += 1
        else:
            if self._low_ear_frames >= self.blink_frames:
                if frame_check is not None and not frame_check(frame, face_location):
                    self.reset()
                    return False
                self._blink_count += 1
                self._alive = True
            self._low_ear_frames = 0

        self._reset_window_if_expired()
        return self._alive
