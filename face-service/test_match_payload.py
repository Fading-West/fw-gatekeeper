"""Full production-sized rosters and hostile compact JSON stay bounded."""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import ijson
from fastapi.testclient import TestClient
from starlette.requests import Request

os.environ["FACE_SERVICE_KEY"] = "test-key"
os.environ["FACE_MODEL_DIR"] = tempfile.mkdtemp(prefix="match-payload-")
import main
from bounded_json import check_structure


class MatchPayloadTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.headers = {"x-face-service-key": "test-key", "content-type": "application/json"}

    def test_lone_surrogates_are_rejected_before_validation_error_serialization(self):
        # Native YAJL substitutes '?' for some lone high surrogates, while
        # Python JSON retains them. FastAPI's validation error then raised
        # UnicodeEncodeError; a matching worker_id also failed serialization.
        bodies = (
            b'{"photo":"","encodings":[{"worker_id":["\\ud800"],"encoding":[]}]}',
            b'{"photo":"","encodings":[{"\\ud800":0,"encoding":[]}]}',
            b'{"photo":"","encodings":[{"worker_id":"\\ud800","encoding":[1]}]}',
            b'{"photos":["a"],"ignored":"\\udfff"}',
        )
        for backend in ("yajl2_c", "python"):
            with patch("bounded_json.ijson.basic_parse", ijson.get_backend(backend).basic_parse), \
                    patch.object(Request, "json", side_effect=AssertionError("JSON parsing reached")):
                for body in bodies:
                    path = "/encode" if b'"photos"' in body else "/match"
                    with self.subTest(backend=backend, path=path):
                        self.assertEqual(self.client.post(path, content=body, headers=self.headers).status_code, 422)
        with patch.object(main, "decode_image"), patch.object(main, "get_embedding", return_value=[1.0] * 512):
            response = self.client.post("/match", json={"photo": "", "encodings": [
                {"worker_id": "\U0001f600", "encoding": [1.0] * 512}]}, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["match"]["worker_id"], "\U0001f600")

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

    def test_invalid_structures_are_rejected_before_object_parsing(self):
        row = {"worker_id": "worker", "encoding": [0.1] * 512}
        bad_bodies = [
            ("/match", json.dumps({"photo": "", "encodings": [row] * 1002}).encode()),
            ("/match", b'{"photo":"","encodings":[{"worker_id":"w","encoding":[' + b'0.1,' * 1_000_000 + b'1]}]}'),
            ("/match", json.dumps({"photo": "", "encodings": [{**row, "encoding": ["invalid"] * 512}]}).encode()),
            ("/match", b'{"photo":"","encodings":[],"extra":[' + b'0,' * 1_000_000 + b'0]}'),
            ("/match", b'{"photo":"","encodings":[],"extra":' + b'['*33 + b'0' + b']'*33 + b'}'),
            ("/match", json.dumps({"photo": "", "encodings": [], "k"*257: {}}).encode()),
            ("/match", json.dumps({"photo": "A"*4_000_001, "encodings": []}).encode()),
            ("/encode", b'{"photos":[' + b'{},' * 1_000_000 + b'{}]}'),
        ]
        with patch.object(Request, "json", side_effect=AssertionError("Unbounded JSON object parsing")):
            for path, body in bad_bodies:
                with self.subTest(path=path, length=len(body)):
                    self.assertEqual(self.client.post(path, content=body, headers=self.headers).status_code, 422)

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

    def test_whitespace_escaped_strings_and_ignored_fields_are_supported(self):
        check_structure(json.dumps({"photo": 'a\\b"c', "encodings": [], "extra": {"x": [1,2]}}).encode(), "/match")


if __name__ == "__main__":
    unittest.main()
