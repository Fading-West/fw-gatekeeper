"""Production-sized rosters, validation and the preparse trust boundary."""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient
from starlette.requests import Request

os.environ["FACE_SERVICE_KEY"] = "test-key"
os.environ["FACE_MODEL_DIR"] = tempfile.mkdtemp(prefix="match-payload-")
import main


class MatchPayloadTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.headers = {"x-face-service-key": "test-key", "content-type": "application/json"}

    def test_full_1001_worker_roster_and_maximum_photo_are_accepted(self):
        vector = np.random.default_rng(165).normal(size=512)
        vector = (vector / np.linalg.norm(vector)).tolist()
        payload = {"photo": "A" * 4_000_000, "encodings": [
            {"worker_id": str(i).zfill(32), "encoding": vector} for i in range(1001)]}
        body = json.dumps(payload).encode()
        self.assertGreater(len(body), 8 * 1024 * 1024)
        print(f"Full roster + maximum photo: {len(body):,} bytes")
        with patch.object(main, "decode_image"), patch.object(main, "get_embedding", return_value=vector):
            for streamed in (False, True):
                with self.subTest(streamed=streamed):
                    content = (iter(body[i:i+65536] for i in range(0, len(body), 65536))
                               if streamed else body)
                    response = self.client.post("/match", content=content, headers=self.headers)
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertIn(response.json()["match"]["worker_id"], {str(i).zfill(32) for i in range(1001)})
                    self.assertEqual(response.json()["match"]["confidence"], 1.0)

    def test_roster_and_vector_limits_are_validated(self):
        row = {"worker_id": "worker", "encoding": [0.1] * 512}
        for payload in (
            {"photo": "", "encodings": [row] * 1002},
            {"photo": "", "encodings": [{**row, "encoding": [0.1] * 513}]},
            {"photo": "", "encodings": [{**row, "encoding": ["invalid"]}]},
        ):
            response = self.client.post("/match", json=payload, headers=self.headers)
            self.assertEqual(response.status_code, 422)

    def test_root_path_keeps_preparse_authentication_and_body_limit(self):
        client = TestClient(main.app, root_path="/service")
        with patch.object(Request, "json", side_effect=AssertionError("JSON parsed before authentication")):
            self.assertEqual(client.post("/service/match", content=b"invalid").status_code, 401)
        response = client.post("/service/match", content=b"", headers={
            **self.headers, "content-length": str(24_065_537)})
        self.assertEqual(response.status_code, 413)

    def test_missing_auth_configuration_has_no_busy_retry_header(self):
        with patch.dict(os.environ, {"FACE_SERVICE_KEY": ""}):
            response = self.client.post("/encode", content=b"invalid")
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("retry-after", response.headers)

    def test_empty_roster_and_invalid_vectors_keep_matching_behavior(self):
        self.assertEqual(self.client.post("/match", json={"photo": "", "encodings": []},
                                         headers=self.headers).json(), {"match": None})
        with patch.object(main, "decode_image"), patch.object(main, "get_embedding", return_value=[1.0]*512):
            response = self.client.post("/match", json={"photo": "", "encodings": [
                {"worker_id": "short", "encoding": [1.0] * 128},
                {"worker_id": "zero", "encoding": [0.0] * 512}]}, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"match": None})



if __name__ == "__main__":
    unittest.main()
