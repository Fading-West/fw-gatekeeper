"""Loopback cookie bootstrap must reject DNS-rebound browser origins."""
import sys
import types
import unittest
from unittest import mock
import config

# The HTTP boundary needs no camera hardware or OpenCV operations.
with mock.patch.dict(sys.modules, {"cv2": types.ModuleType("cv2")}):
    import app
from kiosk_ui_auth import KIOSK_UI_SESSION_COOKIE


class CookieOriginTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(config, "KIOSK_UI_KEY", "synthetic-ui-key", create=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_rebound_hostname_does_not_receive_credential_or_read_status(self):
        client = app.app.test_client()
        origin = "http://attacker.example:5555"
        response = client.get("/", base_url=origin, environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(KIOSK_UI_SESSION_COOKIE, "".join(response.headers.getlist("Set-Cookie")))
        self.assertEqual(client.get("/status", base_url=origin).status_code, 401)
        self.assertEqual(client.get("/feed", base_url=origin).status_code, 401)

    def test_local_origins_bootstrap_but_remote_clients_do_not(self):
        for hostname in ("localhost", "127.0.0.1", "[::1]"):
            with self.subTest(hostname=hostname):
                client = app.app.test_client()
                origin = f"http://{hostname}:5555"
                peer = "::1" if hostname == "[::1]" else "127.0.0.1"
                response = client.get("/", base_url=origin, environ_overrides={"REMOTE_ADDR": peer})
                self.assertIn(KIOSK_UI_SESSION_COOKIE, "".join(response.headers.getlist("Set-Cookie")))
                with mock.patch.object(app, "get_status_snapshot", return_value={}):
                    self.assertEqual(client.get("/status", base_url=origin).status_code, 200)
        response = app.app.test_client().get("/", base_url="http://localhost:5555",
                                            environ_overrides={"REMOTE_ADDR": "192.0.2.1"})
        self.assertNotIn(KIOSK_UI_SESSION_COOKIE, "".join(response.headers.getlist("Set-Cookie")))


if __name__ == "__main__":
    unittest.main()
