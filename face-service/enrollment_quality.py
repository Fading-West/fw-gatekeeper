"""Pure enrollment-quality helpers for the face service.

Kept free of OpenCV/ONNX imports so the consistency logic can be unit tested
anywhere numpy is available.  Tunables are read from the environment so the
gate can be adjusted on a deployment without rebuilding the image:

- ``MIN_PAIRWISE_SIMILARITY`` (default 0.6): minimum cosine similarity every pair of
  accepted enrollment embeddings must reach to be treated as the same person.
- ``MIN_GOOD_PHOTOS`` (default 2): minimum number of consistent, single-face photos an
  enrollment needs before an encoding is produced.
"""

import os
import math
from typing import Sequence

import numpy as np

# A secondary detection counts as a competing face when its box area is at least this
# fraction of the largest box.  Smaller detections are treated as background/false hits
# and the largest face is used.
COMPETING_FACE_AREA_RATIO = 0.4

FaceBox = tuple[int, int, int, int]  # (x1, y1, x2, y2)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        print(f"Ignoring invalid {name}={raw!r}; using {default}")
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        print(f"Ignoring invalid {name}={raw!r}; using {default}")
        return default


MIN_PAIRWISE_SIMILARITY = _env_float("MIN_PAIRWISE_SIMILARITY", 0.6)
MIN_GOOD_PHOTOS = _env_int("MIN_GOOD_PHOTOS", 2)
if not math.isfinite(MIN_PAIRWISE_SIMILARITY) or not 0 < MIN_PAIRWISE_SIMILARITY <= 1:
    raise ValueError("MIN_PAIRWISE_SIMILARITY must be finite and in (0, 1]")
if not 2 <= MIN_GOOD_PHOTOS <= 6:
    raise ValueError("MIN_GOOD_PHOTOS must be between 2 and 6")


def face_area(box: FaceBox) -> int:
    x1, y1, x2, y2 = box
    return max(0, x2 - x1) * max(0, y2 - y1)


def largest_face(faces: Sequence[FaceBox]) -> FaceBox:
    return max(faces, key=face_area)


def has_competing_faces(faces: Sequence[FaceBox], area_ratio: float = COMPETING_FACE_AREA_RATIO) -> bool:
    """True when more than one detection is large enough to be a real, competing face."""
    if len(faces) < 2:
        return False
    areas = sorted((face_area(face) for face in faces), reverse=True)
    if areas[0] <= 0:
        return False
    return areas[1] >= areas[0] * area_ratio


def _unit_rows(embeddings: Sequence[np.ndarray]) -> np.ndarray:
    matrix = np.asarray([np.asarray(vec, dtype=np.float64) for vec in embeddings])
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def _failing_pairs(sims: np.ndarray, indexes: Sequence[int], min_pairwise: float) -> list[tuple[int, int, float]]:
    pairs = []
    for position, i in enumerate(indexes):
        for j in indexes[position + 1:]:
            similarity = float(sims[i, j])
            if similarity < min_pairwise:
                pairs.append((i, j, round(similarity, 4)))
    return pairs


def select_consistent_embeddings(
    embeddings: list[np.ndarray],
    min_pairwise: float = MIN_PAIRWISE_SIMILARITY,
) -> tuple[list[int], list[tuple[int, int, float]]]:
    """Pick the embeddings that all agree pairwise at >= ``min_pairwise`` cosine.

    Returns ``(kept_indexes, disagreeing_pairs)`` where each pair is
    ``(i, j, similarity)`` taken from the full input.  If every pair agrees, all
    indexes are kept.  Otherwise the embedding with the lowest mean similarity to the
    others is dropped and the remainder re-checked once; if they still disagree the
    kept list is empty.
    """
    count = len(embeddings)
    if count == 0:
        return [], []
    if not math.isfinite(min_pairwise) or not 0 < min_pairwise <= 1:
        raise ValueError("Invalid enrollment similarity threshold")
    for vector in embeddings:
        vec = np.asarray(vector)
        if vec.shape != (512,) or not np.isfinite(vec).all() or np.linalg.norm(vec) == 0:
            raise ValueError("Invalid recognition embedding")
    if count == 1:
        return [0], []

    sims = _unit_rows(embeddings) @ _unit_rows(embeddings).T
    all_indexes = list(range(count))
    disagreeing = _failing_pairs(sims, all_indexes, min_pairwise)
    if not disagreeing:
        return all_indexes, []

    # Mean similarity to the *other* embeddings (exclude the diagonal).  On a tie drop
    # the later capture so the earliest photo is kept deterministically.
    mean_to_others = (sims.sum(axis=1) - np.diag(sims)) / (count - 1)
    lowest = np.flatnonzero(np.isclose(mean_to_others, mean_to_others.min()))
    outlier = int(lowest[-1])
    remaining = [i for i in all_indexes if i != outlier]
    if _failing_pairs(sims, remaining, min_pairwise):
        return [], disagreeing
    return remaining, disagreeing
