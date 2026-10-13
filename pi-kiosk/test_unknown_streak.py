"""Drive both production loops with deterministic, slow inference and no hardware."""
import ast
from datetime import datetime, timedelta, timezone
import logging
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import numpy as np
import config
from matching import FreshFaceMatcher


MAIN_PATH = Path(__file__).with_name("main.py")
UNKNOWN_A = np.array([0.2, 1.0, 0.0])
UNKNOWN_B = np.array([0.2, 0.0, 1.0])
MATCH = np.array([1.0, 0.0, 0.0])
NO_EMBEDDING = "no_embedding"
CAMERA_ERROR = "camera_error"


class StopDetection(Exception):
    pass


class UnknownStreakTests(unittest.TestCase):
    def run_kiosk(self, detections, *, liveness_required=False, display_time=0):
        # Each inference takes four camera ticks. Execute the real detection
        # loop on the completion tick, stopping it when its frame queue empties.
        ticks = iter([None] + [tick for item in detections
                              for tick in (None, None, None, (item,))])
        detector = []
        detecting = False
        clock = 0.0
        active_embedding = None
        web_app = mock.Mock()
        database = mock.Mock()
        database.get_worker_by_id.return_value = {"server_id": "worker-1"}
        database.was_recently_clocked.return_value = False
        checker = mock.Mock() if liveness_required else None
        recognizer = mock.Mock(known_count=1, usable_count=1, liveness_checker=checker)
        recognizer.liveness_policy.update.side_effect = (
            lambda frame, loc, frame_check: frame_check(frame, loc)
        )
        recognizer.snapshot_known_faces.return_value = (
            [MATCH], [1], ["Alex"], {1: "worker-1"},
        )

        def capture():
            nonlocal detecting, clock, active_embedding
            try:
                tick = next(ticks)
            except StopIteration:
                raise KeyboardInterrupt
            clock += 0.05
            if tick is not None:
                active_embedding = tick[0]
                if active_embedding is CAMERA_ERROR:
                    raise RuntimeError("camera disconnected")
                detecting = True
                try:
                    detector[0]()
                except StopDetection:
                    pass
                finally:
                    detecting = False
            return np.zeros((8, 8, 3)), np.zeros((8, 8, 3))

        def sleep(_seconds):
            if detecting:
                raise StopDetection

        def start_thread(target, **_kwargs):
            return SimpleNamespace(start=lambda: detector.append(target))

        tree = ast.parse(MAIN_PATH.read_text())
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                     and node.name in {"run", "cosine_sim", "_empty_recognition_result",
                                       "_log_recognition_attempt", "_write_recognition_attempt", "_now_iso"}]
        namespace = {
            "config": config, "database": database, "np": np,
            "datetime": datetime, "timedelta": timedelta, "timezone": timezone,
            "logger": logging.getLogger(__name__), "web_app": web_app,
            "os": mock.Mock(), "time": SimpleNamespace(time=lambda: clock, sleep=sleep),
            "threading": SimpleNamespace(Lock=mock.MagicMock, Thread=start_thread),
            "Camera": mock.Mock(return_value=SimpleNamespace(
                start=lambda: None, capture=capture, stop=lambda: None)),
            "FaceRecognizer": lambda: recognizer, "SyncWorker": mock.Mock(),
            "recognition_model_ready": lambda: True,
            "require_kiosk_api_key": lambda: None, "require_kiosk_ui_key": lambda: None,
            "FreshFaceMatcher": FreshFaceMatcher,
            "fr": SimpleNamespace(face_locations=lambda *_args, **_kwargs:
                                  [] if active_embedding is None else [(0, 2, 2, 0)]),
            "cv2": SimpleNamespace(resize=lambda frame, *_args, **_kwargs: frame),
            "embed_face": lambda *_args: None if active_embedding is NO_EMBEDDING else active_embedding,
            "largest_face": lambda locations: locations[0],
            "draw_box": lambda frame, *_args: frame,
            "format_worker_display_id": lambda *_args: "1",
            "GOLD": "gold", "RED": "red", "GREEN": "green",
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), "main.py", "exec"), namespace)
        with mock.patch.multiple(config, LIVENESS_REQUIRED=liveness_required,
                                 RECOGNITION_MATCH_THRESHOLD=0.5, RECOGNITION_UNKNOWN_STREAK=3,
                                 DISPLAY_TIME_SEC=display_time, DISPLAY_TIME_SUCCESS_SEC=display_time):
            namespace["run"](SimpleNamespace(server=None, kiosk_id=None, camera="usb"))
        return web_app, database

    @staticmethod
    def rejections(web_app):
        return [call.kwargs for call in web_app.update_status.call_args_list
                if call.kwargs.get("state") == "NOT_RECOGNIZED"]

    def test_slow_detection_reaches_rejection_and_writes_telemetry(self):
        web_app, database = self.run_kiosk([UNKNOWN_A] * 13)
        self.assertEqual(len(self.rejections(web_app)), 4)
        self.assertTrue(all(status["message"] == "Face not recognized"
                            for status in self.rejections(web_app)))
        self.assertEqual(database.log_recognition_attempt.call_count, 4)
        self.assertTrue(all(call.kwargs["decision"] == "rejected_unknown"
                            and call.kwargs["face_detected"]
                            for call in database.log_recognition_attempt.call_args_list))
        # Empty result slots must preserve the face status, too.
        statuses = [call.kwargs for call in web_app.update_status.call_args_list]
        self.assertEqual(sum(status.get("face_detected") is False for status in statuses), 1)

    def test_observed_no_face_resets_streak_before_next_person(self):
        web_app, database = self.run_kiosk([UNKNOWN_A] * 2 + [None] + [UNKNOWN_B] * 2)
        self.assertEqual(self.rejections(web_app), [])
        database.log_recognition_attempt.assert_not_called()
        self.assertTrue(any(call.kwargs.get("message") == "Step toward camera"
                            and call.kwargs.get("face_detected") is False
                            for call in web_app.update_status.call_args_list[1:]))

    def test_different_face_resets_even_with_same_nearest_roster_candidate(self):
        web_app, database = self.run_kiosk([UNKNOWN_A] * 2 + [UNKNOWN_B] * 2)
        self.assertEqual(self.rejections(web_app), [])
        database.log_recognition_attempt.assert_not_called()
        web_app, database = self.run_kiosk([UNKNOWN_A] * 2 + [UNKNOWN_B] * 3)
        self.assertEqual(len(self.rejections(web_app)), 1)
        self.assertEqual(database.log_recognition_attempt.call_count, 1)

    def test_successful_match_resets_streak_before_later_rejections(self):
        web_app, database = self.run_kiosk([UNKNOWN_A] * 2 + [MATCH] + [UNKNOWN_A] * 2)
        self.assertEqual(self.rejections(web_app), [])
        self.assertTrue(any(call.kwargs.get("state") == "CLOCKED_IN"
                            for call in web_app.update_status.call_args_list))
        database.log_recognition_attempt.assert_called_once()
        self.assertEqual(database.log_recognition_attempt.call_args.kwargs["decision"], "accepted")

    def test_missing_embedding_cannot_bridge_two_people(self):
        web_app, database = self.run_kiosk([UNKNOWN_A, NO_EMBEDDING, UNKNOWN_B])
        self.assertEqual(self.rejections(web_app), [])
        database.log_recognition_attempt.assert_not_called()
        web_app, database = self.run_kiosk([NO_EMBEDDING] * 3)
        self.assertEqual(len(self.rejections(web_app)), 1)
        self.assertEqual(database.log_recognition_attempt.call_args.kwargs["decision"],
                         "rejected_no_embedding")

    def test_camera_interruption_starts_new_streak(self):
        web_app, database = self.run_kiosk([UNKNOWN_A] * 2 + [CAMERA_ERROR, UNKNOWN_A])
        self.assertEqual(self.rejections(web_app), [])
        database.log_recognition_attempt.assert_not_called()

    def test_display_hold_does_not_repeat_rejection_telemetry(self):
        web_app, database = self.run_kiosk([UNKNOWN_A] * 13, display_time=5)
        self.assertEqual(len(self.rejections(web_app)), 1)
        database.log_recognition_attempt.assert_called_once()

    def test_blink_verified_match_clears_unknown_streak(self):
        web_app, database = self.run_kiosk(
            [UNKNOWN_A] * 2 + [MATCH] * 4 + [UNKNOWN_A] * 2, liveness_required=True,
        )
        self.assertEqual(self.rejections(web_app), [])
        self.assertTrue(any(call.kwargs.get("state") == "CLOCKED_IN"
                            for call in web_app.update_status.call_args_list))
        self.assertTrue(any(call.kwargs["decision"] == "accepted"
                            and call.kwargs["liveness_confirmed"]
                            for call in database.log_recognition_attempt.call_args_list))

    def test_no_face_cancels_pending_blink_without_unknown_rejection(self):
        web_app, database = self.run_kiosk(
            [UNKNOWN_A] * 2 + [MATCH, None] + [UNKNOWN_B] * 2, liveness_required=True,
        )
        self.assertEqual(self.rejections(web_app), [])
        database.log_recognition_attempt.assert_called_once()
        self.assertEqual(database.log_recognition_attempt.call_args.kwargs["decision"],
                         "rejected_liveness_identity_change")
        cancelled = [call.kwargs for call in web_app.update_status.call_args_list
                     if call.kwargs.get("message") == "Hold steady..."]
        self.assertTrue(any(status["face_detected"] is False for status in cancelled))


if __name__ == "__main__":
    unittest.main()
