"""Admission must bound concurrent image bodies without refusing normal portal traffic."""
import asyncio
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from starlette.exceptions import HTTPException

from image_admission import (IN_FLIGHT_BODY_BUDGET, MATCH_MIN_RESERVATION,
                             ImageAdmissionMiddleware, declared_body_size)
from starlette.datastructures import Headers

KEY = b"test-key"
MAX_ENCODE_BODY = 6 * 4_000_000 + 1024
PORTAL_BODY = 3 * 60_000 + 512


def request(path="/encode", size=None, key=KEY, extra=()):
    headers = [(b"x-face-service-key", key)] + list(extra)
    if size is not None:
        headers.append((b"content-length", str(size).encode()))
    return {"type": "http", "method": "POST", "path": path, "headers": headers}


class Held:
    """An inner app that stays in flight until released."""

    def __init__(self):
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def __call__(self, scope, receive, send):
        self.entered.set()
        await self.release.wait()


async def rejected(gate, scope):
    # Rejections never wait for the refused body or reach the endpoint.
    chunks = [{"type": "http.request", "body": b"x" * 1024, "more_body": True}] * 3
    receive = AsyncMock(side_effect=chunks + [{"type": "http.request", "body": b"", "more_body": False}])
    send = AsyncMock()
    calls = gate.app
    gate.app = AsyncMock(side_effect=AssertionError("refused request reached the endpoint"))
    try:
        await gate(scope, receive, send)
    finally:
        gate.app = calls
    if receive.await_count != 0:
        return False
    start = send.await_args_list[0].args[0]
    return start["status"] == 503 and (b"retry-after", b"5") in start["headers"]


class ImageAdmissionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        patcher = patch.dict(os.environ, {"FACE_SERVICE_KEY": KEY.decode()})
        patcher.start()
        self.addCleanup(patcher.stop)

    async def hold(self, gate, held, scope):
        task = asyncio.create_task(gate(scope, AsyncMock(), AsyncMock()))
        await held.entered.wait()
        held.entered.clear()
        return task

    async def test_second_maximum_request_is_refused_before_body_is_read(self):
        held = Held()
        gate = ImageAdmissionMiddleware(held)
        first = await self.hold(gate, held, request(size=MAX_ENCODE_BODY))
        try:
            self.assertTrue(await rejected(gate, request(size=MAX_ENCODE_BODY)))
            self.assertTrue(await rejected(gate, request("/match", size=MAX_ENCODE_BODY // 4)))
        finally:
            held.release.set()
            await first
        self.assertEqual(gate.in_flight, 0)

    async def test_portal_sized_requests_run_concurrently_even_beside_a_maximum_request(self):
        held = Held()
        gate = ImageAdmissionMiddleware(held)
        tasks = [await self.hold(gate, held, request(size=MAX_ENCODE_BODY))]
        for _ in range(10):
            tasks.append(await self.hold(gate, held, request(size=PORTAL_BODY)))
        self.assertLessEqual(gate.in_flight, IN_FLIGHT_BODY_BUDGET)
        held.release.set()
        await asyncio.gather(*tasks)
        self.assertEqual(gate.in_flight, 0)

    async def test_unknown_body_size_counts_as_the_full_budget(self):
        for framing in ([], [(b"transfer-encoding", b"chunked")],
                        [(b"content-length", b"1"), (b"content-length", b"2")],
                        [(b"content-length", b"-1")]):
            with self.subTest(framing=framing):
                held = Held()
                gate = ImageAdmissionMiddleware(held)
                # Admitted alone, so a caller without Content-Length is not locked out...
                first = await self.hold(gate, held, request(extra=framing))
                try:
                    # ...but nothing else is admitted beside it.
                    self.assertTrue(await rejected(gate, request(size=PORTAL_BODY)))
                finally:
                    held.release.set()
                    await first

    async def test_failure_and_cancellation_release_capacity(self):
        inner = AsyncMock()
        gate = ImageAdmissionMiddleware(inner)
        for error in (RuntimeError("failed"), asyncio.CancelledError()):
            inner.side_effect = error
            with self.assertRaises(type(error)):
                await gate(request(size=MAX_ENCODE_BODY), AsyncMock(), AsyncMock())
            self.assertEqual(gate.in_flight, 0)

    async def test_other_routes_pass_through_and_invalid_credentials_never_reach_app(self):
        held = Held()
        gate = ImageAdmissionMiddleware(held)
        first = await self.hold(gate, held, request(size=MAX_ENCODE_BODY))
        try:
            inner = AsyncMock()
            gate.app = inner
            await gate({"type": "http", "method": "GET", "path": "/health", "headers": []}, AsyncMock(), AsyncMock())
            send = AsyncMock()
            await gate(request(size=MAX_ENCODE_BODY, key=b"wrong"),
                       AsyncMock(return_value={"type": "http.request", "body": b"invalid JSON"}), send)
            self.assertEqual(send.await_args_list[0].args[0]["status"], 401)
            self.assertEqual(inner.await_count, 1)
            self.assertEqual(gate.in_flight, MAX_ENCODE_BODY)
        finally:
            held.release.set()
            await first

    async def test_oversized_declared_body_is_refused_even_when_idle(self):
        inner = AsyncMock()
        gate = ImageAdmissionMiddleware(inner, budget=8)
        send = AsyncMock()
        await gate(request(size=9), AsyncMock(return_value={"type": "http.request"}), send)
        self.assertEqual(send.await_args_list[0].args[0]["status"], 413)
        inner.assert_not_awaited()
        self.assertEqual(gate.in_flight, 0)

    async def test_match_reserves_memory_for_parsed_roster_vectors(self):
        held = Held()
        gate = ImageAdmissionMiddleware(held, budget=8)
        first = await self.hold(gate, held, request("/match", size=2))
        self.assertEqual(gate.in_flight, 8)
        try:
            self.assertTrue(await rejected(gate, request(size=1)))
        finally:
            held.release.set()
            await first
        send = AsyncMock()
        await gate(request("/match", size=9), AsyncMock(return_value={"type": "http.request"}), send)
        self.assertEqual(send.await_args_list[0].args[0]["status"], 413)
        self.assertEqual(gate.in_flight, 0)

    async def test_actual_body_limit_covers_unknown_and_underdeclared_sizes(self):
        async def read(scope, receive, send):
            while (await receive()).get("more_body", False):
                pass
        for size in (None, 0, 1, 8):
            with self.subTest(size=size):
                gate = ImageAdmissionMiddleware(read, budget=8)
                receive = AsyncMock(side_effect=[
                    {"type": "http.request", "body": b"x" * 4, "more_body": True},
                    {"type": "http.request", "body": b"x" * 5, "more_body": True},
                    {"type": "http.request", "body": b"x" * 2},
                ])
                with self.assertRaises(HTTPException) as error:
                    await gate(request(size=size), receive, AsyncMock())
                self.assertEqual(error.exception.status_code, 413)
                self.assertEqual(receive.await_count, 2)
                self.assertEqual(gate.in_flight, 0)

    async def test_actual_bytes_cannot_exceed_concurrent_reservations(self):
        held = Held()
        gate = ImageAdmissionMiddleware(held, budget=8)
        first = await self.hold(gate, held, request(size=6))
        async def read(scope, receive, send):
            await receive()
        gate.app = read
        try:
            with self.assertRaises(HTTPException) as error:
                await gate(request(size=1), AsyncMock(return_value={
                    "type": "http.request", "body": b"xxx"}), AsyncMock())
            self.assertEqual(error.exception.status_code, 503)
            self.assertEqual(error.exception.headers, {"Retry-After": "5"})
            self.assertEqual(gate.in_flight, 6)
        finally:
            held.release.set()
            await first
        self.assertEqual(gate.in_flight, 0)

    async def test_growing_reservation_is_fully_released_after_disconnect(self):
        entered = asyncio.Event()
        release = asyncio.Event()
        async def read(scope, receive, send):
            await receive()
            entered.set()
            await release.wait()
            self.assertEqual((await receive())["type"], "http.disconnect")
        gate = ImageAdmissionMiddleware(read, budget=8)
        receive = AsyncMock(side_effect=[
            {"type": "http.request", "body": b"xxxx", "more_body": True},
            {"type": "http.disconnect"},
        ])
        task = asyncio.create_task(gate(request(size=1), receive, AsyncMock()))
        await entered.wait()
        self.assertEqual(gate.in_flight, 4)
        release.set()
        await task
        self.assertEqual(gate.in_flight, 0)

    async def test_compact_rosters_reserve_space_for_objects_and_release_on_cancel(self):
        held = Held()
        gate = ImageAdmissionMiddleware(held)
        tasks = [await self.hold(gate, held, request("/match", size=2_100_000)) for _ in range(2)]
        self.assertEqual(gate.in_flight, 2 * MATCH_MIN_RESERVATION)
        self.assertTrue(await rejected(gate, request("/match", size=2_100_000)))
        tasks[0].cancel()
        with self.assertRaises(asyncio.CancelledError):
            await tasks[0]
        self.assertEqual(gate.in_flight, MATCH_MIN_RESERVATION)
        tasks.append(await self.hold(gate, held, request("/match", size=12_000_000)))
        held.release.set()
        await asyncio.gather(*tasks[1:])
        self.assertEqual(gate.in_flight, 0)

    async def test_reservation_lasts_until_streamed_response_completes(self):
        entered = asyncio.Event()
        release = asyncio.Event()
        async def stream(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
            entered.set()
            await release.wait()
            await send({"type": "http.response.body", "body": b"done"})
        gate = ImageAdmissionMiddleware(stream, budget=8)
        task = asyncio.create_task(gate(request(size=8), AsyncMock(), AsyncMock()))
        await entered.wait()
        self.assertEqual(gate.in_flight, 8)
        release.set()
        await task
        self.assertEqual(gate.in_flight, 0)

    def test_malformed_and_huge_lengths_do_not_raise(self):
        for value in ("9" * 5000, "²", "-1", "bad", "0" * 5000 + "1"):
            with self.subTest(value=value[:10]):
                size = declared_body_size(Headers({"content-length": value}), 8)
                self.assertIn(size, (1, 8, 9))


class ImageAdmissionEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("FACE_MODEL_DIR", tempfile.mkdtemp(prefix="image-admission-"))
        import main
        cls.main = main

    def setUp(self):
        from fastapi.testclient import TestClient
        self.auth = patch.dict(os.environ, {"FACE_SERVICE_KEY": KEY.decode()})
        self.auth.start()
        self.addCleanup(self.auth.stop)
        self.gate = ImageAdmissionMiddleware(self.main.app, budget=128)
        # Avoid lifespan startup/model downloads; this exercises the real router.
        self.client = TestClient(self.gate)

    def test_auth_rejects_before_json_parsing_and_health_remains_available(self):
        for path in ("/encode", "/match"):
            response = self.client.post(path, content=b"invalid JSON")
            self.assertEqual(response.status_code, 401)
        with patch.dict(os.environ, {"FACE_SERVICE_KEY": ""}):
            self.assertEqual(self.client.post("/encode", content=b"invalid JSON").status_code, 503)
        self.assertEqual(self.client.get("/health").status_code, 200)
        self.assertEqual(self.gate.in_flight, 0)

    def test_chunked_body_overflow_is_413_and_next_request_is_admitted(self):
        response = self.client.post("/encode", content=iter([b"x" * 64, b"x" * 65]),
                                    headers={"x-face-service-key": KEY.decode()})
        self.assertEqual(response.status_code, 413, response.text)
        self.assertEqual(self.gate.in_flight, 0)
        response = self.client.post("/match", json={"photo": "", "encodings": []},
                                    headers={"x-face-service-key": KEY.decode()})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.gate.in_flight, 0)

    def test_validation_decode_and_model_errors_release_capacity(self):
        headers = {"x-face-service-key": KEY.decode()}
        self.assertEqual(self.client.post("/encode", content=b"invalid JSON", headers={
            **headers, "content-type": "application/json"}).status_code, 422)
        self.assertEqual(self.client.post("/encode", json={"photos": []}, headers=headers).status_code, 422)
        self.assertEqual(self.client.post("/encode", json={"photos": ["bad", "bad"]}, headers=headers).status_code, 422)
        with patch.object(self.main, "_inspect_enrollment_photo", side_effect=HTTPException(503, "unavailable")):
            self.assertEqual(self.client.post("/encode", json={"photos": ["a", "b"]}, headers=headers).status_code, 503)
        self.assertEqual(self.gate.in_flight, 0)


if __name__ == "__main__":
    unittest.main()
