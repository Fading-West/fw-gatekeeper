"""Blink processing must finish within the evidence window (no real sleeping)."""
import sys
import types
import unittest
from unittest import mock

import numpy as np

# Exercise the real state machine without a native predictor/model file.
dlib = types.ModuleType("dlib")
dlib.rectangle = lambda *args: args
scipy = types.ModuleType("scipy")
spatial = types.ModuleType("scipy.spatial")
distance = types.ModuleType("scipy.spatial.distance")
distance.euclidean = lambda a, b: float(np.linalg.norm(a - b))
with mock.patch.dict(sys.modules, {"dlib": dlib, "scipy": scipy,
                                   "scipy.spatial": spatial, "scipy.spatial.distance": distance}):
    import liveness


class BlinkProcessingTimeoutTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.clock = mock.patch.object(liveness.time, "monotonic", side_effect=lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.checker = liveness.LivenessChecker.__new__(liveness.LivenessChecker)
        self.checker.ear_threshold = .21
        self.checker.blink_frames = 2
        self.checker.timeout_sec = 5
        self.checker._predictor = mock.Mock(return_value=None)
        self.checker.failed = False
        self.checker.reset()

    def feed(self, ear, frame_check=None):
        with mock.patch.object(liveness, "_shape_to_np", return_value=np.zeros((68, 2))), \
                mock.patch.object(liveness, "_eye_aspect_ratio", return_value=ear):
            return self.checker.update(np.zeros((20, 20, 3), dtype=np.uint8),
                                       (0, 19, 19, 0), frame_check=frame_check)

    def test_processing_crossing_deadline_cannot_complete_old_blink(self):
        for slow_stage in ("predictor", "identity"):
            with self.subTest(slow_stage=slow_stage):
                self.now = 100.0
                self.checker.reset()
                self.checker._predictor = mock.Mock(return_value=None)
                self.assertFalse(self.feed(.1))
                self.assertFalse(self.feed(.1))
                self.now = 104.9

                def slow_work(*args):
                    self.now = 105.1
                    return True

                if slow_stage == "predictor":
                    self.checker._predictor.side_effect = slow_work
                self.assertFalse(self.feed(.3, slow_work if slow_stage == "identity" else None))
                self.assertFalse(self.checker.is_alive())
                # The expired closure cannot be revived by another open frame.
                self.checker._predictor.side_effect = None
                self.assertFalse(self.feed(.3))
                # A fresh uninterrupted blink still works after expiry.
                self.assertFalse(self.feed(.1))
                self.assertFalse(self.feed(.1))
                self.assertTrue(self.feed(.3))

    def test_processing_finishing_inside_window_still_completes(self):
        self.feed(.1)
        self.feed(.1)
        self.now = 104.0

        def identity_check(*args):
            self.now = 104.9
            return True

        self.assertTrue(self.feed(.3, identity_check))


if __name__ == "__main__":
    unittest.main()
