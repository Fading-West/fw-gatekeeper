#!/usr/bin/env python3
"""Enrollment quality gate coverage for the face service.

Two halves:
- pure unit tests for ``enrollment_quality.select_consistent_embeddings`` (needs numpy only);
- ``POST /encode`` endpoint tests through FastAPI's TestClient (needs fastapi + httpx2).

OpenCV and ONNX Runtime are *not* required: detection and embedding are patched out and
the native modules are stubbed when they are not importable, so no model or image is
needed.  Run with ``python3 face-service/test_encode_quality.py`` or, when the system
interpreter lacks the packages, with a venv interpreter (see face-service/README.md).
"""

import importlib
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

SERVICE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SERVICE_DIR))

TEST_KEY = "test-face-service-key"
KEY_HEADER = {"x-face-service-key": TEST_KEY}
os.environ["FACE_SERVICE_KEY"] = TEST_KEY
os.environ.setdefault("FACE_MODEL_DIR", tempfile.mkdtemp(prefix="face-models-"))
# Exercise the shipped defaults regardless of the developer's shell.
os.environ.pop("MIN_PAIRWISE_SIMILARITY", None)
os.environ.pop("MIN_GOOD_PHOTOS", None)

INSTALL_HINT = (
    "install with `python3 -m pip install numpy fastapi httpx2 Pillow` or run this file "
    "with a venv interpreter (see face-service/README.md)"
)

try:
    import numpy as np
except ImportError:  # pragma: no cover - exercised only on machines without numpy
    np = None


def _stub_native_module(name: str, **attrs) -> None:
    """Register a throwaway module so main.py imports without the native wheel."""
    try:
        importlib.import_module(name)
        return
    except ImportError:
        pass
    module = types.ModuleType(name)
    for attr, value in attrs.items():
        setattr(module, attr, value)
    sys.modules[name] = module


def _load_service():
    """Import main.py for endpoint tests; returns (main, TestClient) or (None, reason)."""
    try:
        from fastapi.testclient import TestClient
    except Exception as exc:  # ImportError, or starlette's RuntimeError when httpx2 is missing
        return None, f"{type(exc).__name__}: {exc}"
    _stub_native_module("cv2", data=types.SimpleNamespace(haarcascades=""))
    _stub_native_module("onnxruntime")
    _stub_native_module("PIL", Image=types.SimpleNamespace())
    return importlib.import_module("main"), TestClient


def unit_vector(*hot: tuple[int, float], dim: int = 512):
    """Deterministic 512-dim unit vector with the given (position, weight) entries."""
    vec = np.zeros(dim)
    for position, weight in hot:
        vec[position] = weight
    return vec / np.linalg.norm(vec)


if np is None:

    class MissingNumpyTests(unittest.TestCase):
        def test_numpy_required(self):
            print(f"WARNING: numpy is not installed; skipping face encode quality tests ({INSTALL_HINT})", file=sys.stderr)
            self.skipTest("numpy is not installed")

