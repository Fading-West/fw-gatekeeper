"""Synthetic server-side lock, replay and restart regressions."""
import sys
import types
import unittest
from unittest import mock

import config
import kiosk_ui_auth as auth


class SupervisorLockTests(unittest.TestCase):
    def setUp(self):
        for name, value in (("_supervisor_sessions", {}), ("_supervisor_unlocks", {}), ("_cancelled_supervisor_unlocks", set())):
            patcher = mock.patch.object(auth, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
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
        boot_nonce = first.get("/health").get_json()["supervisor_boot_nonce"]
        unlocked = first.post("/supervisor/unlock", json={"pin": "synthetic-pin", "boot_nonce": boot_nonce}, headers=headers)
        self.assertEqual(unlocked.status_code, 200)
        token = first.get_cookie(auth.KIOSK_SUPERVISOR_SESSION_COOKIE).value
        copied.set_cookie(auth.KIOSK_SUPERVISOR_SESSION_COOKIE, token)
        self.assertEqual(first.post("/supervisor/lock", headers=headers).status_code, 200)
        self.assertEqual(copied.post("/manual-clock", json={"worker_id": 1}, headers=headers).status_code, 401)
        self.assertEqual(first.post("/supervisor/lock", headers=headers).status_code, 200)

    def test_cancel_before_generation_and_after_cookie_creation(self):
        auth.revoke_supervisor_session(None, "before")
        with self.assertRaises(ValueError):
            auth.supervisor_session_token(unlock_request_id="before")
        late_cookie = auth.supervisor_session_token(unlock_request_id="after")
        self.assertEqual(late_cookie, auth.supervisor_session_token(unlock_request_id="after"))
        auth.revoke_supervisor_session(None, "after")
        self.assertFalse(auth.has_valid_supervisor_credential(session_token=late_cookie))
        with self.assertRaises(ValueError):
            auth.supervisor_session_token(unlock_request_id="after")

    def test_route_cancels_unlock_without_received_cookie(self):
        with mock.patch.dict(sys.modules, {"cv2": types.ModuleType("cv2")}):
            import app
        client = app.app.test_client()
        headers = {"X-Kiosk-UI-Key": "synthetic-ui"}
        self.assertEqual(client.post("/supervisor/lock", json={"request_id": "cancelled"}, headers=headers).status_code, 200)
        boot_nonce = client.get("/health").get_json()["supervisor_boot_nonce"]
        response = client.post("/supervisor/unlock", json={"pin": "synthetic-pin", "request_id": "cancelled", "boot_nonce": boot_nonce}, headers=headers)
        self.assertEqual(response.status_code, 409)
        self.assertIsNone(client.get_cookie(auth.KIOSK_SUPERVISOR_SESSION_COOKIE))

    def test_cancel_restart_late_unlock_denied_and_fresh_explicit_unlock_allowed(self):
        with mock.patch.dict(sys.modules, {"cv2": types.ModuleType("cv2")}):
            import app
        client = app.app.test_client()
        headers = {"X-Kiosk-UI-Key": "synthetic-ui"}
        old_boot = client.get("/health").get_json()["supervisor_boot_nonce"]
        self.assertEqual(client.post("/supervisor/lock", json={"request_id": "old-operation"}, headers=headers).status_code, 200)
        with mock.patch.object(auth, "_supervisor_boot_nonce", "a" * 32), \
             mock.patch.object(auth, "_supervisor_sessions", {}), \
             mock.patch.object(auth, "_supervisor_unlocks", {}), \
             mock.patch.object(auth, "_cancelled_supervisor_unlocks", set()):
            late = client.post("/supervisor/unlock", json={"pin": "synthetic-pin", "request_id": "old-operation", "boot_nonce": old_boot}, headers=headers)
            self.assertEqual(late.status_code, 409)
            self.assertIsNone(client.get_cookie(auth.KIOSK_SUPERVISOR_SESSION_COOKIE))
            new_boot = client.get("/health").get_json()["supervisor_boot_nonce"]
            fresh = client.post("/supervisor/unlock", json={"pin": "synthetic-pin", "request_id": "fresh-operation", "boot_nonce": new_boot}, headers=headers)
            self.assertEqual(fresh.status_code, 200)
            token = client.get_cookie(auth.KIOSK_SUPERVISOR_SESSION_COOKIE).value
            self.assertTrue(auth.has_valid_supervisor_credential(session_token=token))


if __name__ == "__main__":
    unittest.main()
