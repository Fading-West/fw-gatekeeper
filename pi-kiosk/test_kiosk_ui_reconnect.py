#!/usr/bin/env python3
"""Kiosk page recovery: /status boot ID and auth-failure status codes.

All credentials and records are synthetic. No server is started; Flask routes
use the in-process test client (which reports a loopback remote address).
"""

import importlib
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

KIOSK_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(KIOSK_DIR))

import config  # noqa: E402
import database  # noqa: E402
import app  # noqa: E402
from kiosk_ui_auth import KIOSK_UI_SESSION_COOKIE, kiosk_ui_session_token  # noqa: E402

UI_KEY = "synthetic-ui-key"


class KioskStatusFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="gatekeeper-kiosk-reconnect-")
        self.addCleanup(self.tmp.cleanup)
        self.patch_config(
            DB_PATH=str(Path(self.tmp.name) / "synthetic.db"),
            PHOTO_DIR=str(Path(self.tmp.name) / "photos"),
            KIOSK_UI_KEY=UI_KEY,
            KIOSK_SUPERVISOR_PIN="synthetic-supervisor-pin",
            KIOSK_ID="synthetic-kiosk",
        )
        database._local.conn = None
        self.addCleanup(self.close_db)
        database.init_db()
        self.client = app.app.test_client()

    def patch_config(self, **values):
        for name, value in values.items():
            patcher = mock.patch.object(config, name, value, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    @staticmethod
    def close_db():
        if database._local.conn is not None:
            database._local.conn.close()
        database._local.conn = None

    def authed_status(self):
        self.client.set_cookie(KIOSK_UI_SESSION_COOKIE, kiosk_ui_session_token(UI_KEY))
        return self.client.get("/status")


class StatusBootIdTests(KioskStatusFixture):
    def test_status_reports_stable_non_secret_boot_id(self):
        first = self.authed_status()
        second = self.authed_status()
        self.assertEqual(first.status_code, 200)
        boot_id = first.get_json()["boot_id"]
        self.assertRegex(boot_id, r"^[0-9a-f]{16}$")
        self.assertEqual(boot_id, app.BOOT_ID)
        self.assertEqual(second.get_json()["boot_id"], boot_id, "boot ID must not change between polls")
        self.assertNotIn(UI_KEY, first.get_data(as_text=True))
        self.assertNotIn(kiosk_ui_session_token(UI_KEY), first.get_data(as_text=True))

    def test_boot_id_changes_when_the_service_process_restarts(self):
        before = app.BOOT_ID
        reloaded = importlib.reload(app)
        self.assertNotEqual(reloaded.BOOT_ID, before)
        self.client = reloaded.app.test_client()
        self.assertEqual(self.authed_status().get_json()["boot_id"], reloaded.BOOT_ID)


class StatusAuthFailureTests(KioskStatusFixture):
    def assert_auth_failure(self, response, code):
        self.assertEqual(response.status_code, code)
        body = response.get_json()
        self.assertIn("error", body)
        self.assertNotIn("boot_id", body, "auth failures must not look like normal status data")
        self.assertNotIn("state", body)
        self.assertNotIn(UI_KEY, response.get_data(as_text=True))

    def test_missing_cookie_is_401(self):
        self.assert_auth_failure(self.client.get("/status"), 401)

    def test_cookie_from_a_rotated_key_is_401(self):
        self.client.set_cookie(KIOSK_UI_SESSION_COOKIE, kiosk_ui_session_token("previous-ui-key"))
        self.assert_auth_failure(self.client.get("/status"), 401)

    def test_missing_ui_key_is_503(self):
        self.patch_config(KIOSK_UI_KEY="  ")
        self.client.set_cookie(KIOSK_UI_SESSION_COOKIE, kiosk_ui_session_token(UI_KEY))
        self.assert_auth_failure(self.client.get("/status"), 503)

    def test_reloading_index_issues_a_fresh_cookie_after_rotation(self):
        self.client.set_cookie(KIOSK_UI_SESSION_COOKIE, kiosk_ui_session_token("previous-ui-key"))
        self.assertEqual(self.client.get("/status").status_code, 401)
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn(f"{KIOSK_UI_SESSION_COOKIE}=", page.headers.get("Set-Cookie", ""))
        status = self.client.get("/status")
        self.assertEqual(status.status_code, 200)
        self.assertIn("boot_id", status.get_json())

    def test_index_without_ui_key_warns_without_cookie_or_secret(self):
        self.patch_config(KIOSK_UI_KEY="")
        with self.assertLogs(app.logger, level="WARNING") as logs:
            page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertNotIn(KIOSK_UI_SESSION_COOKIE, page.headers.get("Set-Cookie", ""))
        self.assertTrue(any("KIOSK_UI_KEY is not configured" in line for line in logs.output))
        self.assertFalse(any(UI_KEY in line for line in logs.output))


class TemplateRecoveryContractTests(unittest.TestCase):
    def test_page_loads_recovery_script_and_feed_is_script_managed(self):
        template = (KIOSK_DIR / "templates" / "index.html").read_text(encoding="utf-8")
        self.assertIn("filename='connection.js'", template)
        self.assertIsNone(re.search(r'<img[^>]*src="/feed"', template), "feed must reconnect via script")
        self.assertIn('id="cameraFeed"', template)
        self.assertIn("if (!response.ok)", template)


if __name__ == "__main__":
    unittest.main()
