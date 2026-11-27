"""Standalone diagnostic tests with a scripted camera and no native models."""

from contextlib import contextmanager
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch


@contextmanager
def scripted_diagnostic(frame_results):
    cap = Mock()
    cap.isOpened.return_value = True
    liveness = Mock()
    liveness.update.side_effect = [True, False]
    liveness.get_ear.return_value = 0.25
    cv2 = ModuleType("cv2")
    cv2.VideoCapture = Mock(return_value=cap)
    cv2.rectangle = Mock()
    cv2.putText = Mock()
    cv2.CAP_PROP_FRAME_WIDTH = 3
    cv2.CAP_PROP_FRAME_HEIGHT = 4
    cv2.FONT_HERSHEY_SIMPLEX = 0
    dependencies = {
        "cv2": cv2,
        "face_recognition": ModuleType("face_recognition"),
        "config": SimpleNamespace(CAMERA_INDEX=0, CAMERA_WIDTH=640, CAMERA_HEIGHT=480),
        "liveness": SimpleNamespace(LivenessChecker=lambda: liveness),
    }
    spec = spec_from_file_location("liveness_check", Path(__file__).parent / "tools/liveness_check.py")
    diagnostic = module_from_spec(spec)
    with patch.dict(sys.modules, dependencies):
        spec.loader.exec_module(diagnostic)

    frame = Mock(shape=(480, 640, 3))
    frame.copy.return_value = frame
    samples = []

    def read():
        if len(samples) == len(frame_results):
            diagnostic._running = False
            return False, None
        return frame_results[len(samples)], frame

    def record_state(_delay):
        if diagnostic._running:
            with diagnostic.app.test_client() as client:
                samples.append((client.get("/status").get_json(), diagnostic._frame))

    cap.read.side_effect = read
    with patch.object(diagnostic, "_detect_face", return_value=(2, 20, 20, 2)), \
         patch.object(diagnostic, "time", SimpleNamespace(sleep=record_state)):
        diagnostic._camera_loop()
    yield diagnostic, samples, liveness


class LivenessDiagnosticCameraTest(unittest.TestCase):
    def test_lost_frames_clear_the_confirmation_until_a_fresh_blink(self):
        with scripted_diagnostic([True, False, False, True]) as (_, samples, liveness):
            confirmed, unavailable, still_unavailable, recovered = samples
            self.assertTrue(confirmed[0]["liveness"])
            for status, frame in (unavailable, still_unavailable):
                self.assertFalse(status["liveness"])
                self.assertFalse(status["face_detected"])
                self.assertEqual(status["ear"], 0.0)
                self.assertFalse(status["camera_ok"])
                self.assertIsNone(frame)
            self.assertTrue(recovered[0]["camera_ok"])
            self.assertTrue(recovered[0]["face_detected"])
            self.assertFalse(recovered[0]["liveness"])
            self.assertIsNotNone(recovered[1])
            liveness.reset.assert_called()


if __name__ == "__main__":
    unittest.main()
