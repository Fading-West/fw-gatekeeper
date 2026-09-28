"""Temporal face matching whose accepted identity must match the current frame."""
from collections import deque
import numpy as np


def cosine_similarity(a, b):
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if a.ndim != 1 or b.ndim != 1 or a.shape != b.shape:
        raise ValueError('Face embeddings must have matching vector dimensions')
    if not np.isfinite(a).all() or not np.isfinite(b).all():
        raise ValueError('Face embeddings must contain finite values')
    denominator = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.dot(a, b) / denominator) if denominator > 0 else 0.0


class FreshFaceMatcher:
    """Smooth only consecutive accepted frames of one immutable roster identity.

    A high historical score cannot rescue a current-frame rejection. A change
    of worker, roster encoding, missing face, or frame sequence clears history.
    """
    def __init__(self, window, threshold, max_gap_seconds=2.0):
        self._history = deque(maxlen=max(1, int(window)))
        self.threshold = threshold
        self.max_gap_seconds = max_gap_seconds
        self.clear()

    def clear(self):
        self._history.clear()
        self._identity = None
        self._roster_encoding = None
        self._frame_ts = None

    def __len__(self):
        return len(self._history)

    def match(self, embedding, compatible, worker_ids, server_ids, frame_ts):
        """Return sorted (score, roster_index) pairs and current-frame approval."""
        def rank(vector):
            return sorted(((cosine_similarity(known, vector), index) for index, known in compatible), reverse=True)
        try:
            raw_scores = rank(embedding)
        except ValueError:
            self.clear()
            raise
        if not raw_scores:
            self.clear()
            return [], False
        raw_score, raw_index = raw_scores[0]
        # An exact tie provides no evidence for choosing either identity.
        ambiguous = len(raw_scores) > 1 and abs(raw_score - raw_scores[1][0]) < 1e-9
        if raw_score < self.threshold or ambiguous:
            self.clear()
            return raw_scores, False
        known = next(known for index, known in compatible if index == raw_index)
        worker_id = worker_ids[raw_index]
        identity = (worker_id, server_ids.get(worker_id), id(known))
        stale = self._frame_ts is not None and (
            frame_ts <= self._frame_ts or frame_ts - self._frame_ts > self.max_gap_seconds
        )
        if identity != self._identity or stale:
            self.clear()
        self._identity, self._frame_ts = identity, frame_ts
        self._roster_encoding = known  # retain the object so its identity cannot be reused
        self._history.append(np.array(embedding, copy=True))
        scores = rank(np.mean(np.stack(self._history), axis=0))
        # Averaging may change the nearest neighbor; it never supplies evidence
        # for a worker that the current, unaveraged frame did not identify.
        tied = len(scores) > 1 and abs(scores[0][0] - scores[1][0]) < 1e-9
        approved = scores[0][1] == raw_index and scores[0][0] >= self.threshold and not tied
        return scores, approved
