"""Concurrent requests must not bypass the supervisor PIN lockout."""

import sys
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import config
import kiosk_ui_auth as auth


class SupervisorLockoutRaceTests(unittest.TestCase):
    def test_delayed_correct_body_cannot_clear_concurrent_lockout(self):
        with mock.patch.dict(sys.modules, {"cv2": types.ModuleType("cv2")}):
            import app

        limiter = auth.SupervisorAttemptLimiter(clock=lambda: 100.0)
        all_reading = threading.Barrier(7)
        release_correct = threading.Event()
        original_get_json = app.app.request_class.get_json

        def delayed_get_json(request, *args, **kwargs):
            all_reading.wait(timeout=5)
            if request.headers.get("X-Test-Attempt") == "correct":
                if not release_correct.wait(timeout=5):
                    raise AssertionError("Correct request body was never released")
            return original_get_json(request, *args, **kwargs)

        def unlock(pin):
            with app.app.test_client() as client:
                response = client.post(
                    "/supervisor/unlock",
                    json={"pin": pin, "boot_nonce": auth.get_supervisor_boot_nonce()},
                    headers={"X-Kiosk-UI-Key": "synthetic-ui", "X-Test-Attempt": pin},
                )
                return response, client.get_cookie(auth.KIOSK_SUPERVISOR_SESSION_COOKIE)

        with mock.patch.object(config, "KIOSK_UI_KEY", "synthetic-ui", create=True), \
             mock.patch.object(config, "KIOSK_SUPERVISOR_PIN", "correct", create=True), \
             mock.patch.object(app, "_supervisor_attempt_limiter", limiter), \
             mock.patch.object(auth, "_supervisor_sessions", {}), \
             mock.patch.object(auth, "_supervisor_unlocks", {}), \
             mock.patch.object(app.app.request_class, "get_json", delayed_get_json), \
             ThreadPoolExecutor(max_workers=6) as executor:
            wrong = [executor.submit(unlock, "wrong") for _ in range(5)]
            correct = executor.submit(unlock, "correct")
            try:
                all_reading.wait(timeout=5)
                responses = [future.result(timeout=5) for future in wrong]
                self.assertEqual(sorted(response.status_code for response, _ in responses),
                                 [401, 401, 401, 401, 429])
                self.assertTrue(limiter.is_locked())
                self.assertTrue(all(cookie is None for _, cookie in responses))
            finally:
                release_correct.set()
            response, cookie = correct.result(timeout=5)
            self.assertEqual(response.status_code, 429)
            self.assertEqual(response.get_json()["retry_after_seconds"], 300)
            self.assertIsNone(cookie)
            self.assertNotIn("Set-Cookie", response.headers)
            self.assertTrue(limiter.is_locked())
            self.assertEqual(auth._supervisor_sessions, {})


if __name__ == "__main__":
    unittest.main()
