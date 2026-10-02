"""Readiness uses initialized state, never downloads a model from a health read."""
import os
import tempfile
import unittest
from unittest.mock import patch

os.environ["FACE_MODEL_DIR"] = tempfile.mkdtemp(prefix="synthetic-readiness-")
os.environ["FACE_SERVICE_KEY"] = "synthetic-readiness-key"
import main


class FaceReadinessTests(unittest.TestCase):
    def setUp(self):
        self.patches = [patch.object(main, "_rec_session", None),
                        patch.object(main, "_rec_loading", False),
                        patch.object(main, "_rec_failed", False)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def test_file_existence_cannot_claim_readiness_and_health_is_read_only(self):
        with patch.object(main.REC_PATH.__class__, "exists", return_value=True), \
             patch.object(main, "ensure_models") as download, \
             patch.object(main.ort, "InferenceSession") as load:
            for _ in range(3):
                result = main.health()
                self.assertEqual(result["status"], "degraded")
                self.assertFalse(result["model_ready"])
            download.assert_not_called()
            load.assert_not_called()

    def test_missing_auth_stays_degraded_with_usable_model_and_exposes_no_key(self):
        with patch.object(main, "_rec_session", object()), patch.dict(os.environ, {"FACE_SERVICE_KEY": ""}):
            result = main.health()
            self.assertEqual(result["status"], "degraded")
            self.assertEqual(result["degraded_reason"], "authentication_not_configured")
            self.assertFalse(result["auth_ready"])
            self.assertNotIn("FACE_SERVICE_KEY", result)

    def test_failed_load_and_authenticated_retry_recover_readiness(self):
        with patch.object(main, "ensure_models"), \
             patch.object(main.ort, "InferenceSession", side_effect=RuntimeError("synthetic corrupt model")):
            main._warm_recognition_model()
        self.assertTrue(main.health()["model_failed"])
        self.assertEqual(main.health()["status"], "degraded")
        session = object()
        with patch.object(main, "ensure_models"), patch.object(main.ort, "InferenceSession", return_value=session):
            self.assertIs(main.get_rec_session(), session)
        self.assertEqual(main.health()["status"], "ok")
        self.assertTrue(main.health()["model_ready"])
        self.assertFalse(main.health()["model_failed"])

    def test_loading_status_does_not_wait_for_the_native_session_lock(self):
        with patch.object(main, "_rec_loading", True):
            with main._rec_lock:
                result = main.health()
            self.assertEqual(result["degraded_reason"], "model_loading")
            self.assertFalse(result["model_ready"])


if __name__ == "__main__":
    unittest.main()
