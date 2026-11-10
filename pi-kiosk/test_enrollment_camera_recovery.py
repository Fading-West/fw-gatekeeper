"""Run the production CLI with real SQLite/JPEGs and synthetic device adapters.

No physical camera, authentic face images, or native model acceptance is claimed.
"""
import contextlib
import io
import unittest
from pathlib import Path
from unittest import mock

import config
import cv2
import database
import numpy as np
import test_t3_local_enrollment_flow as flow


class EnrollmentCameraRecoveryTests(unittest.TestCase):
    setUp = flow.LocalEnrollmentFlowTests.setUp
    close_database = staticmethod(flow.LocalEnrollmentFlowTests.close_database)

    def prepare_disconnect(self):
        self.frame.fill(200)
        self.embed.return_value = self.same
        # The interrupt bounds the old implementation's otherwise infinite loop.
        self.camera.read.side_effect = [(True, self.frame)] + [(False, None)] * 30 + [KeyboardInterrupt()]
        self.replacement = mock.Mock()
        self.replacement.isOpened.return_value = True
        self.replacement.read.return_value = (True, self.frame)
        self.enroll.cv2.VideoCapture.side_effect = [self.camera, self.replacement]
        self.previews = []
        original = self.enroll._set_preview

        def record(*args):
            original(*args)
            self.previews.append((self.enroll._preview_frame.copy(), dict(self.enroll._preview_status)))

        patch = mock.patch.object(self.enroll, "_set_preview", side_effect=record)
        patch.start()
        self.addCleanup(patch.stop)

    def run_enrollment(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = self.enroll.add_worker("Synthetic Worker")
        self.output = output.getvalue()
        return result

    def assert_no_publication(self):
        self.assertEqual(database.get_all_workers(), [])
        self.assertEqual(database._local.conn.execute("SELECT COUNT(*) FROM photo_cleanup_journal").fetchone()[0], 0)
        self.assertFalse(Path(config.PHOTO_DIR).exists())
        self.assertFalse(Path(config.FACES_DIR).exists())

    def test_disconnect_reopens_and_rejects_a_different_subject_before_finishing(self):
        self.prepare_disconnect()
        self.embed.side_effect = [self.same, self.other, self.same, self.same]
        self.assertEqual(self.run_enrollment(), 0)
        self.assertEqual(self.camera.read.call_count, 4)
        self.assertEqual(self.replacement.read.call_count, 3)
        self.camera.release.assert_called_once()
        self.replacement.release.assert_called_once()
        self.assertEqual(self.enroll.cv2.VideoCapture.call_count, 2)
        self.assertTrue(any("Samples do not match" in status["message"] for _, status in self.previews))
        blank, status = self.previews[1]
        self.assertFalse(blank.any(), "A failed read must replace the displayed successful sample")
        self.assertIn("Camera unavailable", status["message"])
        self.assertEqual(status["captures"], 1)
        self.assertFalse(status["liveness"])
        self.assertEqual(status["ear"], 0)
        workers = database.get_all_workers()
        self.assertEqual(len(workers), 1)
        self.assertEqual(workers[0]["photo_count"], 3)
        np.testing.assert_allclose(workers[0]["face_encoding"], self.same)
        self.assertEqual(len(list(Path(config.PHOTO_DIR).rglob("*.jpg"))), 3)

    def test_persistent_unavailable_exits_clearly_and_leaves_no_partial_biometrics(self):
        self.prepare_disconnect()
        closed = [mock.Mock() for _ in range(5)]
        for capture in closed:
            capture.isOpened.return_value = False
        self.enroll.cv2.VideoCapture.side_effect = [self.camera, *closed]
        self.assertEqual(self.run_enrollment(), 1)
        self.assertIn("Camera unavailable", self.output)
        self.assertNotIn("cancelled", self.output)
        self.assertEqual(self.enroll.cv2.VideoCapture.call_count, 6)
        for capture in [self.camera, *closed]:
            capture.release.assert_called_once()
        self.assert_no_publication()
        self.assertFalse(self.enroll._preview_frame.any())
        self.assertIn("failed", self.enroll._preview_status["message"])
        waits = [call.args[0] for call in self.enroll.time.sleep.call_args_list]
        self.assertLess(sum(waits), 10, "Retry sleeps must have a finite budget")
        self.assertTrue(any(delay >= 0.25 for delay in waits))

    def test_reopened_handles_that_never_deliver_a_frame_exhaust_the_budget(self):
        self.prepare_disconnect()
        self.camera.read.side_effect = [(False, None)] * 30 + [KeyboardInterrupt()]
        captures = [self.camera] + [mock.Mock() for _ in range(5)]
        for capture in captures[1:]:
            capture.isOpened.return_value = True
            capture.read.return_value = (False, None)
        self.enroll.cv2.VideoCapture.side_effect = captures
        self.assertEqual(self.run_enrollment(), 1)
        self.assertNotIn("cancelled", self.output)
        self.assertEqual(self.enroll.cv2.VideoCapture.call_count, 6)
        for capture in captures:
            capture.release.assert_called_once()
        self.assert_no_publication()

    def test_one_bad_read_recovers_on_the_same_handle(self):
        self.prepare_disconnect()
        self.camera.read.side_effect = [(True, self.frame), (False, None), (True, self.frame), (True, self.frame)]
        self.assertEqual(self.run_enrollment(), 0)
        self.enroll.cv2.VideoCapture.assert_called_once()
        self.camera.release.assert_called_once()
        self.assertEqual(len(database.get_all_workers()), 1)

    def test_read_exception_releases_the_handle_and_can_recover(self):
        self.prepare_disconnect()
        self.camera.read.side_effect = [(True, self.frame), cv2.error("device disconnected")]
        self.assertEqual(self.run_enrollment(), 0)
        self.camera.release.assert_called_once()
        self.replacement.release.assert_called_once()
        self.assertEqual(self.replacement.read.call_count, 2)

    def test_interrupt_during_reopen_configuration_releases_both_handles(self):
        self.prepare_disconnect()
        self.replacement.set.side_effect = KeyboardInterrupt()
        self.assertEqual(self.run_enrollment(), 1)
        self.assertIn("cancelled", self.output)
        self.camera.release.assert_called_once()
        self.replacement.release.assert_called_once()
        self.assert_no_publication()
        self.assertFalse(self.enroll._preview_frame.any())
        self.assertFalse(self.enroll._preview_status["liveness"])

    def test_interrupt_during_read_releases_capture_and_clears_preview(self):
        self.prepare_disconnect()
        self.camera.read.side_effect = [(True, self.frame), KeyboardInterrupt()]
        self.assertEqual(self.run_enrollment(), 1)
        self.assert_no_publication()
        self.camera.release.assert_called_once()
        self.assertFalse(self.enroll._preview_frame.any())
        self.assertIn("cancelled", self.enroll._preview_status["message"])

    def test_initial_open_failure_or_configuration_interrupt_releases_capture(self):
        for failure in ("closed", "isOpened", "set", "interrupt"):
            with self.subTest(failure=failure):
                self.camera.reset_mock(side_effect=True)
                self.camera.isOpened.return_value = failure != "closed"
                if failure == "isOpened":
                    self.camera.isOpened.side_effect = cv2.error("device unavailable")
                elif failure == "set":
                    self.camera.set.side_effect = cv2.error("device disconnected")
                elif failure == "interrupt":
                    self.camera.set.side_effect = KeyboardInterrupt()
                self.assertEqual(self.run_enrollment(), 1)
                self.camera.release.assert_called_once()
                self.assert_no_publication()

    def test_recovered_open_eyes_cannot_reuse_pre_disconnect_blink_approval(self):
        import test_oct02_continuous_blink_evidence as blink

        self.prepare_disconnect()
        checker = blink.BlinkTests().checker()
        self.enroll.LivenessChecker = lambda: checker
        clock = [1.0]
        reads = iter([(True, self.frame)] * 3 + [(False, None)] * 30 + [KeyboardInterrupt()])

        def read_old():
            if self.camera.read.call_count == 4:
                self.assertTrue(checker.is_alive(), "A completed blink is waiting for the capture interval")
                self.embed.assert_not_called()
            item = next(reads)
            if isinstance(item, KeyboardInterrupt):
                raise item
            return item

        def read_replacement():
            clock[0] = 3.0  # Capture is now allowed, if stale blink approval survived.
            if self.replacement.read.call_count > 1:
                raise KeyboardInterrupt
            return True, self.frame

        self.camera.read.side_effect = read_old
        self.replacement.read.side_effect = read_replacement
        with mock.patch.object(self.enroll.time, "monotonic", side_effect=lambda: clock[0]), \
                mock.patch.object(blink.liveness, "_shape_to_np", return_value=np.zeros((68, 2))), \
                mock.patch.object(blink.liveness, "_eye_aspect_ratio", side_effect=[0.1] * 4 + [0.3] * 4):
            self.assertEqual(self.run_enrollment(), 1)
        self.assertEqual(self.replacement.read.call_count, 2)
        self.embed.assert_not_called()
        self.assert_no_publication()

    def test_unavailable_preview_sends_a_blank_jpeg_instead_of_freezing_last_sample(self):
        self.enroll._set_preview(np.full((32, 32, 3), 200, dtype=np.uint8), "Captured sample 1/3", 1, 0.3, True)
        self.enroll._set_preview(None, "Camera unavailable", 1, 0, False)
        # Refuse to spin if the old generator keeps silently skipping None.
        self.enroll.time.sleep.side_effect = AssertionError("No replacement JPEG was sent")
        chunk = next(self.enroll._preview_mjpeg())
        jpeg = chunk.split(b"\r\n\r\n", 1)[1][:-2]
        image = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        self.assertFalse(image.any())


if __name__ == "__main__":
    unittest.main()
