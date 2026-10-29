"""Drive the production detection loop through transient detector faults."""
import ast
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

import numpy as np


SOURCE = ast.parse(Path(__file__).with_name("main.py").read_text())
RUN = next(node for node in SOURCE.body if isinstance(node, ast.FunctionDef) and node.name == "_run")
DETECTOR = next(node for node in RUN.body if isinstance(node, ast.FunctionDef) and node.name == "detection_loop")
FACE = (0, 2, 2, 0)


class FramesExhausted(Exception):
    pass


class DetectionErrorRecoveryTests(unittest.TestCase):
    def run_detector(self, steps, generations=None, camera_generation=0, standing_reason=None):
        """Each step is the detector outcome for one frame: "error", "empty",
        "face" (embedding succeeds) or "model_error" (ONNX raises)."""
        steps = list(steps)
        expected_errors = steps.count("error")
        generations = list(generations or [camera_generation] * len(steps))
        health = {"model_ok": True, "degraded_reason": standing_reason, "camera_ok": True}
        history = []
        pending = [None]
        current = [None]

        def face_locations(_image, model):
            current[0] = steps.pop(0)
            if current[0] == "error":
                raise RuntimeError("transient dlib failure")
            return [] if current[0] == "empty" else [FACE]

        def embed_face(_frame, _loc):
            if current[0] == "model_error":
                raise RuntimeError("onnx failure")
            return np.ones(512, dtype=np.float32)

        def update_health(**fields):
            health.update(fields)
            history.append(dict(health))

        def sleep(_seconds):
            if not generations:
                raise FramesExhausted()
            pending[0] = (np.zeros((4, 4, 3), np.uint8), np.zeros((4, 4, 3), np.uint8),
                          1.0, generations.pop(0))

        matcher = mock.MagicMock()
        matcher.match.return_value = ([(0.2, 0)], False)
        recognizer = mock.Mock()
        recognizer.snapshot_known_faces.return_value = ([np.ones(512)], [1], ["Alex"], {})
        context = {
            "logger": mock.Mock(), "FreshFaceMatcher": lambda *args: matcher,
            "config": SimpleNamespace(RECOGNITION_EMBEDDING_WINDOW=3, RECOGNITION_MATCH_THRESHOLD=.45,
                                      RECOGNITION_MIN_MARGIN=.05, RECOGNITION_NEAR_MISS_MARGIN=.05,
                                      RECOGNITION_MODEL_VERSION="test"),
            "os": SimpleNamespace(environ={}), "Path": Path, "np": np,
            "detect_lock": threading.Lock(), "pending_frame": pending,
            "camera_generation": [camera_generation],
            "time": SimpleNamespace(sleep=sleep, monotonic=lambda: 1.0),
            "model_recovery": SimpleNamespace(ready=True), "publish_detection": lambda result, generation: True,
            "cv2": SimpleNamespace(resize=lambda image, size, fx, fy: image),
            "fr": SimpleNamespace(face_locations=face_locations), "web_app": SimpleNamespace(update_health=update_health),
            "detect_count": [0], "_empty_recognition_result": lambda *args, **kwargs: {},
            "largest_face": lambda locs: locs[0], "embed_face": embed_face, "EXPECTED_EMBEDDING_DIM": 512,
            "recognizer": recognizer, "has_minimum_margin": lambda scores, margin: True,
            "base_degraded_reason": lambda: standing_reason,
        }
        exec(compile(ast.Module(body=[DETECTOR], type_ignores=[]), "production-detector", "exec"), context)
        with self.assertRaises(FramesExhausted):
            context["detection_loop"]()
        self.assertEqual(steps, [], "every frame reached the detector")
        detection_errors = [call for call in context["logger"].error.call_args_list
                            if call.args[0].startswith("Detection error")]
        self.assertEqual(len(detection_errors), expected_errors, "only scripted detector faults")
        return health, history

    def test_empty_door_after_transient_detection_error_restores_model_health(self):
        health, history = self.run_detector(["error", "empty", "empty"])
        self.assertIn({"model_ok": False, "degraded_reason": "detection_error"},
                      [{key: h[key] for key in ("model_ok", "degraded_reason")} for h in history])
        self.assertIs(health["model_ok"], True)
        self.assertIsNone(health["degraded_reason"])

    def test_recovery_keeps_standing_roster_reason(self):
        health, _ = self.run_detector(["error", "empty"], standing_reason="no_workers_synced")
        self.assertIs(health["model_ok"], True)
        self.assertEqual(health["degraded_reason"], "no_workers_synced")

    def test_detector_recovery_does_not_clear_onnx_fault(self):
        health, _ = self.run_detector(["model_error", "empty", "empty"])
        self.assertEqual((health["model_ok"], health["degraded_reason"]), (False, "model_error"))

    def test_detector_recovery_restores_onnx_fault_masked_by_detection_error(self):
        health, _ = self.run_detector(["model_error", "error", "empty"])
        self.assertEqual((health["model_ok"], health["degraded_reason"]), (False, "model_error"))
        health, _ = self.run_detector(["model_error", "error", "face", "empty"])
        self.assertEqual((health["model_ok"], health["degraded_reason"]), (True, None))

    def test_frame_from_retired_camera_does_not_clear_fault(self):
        health, history = self.run_detector(["error", "empty"], generations=[1, 0], camera_generation=1)
        # The detection error came from the current camera; a stale generation-0
        # frame proves nothing about it, so no health write follows it.
        self.assertEqual((history[-1]["model_ok"], history[-1]["degraded_reason"]), (False, "detection_error"))
        health, _ = self.run_detector(["error", "empty", "empty"], generations=[1, 0, 1], camera_generation=1)
        self.assertEqual((health["model_ok"], health["degraded_reason"]), (True, None))


if __name__ == "__main__":
    unittest.main()
