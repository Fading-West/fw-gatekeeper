"""Request-body limits must run before JSON parsing and authentication."""
import asyncio
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient

os.environ["FACE_SERVICE_KEY"] = "test-key"
os.environ["FACE_MODEL_DIR"] = tempfile.mkdtemp(prefix="gatekeeper-body-")
import main


class BodySizeLimitTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.headers = {"x-face-service-key": "test-key"}

    def request_stream(self, path, chunks, headers=()):
        """Send actual ASGI chunks; TestClient combines generator content."""
        sent = []
        self.read_count = 0
        iterator = iter(chunks)

        async def receive():
            self.read_count += 1
            return next(iterator)

        async def send(message):
            sent.append(message)

        scope = {
            "type": "http", "asgi": {"version": "3.0"},
            "http_version": "1.1", "method": "POST", "scheme": "http",
            "path": path, "raw_path": path.encode(), "query_string": b"",
            "root_path": "", "server": ("testserver", 80),
            "client": ("testclient", 123),
            "headers": [(b"content-type", b"application/json"), *headers],
        }
        asyncio.run(main.app(scope, receive, send))
        status = next(message["status"] for message in sent if message["type"] == "http.response.start")
        body = b"".join(message.get("body", b"") for message in sent if message["type"] == "http.response.body")
        return status, json.loads(body)

    def assert_too_large(self, result):
        self.assertEqual(result, (413, {"detail": "Request body too large"}))

    def test_oversized_content_length_rejected_without_reading_or_auth(self):
        for path in ("/encode", "/match"):
            with self.subTest(path=path), patch.object(main, "get_configured_face_service_key") as auth:
                result = self.request_stream(path, [], [
                    (b"content-length", str(main.MAX_REQUEST_BODY_BYTES + 1).encode()),
                ])
                self.assert_too_large(result)
                self.assertEqual(self.read_count, 0)
                auth.assert_not_called()

    def test_streamed_oversize_rejected_without_parsing_or_auth(self):
        # Exercise chunked, absent, and dishonest Content-Length framing.
        for headers in ([(b"transfer-encoding", b"chunked")], [], [(b"content-length", b"1")]):
            for path in ("/encode", "/match"):
                with self.subTest(headers=headers, path=path), patch.object(main, "get_configured_face_service_key") as auth:
                    # The prefix is invalid JSON: parsing it would return 422.
                    chunk = b"x" * 1_000_000
                    chunks = [
                        {"type": "http.request", "body": chunk, "more_body": True}
                        for _ in range(25)
                    ]
                    chunks.append({"type": "http.request", "body": b"unread", "more_body": False})
                    self.assert_too_large(self.request_stream(path, chunks, headers))
                    self.assertEqual(self.read_count, 25)
                    auth.assert_not_called()

    def test_maximum_enrollment_succeeds_with_header_and_streaming(self):
        photo = "A" * main.MAX_PHOTO_CHARACTERS
        body = json.dumps({"photos": [photo] * main.MAX_ENROLLMENT_PHOTOS}).encode()
        # Also exercise the exact inclusive body limit, with legal JSON padding.
        body += b" " * (main.MAX_REQUEST_BODY_BYTES - len(body))
        vector = np.zeros(512)
        vector[0] = 1.0

        def inspect(index, value):
            self.assertEqual(len(value), main.MAX_PHOTO_CHARACTERS)
            return main.PhotoResult(index=index, ok=True, reason="ok"), vector

        with patch.object(main, "_inspect_enrollment_photo", side_effect=inspect):
            response = self.client.post("/encode", content=body, headers={
                **self.headers, "Content-Type": "application/json",
            })
            self.assertEqual(response.status_code, 200, response.text)
            expected = response.json()
            chunks = [
                {"type": "http.request", "body": body[offset:offset + 1_000_000],
                 "more_body": offset + 1_000_000 < len(body)}
                for offset in range(0, len(body), 1_000_000)
            ]
            result = self.request_stream("/encode", chunks, [
                (b"x-face-service-key", b"test-key"), (b"transfer-encoding", b"chunked"),
            ])
        self.assertEqual(result, (200, expected))
        self.assertEqual(expected["used_photo_indexes"], list(range(main.MAX_ENROLLMENT_PHOTOS)))
        self.assertEqual(len(expected["encoding"]), 512)

    def test_matching_accepts_maximum_photo_and_roster(self):
        vector = [1.0] + [0.0] * 511
        payload = {
            "photo": "A" * main.MAX_PHOTO_CHARACTERS,
            "encodings": [{"worker_id": str(index), "encoding": vector}
                          for index in range(main.MAX_MATCH_ENCODINGS)],
        }
        with patch.object(main, "decode_image"), patch.object(main, "get_embedding", return_value=vector):
            response = self.client.post("/match", json=payload, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"match": {"worker_id": "0", "confidence": 1.0}})

    def test_matching_field_limits_reject_before_decoding(self):
        for field, payload in (
            ("photo", {"photo": "A" * (main.MAX_PHOTO_CHARACTERS + 1), "encodings": []}),
            ("encodings", {"photo": "A", "encodings": [
                {"worker_id": "worker", "encoding": []}
            ] * (main.MAX_MATCH_ENCODINGS + 1)}),
        ):
            with self.subTest(field=field), patch.object(main, "decode_image") as decode:
                response = self.client.post("/match", json=payload, headers=self.headers)
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json()["detail"][0]["loc"], ["body", field])
                decode.assert_not_called()

    def test_normal_authentication_and_empty_roster_responses_unchanged(self):
        payload = {"photo": "A", "encodings": []}
        for headers in ({}, {"x-face-service-key": "wrong-key"}):
            response = self.client.post("/match", json=payload, headers=headers)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.json(), {"detail": "Unauthorized"})
        with patch.dict(os.environ, {"FACE_SERVICE_KEY": ""}):
            response = self.client.post("/match", json=payload, headers=self.headers)
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json(), {"detail": "Face service authentication is not configured"})
        response = self.client.post("/match", json=payload, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"match": None})


if __name__ == "__main__":
    unittest.main()
