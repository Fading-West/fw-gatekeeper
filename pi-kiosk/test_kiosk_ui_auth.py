#!/usr/bin/env python3
"""Behavioral and integration-contract coverage for kiosk-local web auth."""

import sys
import time
import unittest
from pathlib import Path

KIOSK_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(KIOSK_DIR))

import config  # noqa: E402
from kiosk_ui_auth import (  # noqa: E402
    get_enroll_preview_host,
    get_kiosk_ui_host,
    has_valid_kiosk_ui_credential,
    has_valid_supervisor_credential,
    kiosk_ui_session_token,
    require_kiosk_ui_key,
    SupervisorAttemptLimiter,
    supervisor_session_token,
)


class KioskUiAuthTests(unittest.TestCase):
    def setUp(self):
        self.had_key = hasattr(config, "KIOSK_UI_KEY")
        self.original_key = getattr(config, "KIOSK_UI_KEY", None)
        self.had_supervisor_pin = hasattr(config, "KIOSK_SUPERVISOR_PIN")
        self.original_supervisor_pin = getattr(config, "KIOSK_SUPERVISOR_PIN", None)

    def tearDown(self):
        if self.had_key:
            config.KIOSK_UI_KEY = self.original_key
        elif hasattr(config, "KIOSK_UI_KEY"):
            delattr(config, "KIOSK_UI_KEY")
        if self.had_supervisor_pin:
            config.KIOSK_SUPERVISOR_PIN = self.original_supervisor_pin
        elif hasattr(config, "KIOSK_SUPERVISOR_PIN"):
            delattr(config, "KIOSK_SUPERVISOR_PIN")

    def test_missing_key_fails_closed_with_actionable_message(self):
        config.KIOSK_UI_KEY = "   "
        with self.assertRaisesRegex(RuntimeError, "KIOSK_UI_KEY is required"):
            require_kiosk_ui_key()
        self.assertFalse(has_valid_kiosk_ui_credential(provided_key="candidate"))

    def test_header_and_derived_session_require_the_configured_key(self):
        config.KIOSK_UI_KEY = "  local-ui-key  "
        self.assertFalse(has_valid_kiosk_ui_credential(provided_key="wrong"))
        self.assertTrue(has_valid_kiosk_ui_credential(provided_key="local-ui-key"))
        self.assertTrue(
            has_valid_kiosk_ui_credential(session_token=kiosk_ui_session_token("local-ui-key"))
        )

    def test_routes_and_auxiliary_servers_are_locked_down(self):
        app_source = (KIOSK_DIR / "app.py").read_text(encoding="utf-8")
        enroll_source = (KIOSK_DIR / "enroll.py").read_text(encoding="utf-8")
        setup_source = (KIOSK_DIR / "setup.sh").read_text(encoding="utf-8")
        gitignore_source = (KIOSK_DIR.parent / ".gitignore").read_text(encoding="utf-8")

        for route in ("/feed", "/video_feed", "/status", "/log", "/today"):
            self.assertRegex(
                app_source,
                rf'@app\.route\("{route}"\)\s+@kiosk_ui_auth_required',
            )
        self.assertRegex(
            app_source,
            r'@app\.route\("/manual_clock", methods=\["POST"\]\)\s+@kiosk_ui_auth_required\s+@supervisor_auth_required',
        )
        self.assertIn('snapshot.pop("admin", None)', app_source)
        self.assertIn('@app.route("/supervisor/unlock", methods=["POST"])', app_source)
        self.assertIn('_supervisor_attempt_limiter.is_locked()', app_source)
        self.assertIn('"retry_after_seconds"', app_source)
        template_source = (KIOSK_DIR / "templates" / "index.html").read_text(encoding="utf-8")
        self.assertIn('target.matches("input, textarea, select")', template_source)
        self.assertIn('!event.repeat && !hasModifier', template_source)
        self.assertIn('id="supervisorDialog"', template_source)
        self.assertIn('id="supervisorPin" name="pin" type="password"', template_source)
        self.assertIn("supervisorDialog.showModal()", template_source)
        self.assertNotIn("window.prompt", template_source)
        self.assertIn("if (adminVisible && !data.admin)", template_source)
        self.assertIn("requestSupervisorStateVersion !== supervisorStateVersion", template_source)
        self.assertIn("if (response.status === 401)", template_source)
        self.assertIn("Supervisor session expired. Unlock again to retry.", template_source)
        self.assertIn('openSupervisorDialog("Supervisor session expired. Unlock again to retry.")', template_source)
        self.assertIn('KIOSK_SUPERVISOR_PIN="$KIOSK_SUPERVISOR_PIN"', setup_source)
        self.assertIn('./venv/bin/python tools/update_local_config.py', setup_source)
        self.assertNotIn('cat > config_local.py', setup_source)
        self.assertEqual(get_kiosk_ui_host(), "127.0.0.1")
        self.assertEqual(get_enroll_preview_host(), "127.0.0.1")
        self.assertIn("host=get_enroll_preview_host()", enroll_source)
        self.assertIn('if [ -z "$KIOSK_UI_KEY" ]', setup_source)
        self.assertIn("pi-kiosk/config_local.py", gitignore_source)

    def test_supervisor_session_is_separate_and_fails_closed(self):
        config.KIOSK_UI_KEY = "local-ui-key"
        config.KIOSK_SUPERVISOR_PIN = "supervisor-only"
        self.assertFalse(has_valid_supervisor_credential(provided_pin="wrong"))
        self.assertFalse(has_valid_supervisor_credential(session_token=kiosk_ui_session_token("local-ui-key")))
        self.assertTrue(has_valid_supervisor_credential(provided_pin="supervisor-only"))
        self.assertTrue(has_valid_supervisor_credential(session_token=supervisor_session_token("supervisor-only")))
        expired = supervisor_session_token("supervisor-only", int(time.time()) - 301)
        self.assertFalse(has_valid_supervisor_credential(session_token=expired))

    def test_supervisor_attempts_lock_and_recover_after_timeout(self):
        now = [100.0]
        limiter = SupervisorAttemptLimiter(
            max_attempts=3,
            window_seconds=60,
            lockout_seconds=300,
            clock=lambda: now[0],
        )

        self.assertFalse(limiter.record_failure())
        self.assertFalse(limiter.record_failure())
        self.assertTrue(limiter.record_failure())
        self.assertTrue(limiter.is_locked())
        self.assertEqual(limiter.retry_after_seconds(), 300)

        now[0] += 301
        self.assertFalse(limiter.is_locked())
        limiter.record_success()
        self.assertEqual(limiter.retry_after_seconds(), 0)


if __name__ == "__main__":
    unittest.main()
