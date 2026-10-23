"""Request-body limits must run before JSON parsing and authentication."""
import asyncio
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient
from fastapi import HTTPException
from starlette.requests import Request

os.environ["FACE_SERVICE_KEY"] = "test-key"
os.environ["FACE_MODEL_DIR"] = tempfile.mkdtemp(prefix="gatekeeper-body-")
import main


class BodySizeLimitTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.headers = {"x-face-service-key": "test-key"}

    def request_stream(self, path, chunks, headers=(), app=None):
        """Send actual ASGI chunks; TestClient combines generator content."""
        sent = []
        self.sent = sent
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
        asyncio.run((app or main.app)(scope, receive, send))
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
        for headers in (
            [(b"transfer-encoding", b"chunked")], [], [(b"content-length", b"1")],
            [(b"content-length", b"invalid")], [(b"content-length", b"-1")],
            [(b"content-length", b"1"), (b"content-length", b"2")],
            [(b"content-length", b"1, 2")],
        ):
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
        vector = np.random.default_rng(42).normal(size=512)
        vector = (vector / np.linalg.norm(vector)).tolist()
        payload = {
            "photo": "A" * main.MAX_PHOTO_CHARACTERS,
            "encodings": [{"worker_id": str(index).zfill(32), "encoding": vector}
                          for index in range(main.MAX_MATCH_ENCODINGS)],
        }
        self.assertGreaterEqual(main.MAX_MATCH_ENCODINGS, 1001)
        self.assertLess(len(json.dumps(payload).encode()), main.MAX_REQUEST_BODY_BYTES)
        with patch.object(main, "decode_image"), patch.object(main, "get_embedding", return_value=vector):
            response = self.client.post("/match", json=payload, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"match": {"worker_id": "0" * 32, "confidence": 1.0}})

    def test_unauthenticated_bounded_json_never_parsed(self):
        # Millions of these objects fit below the byte cap but exhaust a 512 MiB
        # instance when JSON is parsed. Check parser exclusion with a small body.
        for path in ("/encode", "/match"):
            for headers, expected in (({}, 401), ({"x-face-service-key": "wrong"}, 401)):
                with self.subTest(path=path, headers=headers), patch.object(
                    Request, "json", side_effect=AssertionError("JSON parsed before authentication"),
                ):
                    response = self.client.post(path, content=b'{"photos":[{},{}]}', headers={
                        "Content-Type": "application/json", **headers,
                    })
                    self.assertEqual(response.status_code, expected, response.text)
            with patch.dict(os.environ, {"FACE_SERVICE_KEY": ""}), patch.object(
                Request, "json", side_effect=AssertionError("JSON parsed before authentication"),
            ):
                response = self.client.post(path, json={"photos": []}, headers=self.headers)
                self.assertEqual(response.status_code, 503, response.text)

    def test_final_chunk_checks_size_before_authentication(self):
        with patch.object(main, "MAX_REQUEST_BODY_BYTES", 3), patch.object(
            main, "get_configured_face_service_key",
        ) as auth:
            self.assert_too_large(self.request_stream("/encode", [
                {"type": "http.request", "body": b"1234"},
                {"type": "http.request", "body": b"unread"},
            ]))
            self.assertEqual(self.read_count, 1)
            auth.assert_not_called()

    def test_preparse_authentication_with_root_path(self):
        client = TestClient(main.app, root_path="/encode")
        with patch.object(Request, "json", side_effect=AssertionError("Unauthenticated JSON parsed")):
            response = client.post("/encode/encode", json={"photos": []})
        self.assertEqual(response.status_code, 401, response.text)

    def test_authenticated_invalid_json_retains_422(self):
        for path in ("/encode", "/match"):
            response = self.client.post(path, content=b"invalid", headers={
                **self.headers, "Content-Type": "application/json",
            })
            self.assertEqual(response.status_code, 422)

    def test_disconnect_passes_through(self):
        async def downstream(scope, receive, send):
            self.assertEqual(await receive(), {"type": "http.disconnect"})
            await main.JSONResponse({"disconnected": True})(scope, receive, send)

        self.assertEqual(self.request_stream("/test", [{"type": "http.disconnect"}],
                         app=main.RequestBodyLimitMiddleware(downstream)), (200, {"disconnected": True}))

    def test_header_rejection_including_duplicate_and_mixed_case(self):
        excessive = str(main.MAX_REQUEST_BODY_BYTES + 1).encode()
        for headers in (
            [(b"Content-Length", excessive)],
            [(b"content-length", b"1"), (b"content-length", excessive)],
            [(b"content-length", excessive), (b"content-length", b"1")],
        ):
            with self.subTest(headers=headers):
                self.assert_too_large(self.request_stream("/match", [], headers))
                self.assertEqual(self.read_count, 0)

    def test_empty_chunks_and_default_more_body(self):
        with patch.object(Request, "json", side_effect=AssertionError("Unauthenticated JSON parsed")):
            result = self.request_stream("/match", [
                {"type": "http.request", "more_body": True},
                {"type": "http.request", "body": b'{"photo":"A",', "more_body": True},
                {"type": "http.request", "body": b'"encodings":[]}'},
                {"type": "http.request", "body": b"unread"},
            ])
        self.assertEqual(result, (401, {"detail": "Unauthorized"}))
        self.assertEqual(self.read_count, 3)

    def test_non_http_scopes_pass_through_unchanged(self):
        async def receive():
            raise AssertionError("Middleware read a non-HTTP body")

        async def send(message):
            raise AssertionError("Middleware sent a non-HTTP response")

        for scope_type in ("websocket", "lifespan"):
            scope = {"type": scope_type, "headers": [(b"content-length", b"999999999")]}

            async def downstream(actual_scope, actual_receive, actual_send):
                self.assertIs(actual_scope, scope)
                self.assertIs(actual_receive, receive)
                self.assertIs(actual_send, send)

            asyncio.run(main.RequestBodyLimitMiddleware(downstream)(scope, receive, send))

    def test_limit_stays_latched_if_downstream_retries_receive(self):
        async def downstream(scope, receive, send):
            for _ in range(2):
                with self.assertRaises(HTTPException) as raised:
                    await receive()
                self.assertEqual(raised.exception.status_code, 413)
            await main.JSONResponse({"detail": "Request body too large"}, status_code=413)(scope, receive, send)

        with patch.object(main, "MAX_REQUEST_BODY_BYTES", 3):
            self.assert_too_large(self.request_stream("/test", [
                {"type": "http.request", "body": b"1234", "more_body": True},
                {"type": "http.request", "body": b"unread"},
            ], app=main.RequestBodyLimitMiddleware(downstream)))
            self.assertEqual(self.read_count, 1)

    def test_started_response_is_never_replaced_with_413(self):
        async def downstream(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await receive()

        with patch.object(main, "MAX_REQUEST_BODY_BYTES", 3), self.assertRaises(HTTPException):
            self.request_stream("/test", [
                {"type": "http.request", "body": b"1234", "more_body": True},
            ], app=main.RequestBodyLimitMiddleware(downstream))
        self.assertEqual([m["status"] for m in self.sent if m["type"] == "http.response.start"], [200])

    def test_plain_asgi_app_receives_413_without_exception_handler(self):
        async def downstream(scope, receive, send):
            await receive()
            self.fail("Over-limit chunk reached downstream")

        with patch.object(main, "MAX_REQUEST_BODY_BYTES", 3):
            self.assert_too_large(self.request_stream("/test", [
                {"type": "http.request", "body": b"1234", "more_body": True},
                {"type": "http.request", "body": b"unread"},
            ], app=main.RequestBodyLimitMiddleware(downstream)))
        self.assertEqual(self.read_count, 1)

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
