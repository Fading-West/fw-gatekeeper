"""Deployment OTEL settings must not prevent startup or skip the service lifespan."""
import importlib
import os
import tempfile
import threading
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient


class FaceOtelStartupTests(unittest.TestCase):
    def test_startup_and_lifespan_with_otel_environment(self):
        for variable, value in (
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318"),
            ("OTEL_TRACES_EXPORTER", "console"),
        ):
            with self.subTest(variable=variable), tempfile.TemporaryDirectory() as model_dir:
                environment = {key: value for key, value in os.environ.items()
                               if not key.startswith("OTEL_")}
                environment.update({
                    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318",
                    variable: value,
                    "FACE_SERVICE_KEY": "synthetic-startup-key",
                    "FACE_MODEL_DIR": model_dir,
                })
                with patch.dict(os.environ, environment, clear=True):
                    # Construct a fresh app with the deployment environment already set.
                    main = importlib.reload(importlib.import_module("main"))
                    warmed = threading.Event()
                    with patch.object(main, "_warm_recognition_model", side_effect=warmed.set):
                        # The context manager sends real ASGI startup/shutdown events.
                        with TestClient(main.app) as client:
                            self.assertTrue(warmed.wait(timeout=5), "Service lifespan did not warm the model")
                            response = client.get("/health")
                            self.assertEqual(response.status_code, 200, response.text)
                            self.assertTrue(response.json()["auth_ready"])


if __name__ == "__main__":
    unittest.main()
