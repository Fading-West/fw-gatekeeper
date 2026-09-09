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

logger = logging.getLogger(__name__)


class FaceRecognizer:
    """Loads known workers and exposes a thread-safe snapshot for matching."""

    def __init__(self):
        self._lock = threading.Lock()
        self._encodings: list[np.ndarray] = []
        self._ids: list[int] = []
        self._names: list[str] = []
        self._server_ids: dict[int, str | None] = {}

        self.liveness_checker = None

        # Only load the (large) landmark model when this kiosk actually
        # enforces blink verification; it is off by default.
        if getattr(config, "LIVENESS_REQUIRED", False):
            try:
                self.liveness_checker = LivenessChecker()
            except FileNotFoundError as exc:
                logger.error(str(exc))
                logger.error(
                    "Blink verification is unavailable; clock events will be recorded "
                    "without liveness and the kiosk will report itself degraded."
                )

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
            self._encodings, self._ids, self._names, self._server_ids = database.get_worker_roster()
        logger.info("Loaded %d known face encodings", len(self._encodings))

    def reload_faces(self):
        self.load_faces()

    def snapshot_known_faces(self):
        """Return a consistent (encodings, ids, names) copy for matching."""
        with self._lock:
            return list(self._encodings), list(self._ids), list(self._names)

    def server_id_for(self, worker_id: int) -> str | None:
        """Server id for a roster worker as of the last load.

        A match can only come from this roster, so this stays valid even if
        the sync thread has already deleted the worker row (deactivation)
        and the roster has not been reloaded yet."""
        with self._lock:
            return self._server_ids.get(worker_id)
