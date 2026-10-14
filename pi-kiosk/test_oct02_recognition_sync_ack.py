"""Independent QA regressions. GK_CHECKOUT selects the exact isolated PR head.

All database records and credentials are synthetic. No service is started;
HTTP upload uses mocks and Flask routes use its in-process test client.
"""
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

CHECKOUT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CHECKOUT / "pi-kiosk"))
import numpy as np
import config
import database
import sync
import app
from kiosk_ui_auth import KIOSK_SUPERVISOR_SESSION_COOKIE, supervisor_session_token


class SyntheticKioskFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="gatekeeper-independent-qa-")
        self.addCleanup(self.tmp.cleanup)
        for name, value in {
            "DB_PATH": str(Path(self.tmp.name) / "synthetic.db"),
            "PHOTO_DIR": str(Path(self.tmp.name) / "photos"),
            "KIOSK_API_KEY": "synthetic-upload-key",
            "KIOSK_UI_KEY": "synthetic-ui-key",
            "KIOSK_SUPERVISOR_PIN": "synthetic-supervisor-pin",
            "KIOSK_ID": "synthetic-kiosk",
            "KIOSK_TYPE": "auto",
        }.items():
            patcher = mock.patch.object(config, name, value, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)
        database._local.conn = None
        self.addCleanup(self.close_db)
        database.init_db()
        self.worker_id = database.add_worker("Synthetic Employee", np.ones(512), server_id="a" * 32)

    @staticmethod
    def close_db():
        if database._local.conn is not None:
            database._local.conn.close()
        database._local.conn = None


class AttendanceOrderTests(SyntheticKioskFixture):
    def test_same_second_latest_inserted_event_controls_next_toggle(self):
        timestamp = "2026-10-01T08:00:00"
        database.log_attendance(self.worker_id, "Synthetic Employee", "clock_in", timestamp=timestamp)
        database.log_attendance(self.worker_id, "Synthetic Employee", "clock_out", timestamp=timestamp)
        self.assertEqual(database.get_last_action(self.worker_id), "clock_out")
        self.assertEqual(app._manual_action_for_worker(self.worker_id), "clock_in")


class RecognitionAcknowledgementTests(SyntheticKioskFixture):
    def test_malformed_or_partial_success_retains_every_unsynced_attempt(self):
        cases = [
            (200, {}), (201, {"ingested": 1, "skipped": 0}),
            (204, None), (200, {"ingested": True, "skipped": 1}),
            (200, {"ingested": 0, "skipped": 0}),
        ]
        for status, body in cases:
            with self.subTest(status=status, body=body):
                database._get_conn().execute("DELETE FROM recognition_attempts")
                database._get_conn().commit()
                for offset in range(2):
                    database.log_recognition_attempt(timestamp=f"2026-10-01T08:00:0{offset}", kiosk_id=config.KIOSK_ID,
                        face_detected=True, decision="near_miss", threshold=0.45)
                response = mock.Mock(status_code=status, json=lambda: body, text="synthetic")
                with mock.patch.object(sync.requests, "post", return_value=response):
                    self.assertFalse(sync.sync_recognition_attempts())
                self.assertEqual(len(database.get_unsynced_recognition_attempts()), 2)

    def test_full_insert_and_duplicate_acknowledgements_drain_queue(self):
        for ingested, skipped in [(2, 0), (0, 2), (1, 1)]:
            with self.subTest(ingested=ingested, skipped=skipped):
                for offset in range(2):
                    database.log_recognition_attempt(timestamp=f"2026-10-01T09:00:0{offset}", kiosk_id=config.KIOSK_ID,
                        face_detected=True, decision="near_miss", threshold=0.45)
                response = mock.Mock(status_code=201, json=lambda: {"ingested": ingested, "skipped": skipped}, text="synthetic")
                with mock.patch.object(sync.requests, "post", return_value=response):
                    self.assertTrue(sync.sync_recognition_attempts())
                self.assertEqual(len(database.get_unsynced_recognition_attempts()), 0)


class LockedAttendancePrivacyTests(SyntheticKioskFixture):
    def test_attendance_history_requires_supervisor_then_relocks(self):
        database.log_attendance(self.worker_id, "Synthetic Employee", "clock_in", timestamp=datetime.now().isoformat(timespec="seconds"))
        client = app.app.test_client()
        headers = {"X-Kiosk-UI-Key": config.KIOSK_UI_KEY}
        for route in ("/log", "/today"):
            with self.subTest(route=route):
                response = client.get(route, headers=headers)
                self.assertEqual(response.status_code, 401)
                self.assertNotIn("Synthetic Employee", response.get_data(as_text=True))
        client.set_cookie(KIOSK_SUPERVISOR_SESSION_COOKIE, supervisor_session_token())
        for route in ("/log", "/today"):
            self.assertEqual(client.get(route, headers=headers).status_code, 200)
        self.assertEqual(client.post("/supervisor/lock", headers=headers).status_code, 200)
        for route in ("/log", "/today"):
            self.assertEqual(client.get(route, headers=headers).status_code, 401)


if __name__ == "__main__":
    unittest.main(defaultTest="RecognitionAcknowledgementTests")
