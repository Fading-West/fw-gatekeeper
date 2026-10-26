"""Drive production frame handoff and attendance freshness without camera hardware."""
import ast
from datetime import datetime, timezone
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

from kiosk_policy import require_kiosk_action_type
from scan_freshness import is_fresh_scan


SOURCE = ast.parse(Path(__file__).with_name("main.py").read_text())
RUN = next(node for node in SOURCE.body if isinstance(node, ast.FunctionDef) and node.name == "_run")
DETECTOR = next(node for node in RUN.body if isinstance(node, ast.FunctionDef) and node.name == "detection_loop")
# Execute the actual producer/dequeue lock blocks, including any queue policy.
FEED = next(node for node in ast.walk(RUN) if isinstance(node, ast.With)
            and any(isinstance(child, ast.Assign)
                    and any(ast.unparse(target) == "pending_frame[0]" for target in child.targets)
                    and isinstance(child.value, ast.Tuple) for child in ast.walk(node)))
TAKE = next(node for node in ast.walk(DETECTOR) if isinstance(node, ast.With))
WRITER = next(node for node in RUN.body if isinstance(node, ast.FunctionDef) and node.name == "record_clock")


class DetectionFrameSchedulingTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.policy = mock.Mock()
        database = mock.Mock()
        database.get_attendance_action.return_value = "clock_in"
        self.context = {
            "detect_lock": threading.Lock(), "pending_frame": [None], "camera_generation": [0],
            "camera_healthy": True, "camera_invalidated_at": [0.0],
            "time": SimpleNamespace(monotonic=lambda: self.now),
            "config": SimpleNamespace(KIOSK_TYPE="entry"),
            "require_kiosk_action_type": require_kiosk_action_type, "is_fresh_scan": is_fresh_scan,
            "recognizer": SimpleNamespace(liveness_policy=self.policy, known_count=1),
            "database": database, "last_clocks": {}, "datetime": datetime, "timezone": timezone,
            "web_app": mock.Mock(), "base_degraded_reason": lambda: None,
            "_now_iso": lambda: "2026-10-24T12:00:00+00:00",
            "_log_recognition_attempt": mock.Mock(), "logger": mock.Mock(),
        }
        self.feed_code = compile(ast.Module(body=[FEED], type_ignores=[]), "production-feed", "exec")
        self.take_code = compile(ast.Module(body=[TAKE], type_ignores=[]), "production-dequeue", "exec")
        exec(compile(ast.Module(body=[WRITER], type_ignores=[]), "production-write", "exec"), self.context)

    def capture(self, stamp):
        self.now = stamp
        bgr, rgb = [f"bgr-{stamp}"], [f"rgb-{stamp}"]
        self.context.update(bgr_frame=bgr, rgb_frame=rgb, now=stamp)
        exec(self.feed_code, self.context)
        # Camera-owned buffers can be reused immediately after handoff.
        bgr[0] = rgb[0] = "reused-camera-buffer"

    def take(self):
        exec(self.take_code, self.context)
        return self.context["frames"]

    def record(self, frame):
        result = {"frame_ts": frame[2], "camera_generation": frame[3],
                  "candidate_encoding": [1.0], "face_loc": (0, 2, 2, 0)}
        return self.context["record_clock"](result, 1, "Alex", "1", .9, False)

    def test_three_second_inference_keeps_recording_from_current_camera_evidence(self):
        self.capture(100.0)
        recorded, ages = [], []
        # The detector takes three seconds per inference while the camera
        # continues at ten frames/sec. Model results are within the existing
        # five-second safety window when they start with a recent frame.
        for cycle in range(4):
            frame = self.take()
            start = 100.0 + cycle * 3
            for tick in range(1, 31):
                self.capture(start + tick / 10)
            ages.append(round(self.now - frame[2], 1))
            recorded.append(self.record(frame))
        self.assertEqual(recorded, [True] * 4, f"frame ages at attendance write: {ages}")
        self.assertEqual(self.policy.record.call_count, 4)

    def test_waiting_frame_is_latest_owned_pair_and_inflight_frame_is_unchanged(self):
        self.capture(100.0)
        inflight = self.take()
        self.capture(100.1)
        self.capture(100.2)
        self.capture(100.3)
        waiting = self.take()
        self.assertEqual(waiting, (["bgr-100.3"], ["rgb-100.3"], 100.3, 0))
        self.assertEqual(inflight, (["bgr-100.0"], ["rgb-100.0"], 100.0, 0))
        self.assertIsNone(self.take(), "Taking a frame must empty the single waiting slot")

    def test_inference_longer_than_freshness_window_still_cannot_record(self):
        self.capture(100.0)
        frame = self.take()
        self.capture(103.0)
        self.capture(106.0)
        self.assertFalse(self.record(frame))
        self.policy.record.assert_not_called()
        # A subsequent attempt can start from the latest captured evidence.
        fresh_frame = self.take()
        self.now = 109.0
        self.assertTrue(self.record(fresh_frame))
        self.policy.record.assert_called_once()


if __name__ == "__main__":
    unittest.main()
