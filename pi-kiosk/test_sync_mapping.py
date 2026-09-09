#!/usr/bin/env python3
"""Behavioral coverage: queued attendance keeps its server worker id across deactivation."""

import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

KIOSK_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(KIOSK_DIR))

import config  # noqa: E402
import database  # noqa: E402
import sync  # noqa: E402

ENCODING = np.ones(512, dtype=np.float64)
SERVER_ID = "jh7f1wb6ndevpfktsdq1vmwmd584grnd"


class _FakeResponse:
    def __init__(self, status_code=200, body=None):
        self.status_code = status_code
        self._body = body or {}
        self.text = ""

    def json(self):
        return self._body


class AttendanceServerIdMappingTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._original_db_path = config.DB_PATH
        self._original_key = config.KIOSK_API_KEY
        config.DB_PATH = os.path.join(self._tmp.name, "attendance.db")
        config.KIOSK_API_KEY = "test-kiosk-key"
        database._local.conn = None
        sync._last_orphan_signature = None
        database.init_db()

    def tearDown(self):
        conn = getattr(database._local, "conn", None)
        if conn is not None:
            conn.close()
        database._local.conn = None
        config.DB_PATH = self._original_db_path
        config.KIOSK_API_KEY = self._original_key
        self._tmp.cleanup()

    def _row(self, log_id):
        return database._get_conn().execute(
            "SELECT worker_id, server_worker_id, synced FROM attendance_log WHERE id = ?", (log_id,)
        ).fetchone()

    def test_log_attendance_snapshots_server_worker_id(self):
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)
        log_id = database.log_attendance(worker_id=worker_id, worker_name="caleb", action="clock_in")

        self.assertEqual(self._row(log_id)["server_worker_id"], SERVER_ID)

    def test_removing_deactivated_worker_keeps_mapping_on_queued_rows(self):
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)
        # Simulate a row written by an older release with no snapshot.
        conn = database._get_conn()
        conn.execute(
            "INSERT INTO attendance_log (worker_id, worker_name, action, timestamp) VALUES (?, 'caleb', 'clock_in', '2026-06-01T08:00:00')",
            (worker_id,),
        )
        conn.commit()
        legacy_id = conn.execute("SELECT max(id) FROM attendance_log").fetchone()[0]
        self.assertIsNone(self._row(legacy_id)["server_worker_id"])

        self.assertTrue(database.remove_worker_by_server_id(SERVER_ID))

        self.assertIsNone(database.get_worker_by_id(worker_id))
        self.assertEqual(self._row(legacy_id)["server_worker_id"], SERVER_ID)

    def test_init_db_backfills_rows_from_existing_workers(self):
        worker_id = database.add_worker(name="prime", encoding=ENCODING, server_id="server-prime")
        conn = database._get_conn()
        conn.execute(
            "INSERT INTO attendance_log (worker_id, worker_name, action, timestamp) VALUES (?, 'prime', 'clock_out', '2026-08-20T17:00:00')",
            (worker_id,),
        )
        conn.commit()
        legacy_id = conn.execute("SELECT max(id) FROM attendance_log").fetchone()[0]

        database.init_db()

        self.assertEqual(self._row(legacy_id)["server_worker_id"], "server-prime")

    def test_sync_uses_snapshot_after_worker_row_is_gone(self):
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)
        log_id = database.log_attendance(worker_id=worker_id, worker_name="caleb", action="clock_in")
        database.remove_worker_by_server_id(SERVER_ID)
        self.assertIsNone(database.get_server_id(worker_id))

        captured = {}

        def fake_post(url, json=None, headers=None, timeout=None):
            captured["url"] = url
            captured["json"] = json
            return _FakeResponse(200)

        with mock.patch.object(sync.requests, "post", side_effect=fake_post):
            self.assertTrue(sync.sync_attendance())

        self.assertTrue(captured["url"].endswith("/api/attendance/bulk"))
        self.assertEqual(len(captured["json"]["logs"]), 1)
        self.assertEqual(captured["json"]["logs"][0]["worker_id"], SERVER_ID)
        self.assertEqual(self._row(log_id)["synced"], 1)
        self.assertEqual(database.count_unsynced_logs(), 0)

    def test_orphaned_rows_stay_queued_and_warn_once_per_set(self):
        conn = database._get_conn()
        for day in ("2026-06-01", "2026-06-02"):
            conn.execute(
                "INSERT INTO attendance_log (worker_id, worker_name, action, timestamp) VALUES (4, 'caleb', 'clock_in', ?)",
                (f"{day}T08:00:00",),
            )
        conn.commit()

        with mock.patch.object(sync.requests, "post") as post:
            with self.assertLogs(sync.logger, level=logging.DEBUG) as first:
                self.assertFalse(sync.sync_attendance())
            with self.assertLogs(sync.logger, level=logging.DEBUG) as second:
                self.assertFalse(sync.sync_attendance())
            post.assert_not_called()

        first_warnings = [r for r in first.records if r.levelno >= logging.WARNING]
        second_warnings = [r for r in second.records if r.levelno >= logging.WARNING]
        self.assertEqual(len(first_warnings), 1)
        self.assertIn("local_worker_id=4 name=caleb x2", first_warnings[0].getMessage())
        self.assertEqual(second_warnings, [])
        # Still counted for health reporting; nothing was silently dropped or marked synced.
        self.assertEqual(database.count_unsynced_logs(), 2)

    def test_orphan_rows_sync_once_server_worker_id_is_set(self):
        """The operator replay path: set server_worker_id on stranded rows and let sync send them."""
        conn = database._get_conn()
        conn.execute(
            "INSERT INTO attendance_log (worker_id, worker_name, action, timestamp) VALUES (4, 'caleb', 'clock_in', '2026-06-01T08:00:00')"
        )
        conn.commit()
        with mock.patch.object(sync.requests, "post") as post:
            self.assertFalse(sync.sync_attendance())
            post.assert_not_called()

        conn.execute("UPDATE attendance_log SET server_worker_id = ? WHERE worker_id = 4 AND synced = 0", (SERVER_ID,))
        conn.commit()

        with mock.patch.object(sync.requests, "post", return_value=_FakeResponse(200)) as post:
            self.assertTrue(sync.sync_attendance())
            sent = post.call_args.kwargs["json"]["logs"]
        self.assertEqual([l["worker_id"] for l in sent], [SERVER_ID])
        self.assertEqual(database.count_unsynced_logs(), 0)


if __name__ == "__main__":
    unittest.main()
