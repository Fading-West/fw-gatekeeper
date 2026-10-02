"""Synthetic server-side lock, replay and restart regressions."""
import sys
import types
import unittest
from unittest import mock

import config
import kiosk_ui_auth as auth


class SupervisorLockTests(unittest.TestCase):
    def setUp(self):
        for name, value in (("KIOSK_UI_KEY", "synthetic-ui"), ("KIOSK_SUPERVISOR_PIN", "synthetic-pin")):
            patcher = mock.patch.object(config, name, value, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_lock_revokes_copied_token_and_distinct_same_second_unlock_works(self):
        with mock.patch.object(auth.time, "time", return_value=100):
            first = auth.supervisor_session_token(issued_at=100)
            second = auth.supervisor_session_token(issued_at=100)
        self.assertNotEqual(first, second)
        with mock.patch.object(auth.time, "time", return_value=101):
            self.assertTrue(auth.has_valid_supervisor_credential(session_token=first))
            auth.revoke_supervisor_session(first)
            auth.revoke_supervisor_session(first)
            self.assertFalse(auth.has_valid_supervisor_credential(session_token=first))
            self.assertTrue(auth.has_valid_supervisor_credential(session_token=second))

    def test_restart_and_key_rotation_fail_closed(self):
        token = auth.supervisor_session_token()
        with mock.patch.object(auth, "_supervisor_sessions", {}):
            self.assertFalse(auth.has_valid_supervisor_credential(session_token=token))
        with mock.patch.object(config, "KIOSK_UI_KEY", "rotated-synthetic"):
            self.assertFalse(auth.has_valid_supervisor_credential(session_token=token))

    def test_expired_session_and_pruning(self):
        with mock.patch.object(auth.time, "time", return_value=100):
            token = auth.supervisor_session_token()
        with mock.patch.object(auth.time, "time", return_value=401):
            self.assertFalse(auth.has_valid_supervisor_credential(session_token=token))
            auth.supervisor_session_token()
            self.assertNotIn(token, auth._supervisor_sessions)

    def test_route_lock_revokes_token_in_another_client(self):
        with mock.patch.dict(sys.modules, {"cv2": types.ModuleType("cv2")}):
            import app
        first = app.app.test_client()
        copied = app.app.test_client()
        headers = {"X-Kiosk-UI-Key": "synthetic-ui"}
        unlocked = first.post("/supervisor/unlock", json={"pin": "synthetic-pin"}, headers=headers)
        self.assertEqual(unlocked.status_code, 200)
        token = first.get_cookie(auth.KIOSK_SUPERVISOR_SESSION_COOKIE).value
        copied.set_cookie(auth.KIOSK_SUPERVISOR_SESSION_COOKIE, token)
        self.assertEqual(first.post("/supervisor/lock", headers=headers).status_code, 200)
        self.assertEqual(copied.post("/manual-clock", json={"worker_id": 1}, headers=headers).status_code, 401)
        self.assertEqual(first.post("/supervisor/lock", headers=headers).status_code, 200)


if __name__ == "__main__":
    unittest.main()
