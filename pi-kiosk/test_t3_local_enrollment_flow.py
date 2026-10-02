"""Exercise the real enrollment CLI with synthetic camera/native adapters only."""
import importlib.util
import itertools
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import config
import database


class LocalEnrollmentFlowTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for setting, value in (("DB_PATH", str(self.root / "kiosk.db")),
                               ("FACES_DIR", str(self.root / "captures")),
                               ("PHOTO_DIR", str(self.root / "photos"))):
            patch = mock.patch.object(config, setting, value)
            patch.start()
            self.addCleanup(patch.stop)
        database._local.conn = None
        self.addCleanup(self.close_database)
        embeddings = types.ModuleType("embeddings")
        embeddings.embed_face = mock.Mock()
        embeddings.model_ready = lambda: True
        embeddings.normalize_embedding = lambda value: value / np.linalg.norm(value)
        faces = types.ModuleType("face_recognition")
        faces.face_locations = lambda *_args, **_kwargs: [(4, 14, 14, 4)]
        liveness = types.ModuleType("liveness")
        self.challenge = mock.Mock()
        self.challenge.update.return_value = True
        self.challenge.get_ear.return_value = 0.3
        liveness.LivenessChecker = lambda: self.challenge
        spec = importlib.util.spec_from_file_location("synthetic_enrollment_flow", Path(__file__).with_name("enroll.py"))
        self.enroll = importlib.util.module_from_spec(spec)
        with mock.patch.dict(sys.modules, {"embeddings": embeddings, "face_recognition": faces, "liveness": liveness}):
            spec.loader.exec_module(self.enroll)
        self.embed = embeddings.embed_face
        self.camera = mock.Mock()
        self.camera.isOpened.return_value = True
        self.frame = np.zeros((32, 32, 3), dtype=np.uint8)
        self.camera.read.return_value = (True, self.frame)
        for patch in (mock.patch.object(self.enroll.cv2, "VideoCapture", return_value=self.camera),
                      mock.patch.object(self.enroll, "_start_preview_server"),
                      mock.patch.object(self.enroll.time, "sleep"),
                      mock.patch.object(self.enroll.time, "monotonic", side_effect=itertools.count(10, 10))):
            patch.start()
            self.addCleanup(patch.stop)
        self.same = np.zeros(512)
        self.same[0] = 1
        self.other = np.zeros(512)
        self.other[1] = 1

    @staticmethod
    def close_database():
        connection = getattr(database._local, "conn", None)
        if connection:
            connection.close()
            database._local.conn = None

    def test_mixed_sample_is_rejected_then_same_worker_retake_can_finish(self):
        self.embed.side_effect = [self.same, self.other, self.same, self.same]
        messages = []
        with mock.patch.object(self.enroll, "_set_preview", side_effect=lambda _frame, text, *_rest: messages.append(text)):
            self.assertEqual(self.enroll.add_worker("Synthetic Worker"), 0)
        workers = database.get_all_workers()
        self.assertEqual(len(workers), 1)
        self.assertEqual(workers[0]["photo_count"], 3)
        self.assertEqual(self.embed.call_count, 4)
        self.assertTrue(any("Samples do not match" in text for text in messages))
        np.testing.assert_allclose(workers[0]["encoding"], self.same)
        self.camera.release.assert_called_once()

    def test_operator_cancel_never_publishes_a_worker(self):
        self.embed.return_value = self.same
        self.camera.read.side_effect = [(True, self.frame), KeyboardInterrupt()]
        self.assertEqual(self.enroll.add_worker("Synthetic Worker"), 1)
        self.assertEqual(database.get_all_workers(), [])
        self.camera.release.assert_called_once()

    def test_final_quality_recheck_can_refuse_publication_after_three_captures(self):
        self.embed.return_value = self.same
        with mock.patch.object(self.enroll, "samples_agree", side_effect=[True, True, True, False]):
            self.assertEqual(self.enroll.add_worker("Synthetic Worker"), 1)
        self.assertEqual(self.embed.call_count, 3)
        self.assertEqual(database.get_all_workers(), [])
        self.camera.release.assert_called_once()


if __name__ == "__main__":
    unittest.main()
