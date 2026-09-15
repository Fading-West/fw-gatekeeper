"""Known-worker roster and optional blink-liveness for the kiosk.

Matching itself lives in main.py (MobileFaceNet ONNX 512-dim embeddings,
cosine similarity). This module owns the thread-safe roster of known worker
encodings loaded from SQLite, plus the optional LivenessChecker used when
LIVENESS_REQUIRED is enabled.
"""

from __future__ import annotations

import logging
import threading

import numpy as np

import config
import database
from embeddings import EXPECTED_EMBEDDING_DIM
from liveness import LivenessChecker
from liveness_policy import LivenessPolicy

logger = logging.getLogger(__name__)


class FaceRecognizer:
    """Loads known workers and exposes a thread-safe snapshot for matching."""

    def __init__(self):
        self._lock = threading.Lock()
        self._encodings: list[np.ndarray] = []
        self._ids: list[int] = []
        self._names: list[str] = []
        self._server_ids: dict[int, str | None] = {}

        self.liveness_policy = LivenessPolicy(
            required=getattr(config, "LIVENESS_REQUIRED", False), factory=LivenessChecker,
        )
        self.liveness_policy.refresh()

    @property
    def liveness_checker(self):
        return self.liveness_policy.refresh()

    @property
    def known_count(self) -> int:
        return len(self._encodings)

    @property
    def usable_count(self) -> int:
        """Roster rows whose encoding dimension matches the kiosk model.

        Legacy 128-dim rows can still exist in deployed databases; they are
        skipped at match time and must not count as recognition-ready."""
        with self._lock:
            return sum(1 for enc in self._encodings if len(enc) == EXPECTED_EMBEDDING_DIM)

    def load_faces(self):
        """Load all worker encodings from SQLite."""
        with self._lock:
            try:
                self._encodings, self._ids, self._names, self._server_ids = database.get_worker_roster()
            except Exception:
                # The cached roster may now include deactivated workers. Fail
                # closed until a later successful reload restores current data.
                self._encodings, self._ids, self._names, self._server_ids = [], [], [], {}
                raise
        logger.info("Loaded %d known face encodings", len(self._encodings))

    def reload_faces(self):
        self.load_faces()

    def snapshot_known_faces(self):
        """Return one consistent roster snapshot for matching and attribution."""
        with self._lock:
            return (
                list(self._encodings),
                list(self._ids),
                list(self._names),
                dict(self._server_ids),
            )
