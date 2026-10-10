"""Admission must bound concurrent image bodies without refusing normal portal traffic."""
import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch

from image_admission import IN_FLIGHT_BODY_BUDGET, ImageAdmissionMiddleware

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
    # The refused body is drained chunk by chunk and never reaches the endpoint.
    chunks = [{"type": "http.request", "body": b"x" * 1024, "more_body": True}] * 3
    receive = AsyncMock(side_effect=chunks + [{"type": "http.request", "body": b"", "more_body": False}])
    send = AsyncMock()
    calls = gate.app
    gate.app = AsyncMock(side_effect=AssertionError("refused request reached the endpoint"))
    try:
        await gate(scope, receive, send)
    finally:
        gate.app = calls
    if receive.await_count != 4:
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
            self.assertTrue(await rejected(gate, request("/match", size=MAX_ENCODE_BODY)))
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

    async def test_other_routes_and_invalid_credentials_pass_through(self):
        held = Held()
        gate = ImageAdmissionMiddleware(held)
        first = await self.hold(gate, held, request(size=MAX_ENCODE_BODY))
        try:
            inner = AsyncMock()
            gate.app = inner
            await gate({"type": "http", "method": "GET", "path": "/health", "headers": []}, AsyncMock(), AsyncMock())
            # Endpoint authentication answers bad keys; they never reserve capacity.
            await gate(request(size=MAX_ENCODE_BODY, key=b"wrong"), AsyncMock(), AsyncMock())
            self.assertEqual(inner.await_count, 2)
            self.assertEqual(gate.in_flight, MAX_ENCODE_BODY)
        finally:
            held.release.set()
            await first


if __name__ == "__main__":
    unittest.main()
