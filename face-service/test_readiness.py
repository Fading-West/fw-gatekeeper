"""Readiness uses initialized state, never downloads a model from a health read."""
import os
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
from fastapi.testclient import TestClient

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
        environment = patch.dict(os.environ, {"FACE_SERVICE_KEY": "synthetic-readiness-key"})
        environment.start()
        self.addCleanup(environment.stop)

    def test_readiness_http_status_and_body_for_every_model_state(self):
        client = TestClient(main.app)
        states = (
            (None, False, False, 503, "model_unavailable"),
            (None, True, False, 503, "model_loading"),
            (None, False, True, 503, "model_unavailable"),
            (object(), False, True, 503, "model_unavailable"),
            (object(), False, False, 200, None),
        )
        with patch.object(main.REC_PATH.__class__, "exists", return_value=True), \
             patch.object(main, "get_rec_session") as load:
            for session, loading, failed, status, reason in states:
                with self.subTest(loading=loading, failed=failed, status=status), \
                     patch.object(main, "_rec_session", session), \
                     patch.object(main, "_rec_loading", loading), \
                     patch.object(main, "_rec_failed", failed):
                    # Even while the model lock is held, probes must not wait on it.
                    with main._rec_lock:
                        live = client.get("/health")
                        ready = client.get("/ready")
                    self.assertEqual(live.status_code, 200)
                    self.assertEqual(ready.status_code, status)
                    self.assertEqual(ready.json(), live.json())
                    self.assertEqual(ready.json()["degraded_reason"], reason)
                    self.assertEqual(ready.json()["status"], "ok" if status == 200 else "degraded")
            load.assert_not_called()

    def test_readiness_requires_auth_even_with_a_loaded_model(self):
        client = TestClient(main.app)
        for key in (None, "", "   "):
            with self.subTest(key=key), patch.dict(os.environ), patch.object(main, "_rec_session", object()):
                if key is None:
                    os.environ.pop("FACE_SERVICE_KEY", None)
                else:
                    os.environ["FACE_SERVICE_KEY"] = key
                response = client.get("/ready")
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json()["degraded_reason"], "authentication_not_configured")
                self.assertFalse(response.json()["auth_ready"])
                self.assertTrue(response.json()["model_ready"])
                self.assertEqual(client.get("/health").status_code, 200)

    def test_startup_stays_live_and_becomes_ready_after_background_warmup(self):
        started = threading.Event()
        release = threading.Event()
        finished = threading.Event()
        session = object()

        def slow_model_load(*_args, **_kwargs):
            started.set()
            if not release.wait(timeout=5):
                raise RuntimeError("Synthetic model load timed out")
            return session

        warm_model = main._warm_recognition_model

        def warm_and_signal():
            try:
                warm_model()
            finally:
                finished.set()

        with patch.object(main, "ensure_models") as download, \
             patch.object(main.ort, "InferenceSession", side_effect=slow_model_load) as load, \
             patch.object(main, "_warm_recognition_model", side_effect=warm_and_signal):
            try:
                with TestClient(main.app) as client:
                    self.assertTrue(started.wait(timeout=5), "Startup did not warm the model")
                    self.assertEqual(client.get("/health").status_code, 200)
                    response = client.get("/ready")
                    self.assertEqual(response.status_code, 503)
                    self.assertEqual(response.json()["degraded_reason"], "model_loading")
                    release.set()
                    self.assertTrue(finished.wait(timeout=5), "Model warmup did not finish")
                    response = client.get("/ready")
                    self.assertEqual(response.status_code, 200)
                    self.assertTrue(response.json()["model_ready"])
                    self.assertEqual(response.json()["status"], "ok")
                    download.assert_called_once()
                    load.assert_called_once()
            finally:
                release.set()
                finished.wait(timeout=5)

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
        client = TestClient(main.app)
        self.assertEqual(client.get("/ready").status_code, 503)
        session = object()
        with patch.object(main, "ensure_models"), patch.object(main.ort, "InferenceSession", return_value=session):
            self.assertIs(main.get_rec_session(), session)
        self.assertEqual(main.health()["status"], "ok")
        self.assertTrue(main.health()["model_ready"])
        self.assertFalse(main.health()["model_failed"])
        self.assertEqual(client.get("/ready").status_code, 200)

    def test_loading_status_does_not_wait_for_the_native_session_lock(self):
        with patch.object(main, "_rec_loading", True):
            with main._rec_lock:
                result = main.health()
            self.assertEqual(result["degraded_reason"], "model_loading")
            self.assertFalse(result["model_ready"])

    def test_native_inference_failure_stays_degraded_until_valid_authenticated_inference(self):
        session = Mock()
        session.get_inputs.return_value = [SimpleNamespace(name="input")]
        client = TestClient(main.app)
        image = np.zeros((112, 112, 3), dtype=np.uint8)
        with patch.object(main, "_rec_session", session), \
             patch.object(main, "decode_image", return_value=image), \
             patch.object(main, "get_face_crop", return_value=image):
            for bad_output in (RuntimeError("synthetic native fault"),
                               [np.zeros((1, 512))], [np.full((1, 512), np.nan)],
                               [np.ones((1, 128))], [np.full((1, 512), 1e308)]):
                session.run.side_effect = bad_output if isinstance(bad_output, Exception) else None
                session.run.return_value = bad_output
                payload = {"photo": "synthetic", "encodings": [{"worker_id": "synthetic", "encoding": [0.1] * 512}]}
                response = client.post("/match", json=payload,
                                       headers={"x-face-service-key": "synthetic-readiness-key"})
                self.assertEqual(response.status_code, 503, response.text)
                self.assertGreater(session.run.call_count, 0)
                count = session.run.call_count
                self.assertFalse(client.get("/health").json()["model_ready"])
                self.assertEqual(main.health()["status"], "degraded")
                self.assertEqual(session.run.call_count, count)
                unauthorized = client.post("/match", json=payload)
                self.assertEqual(unauthorized.status_code, 401)
                self.assertFalse(main.health()["model_ready"])
                session.run.side_effect = None
                session.run.return_value = [np.ones((1, 512))]
                response = client.post("/match", json=payload,
                                       headers={"x-face-service-key": "synthetic-readiness-key"})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(main.health()["model_ready"])
                self.assertFalse(main.health()["model_failed"])


if __name__ == "__main__":
    unittest.main()