else:
    from enrollment_quality import has_competing_faces, select_consistent_embeddings

    class SelectConsistentEmbeddingsTests(unittest.TestCase):
        def test_three_agreeing_embeddings_are_all_kept(self):
            embeddings = [unit_vector((0, 1.0)), unit_vector((0, 1.0), (1, 0.1)), unit_vector((0, 1.0), (2, 0.15))]
            kept, pairs = select_consistent_embeddings(embeddings)
            self.assertEqual(kept, [0, 1, 2])
            self.assertEqual(pairs, [])

        def test_single_outlier_is_dropped_and_reported(self):
            embeddings = [unit_vector((0, 1.0)), unit_vector((5, 1.0)), unit_vector((0, 1.0), (1, 0.1))]
            kept, pairs = select_consistent_embeddings(embeddings)
            self.assertEqual(kept, [0, 2])
            self.assertEqual([(i, j) for i, j, _ in pairs], [(0, 1), (1, 2)])
            for _, _, similarity in pairs:
                self.assertLess(similarity, 0.6)

        def test_mutually_disagreeing_embeddings_keep_nothing(self):
            embeddings = [unit_vector((0, 1.0)), unit_vector((1, 1.0)), unit_vector((2, 1.0))]
            kept, pairs = select_consistent_embeddings(embeddings)
            self.assertEqual(kept, [])
            self.assertEqual([(i, j) for i, j, _ in pairs], [(0, 1), (0, 2), (1, 2)])

        def test_threshold_is_configurable(self):
            embeddings = [unit_vector((0, 1.0)), unit_vector((0, 1.0), (1, 1.0))]  # cosine ~0.707
            self.assertEqual(select_consistent_embeddings(embeddings, min_pairwise=0.6)[0], [0, 1])
            kept, pairs = select_consistent_embeddings(embeddings, min_pairwise=0.9)
            self.assertEqual(kept, [0])
            self.assertEqual(len(pairs), 1)

        def test_empty_and_single_inputs(self):
            self.assertEqual(select_consistent_embeddings([]), ([], []))
            self.assertEqual(select_consistent_embeddings([unit_vector((0, 1.0))]), ([0], []))

    class CompetingFacesTests(unittest.TestCase):
        def test_small_secondary_detection_is_ignored(self):
            self.assertFalse(has_competing_faces([(0, 0, 100, 100), (0, 0, 30, 30)]))

        def test_comparable_secondary_detection_is_competing(self):
            self.assertTrue(has_competing_faces([(0, 0, 100, 100), (200, 0, 270, 70)]))

        def test_single_face_is_never_competing(self):
            self.assertFalse(has_competing_faces([(0, 0, 100, 100)]))

    main, TestClient = _load_service()
    SERVICE_SKIP_REASON = None if main is not None else f"fastapi test client unavailable ({TestClient}); {INSTALL_HINT}"
    if SERVICE_SKIP_REASON:
        print(f"WARNING: skipping /encode endpoint tests: {SERVICE_SKIP_REASON}", file=sys.stderr)

    @unittest.skipIf(main is None, SERVICE_SKIP_REASON or "")
    class EncodeEndpointTests(unittest.TestCase):
        """Photos are plain strings; detection/embedding are patched by photo name.

        - ``noface:*``   -> get_face_crop returns None
        - ``crowd:*``    -> get_face_crop raises MultipleFacesError
        - ``broken:*``   -> decode_image raises
        - anything else  -> a face crop whose embedding comes from ``self.embeddings``
        """

        SAME_PERSON = {
            "a": unit_vector((0, 1.0)),
            "b": unit_vector((0, 1.0), (1, 0.1)),
            "c": unit_vector((0, 1.0), (2, 0.15)),
        }

        def setUp(self):
            self.client = TestClient(main.app)
            self.embeddings = dict(self.SAME_PERSON)

            def decode(photo):
                if photo.startswith("broken:"):
                    raise ValueError("cannot identify image file")
                return photo

            def face_crop(img, reject_competing_faces=False):
                if img.startswith("noface:"):
                    return None
                if img.startswith("crowd:"):
                    raise main.MultipleFacesError("2 faces detected")
                return ("crop", img)

            def embed(face):
                return self.embeddings[face[1]].tolist()

            patchers = [
                patch.object(main, "decode_image", side_effect=decode),
                patch.object(main, "get_face_crop", side_effect=face_crop),
                patch.object(main, "embed_face_crop", side_effect=embed),
            ]
            for patcher in patchers:
                patcher.start()
                self.addCleanup(patcher.stop)

        def encode(self, photos, headers=KEY_HEADER):
            return self.client.post("/encode", json={"photos": photos}, headers=headers)

        def test_no_face_photo_is_excluded_but_enrollment_succeeds(self):
            res = self.encode(["a", "noface:1", "c"])
            self.assertEqual(res.status_code, 200, res.text)
            body = res.json()
            self.assertEqual(body["used_photo_indexes"], [0, 2])
            self.assertEqual([p["reason"] for p in body["photos"]], ["ok", "no_face", "ok"])
            self.assertEqual([p["ok"] for p in body["photos"]], [True, False, True])
            self.assertEqual(len(body["encoding"]), 512)
            self.assertAlmostEqual(float(np.linalg.norm(body["encoding"])), 1.0, places=6)

        def test_too_few_usable_photos_returns_422_with_per_photo_reasons(self):
            res = self.encode(["noface:0", "b", "noface:2"])
            self.assertEqual(res.status_code, 422, res.text)
            detail = res.json()["detail"]
            self.assertIn("no face detected", detail["message"])
            self.assertEqual(
                detail["photos"],
                [
                    {"index": 0, "ok": False, "reason": "no_face"},
                    {"index": 1, "ok": True, "reason": "ok"},
                    {"index": 2, "ok": False, "reason": "no_face"},
                ],
            )
            self.assertEqual(detail["disagreeing_pairs"], [])

        def test_inconsistent_embeddings_return_422_with_disagreeing_pairs(self):
            self.embeddings = {"a": unit_vector((0, 1.0)), "b": unit_vector((1, 1.0)), "c": unit_vector((2, 1.0))}
            res = self.encode(["a", "b", "c"])
            self.assertEqual(res.status_code, 422, res.text)
            detail = res.json()["detail"]
            self.assertIn("do not look like the same person", detail["message"])
            self.assertEqual([pair[:2] for pair in detail["disagreeing_pairs"]], [[0, 1], [0, 2], [1, 2]])
            self.assertTrue(all(p["ok"] for p in detail["photos"]))

        def test_single_outlier_is_dropped_from_the_reference_vector(self):
            self.embeddings["b"] = unit_vector((7, 1.0))
            res = self.encode(["a", "b", "c"])
            self.assertEqual(res.status_code, 200, res.text)
            body = res.json()
            self.assertEqual(body["used_photo_indexes"], [0, 2])
            # Outlier must not leak into the averaged encoding.
            self.assertAlmostEqual(body["encoding"][7], 0.0, places=9)

        def test_multiple_faces_and_decode_errors_are_reported(self):
            res = self.encode(["crowd:0", "broken:1", "c"])
            self.assertEqual(res.status_code, 422, res.text)
            detail = res.json()["detail"]
            self.assertEqual([p["reason"] for p in detail["photos"]], ["multiple_faces", "decode_error", "ok"])
            self.assertIn("more than one face", detail["message"])

        def test_missing_or_wrong_key_is_rejected(self):
            self.assertEqual(self.encode(["a", "b", "c"], headers={}).status_code, 401)
            self.assertEqual(self.encode(["a", "b", "c"], headers={"x-face-service-key": "wrong"}).status_code, 401)

        def test_health_reports_recognition_model_only(self):
            body = self.client.get("/health").json()
            self.assertEqual(body["status"], "ok")
            self.assertEqual(body["version"], "3.1-quality-gate")
            self.assertIn("rec_exists", body)
            self.assertNotIn("det_exists", body)
            self.assertEqual(body["min_good_photos"], 2)
            self.assertEqual(body["min_pairwise_similarity"], 0.6)


if __name__ == "__main__":
    unittest.main()
