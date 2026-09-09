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


def _ok_response():
    return mock.Mock(status_code=200, text="")


class AttendanceServerIdMappingTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for name, value in (
            ("DB_PATH", os.path.join(tmp.name, "attendance.db")),
            ("KIOSK_API_KEY", "test-kiosk-key"),
        ):
            patcher = mock.patch.object(config, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self._close_db)
        database._local.conn = None
        sync._last_orphan_signature = None
        sync._last_orphan_warned_at = 0.0
        database.init_db()

    @staticmethod
    def _close_db():
        conn = getattr(database._local, "conn", None)
        if conn is not None:
            conn.close()
        database._local.conn = None

    def _insert_legacy_row(self, worker_id, name="caleb", action="clock_in", ts="2026-06-01T08:00:00", synced=0):
        """A row as written by a release that predates server_worker_id."""
        conn = database._get_conn()
        cursor = conn.execute(
            "INSERT INTO attendance_log (worker_id, worker_name, action, timestamp, synced) VALUES (?, ?, ?, ?, ?)",
            (worker_id, name, action, ts, synced),
        )
        conn.commit()
        return int(cursor.lastrowid)

    def _row(self, log_id):
        return database._get_conn().execute(
            "SELECT worker_id, server_worker_id, synced FROM attendance_log WHERE id = ?", (log_id,)
        ).fetchone()

    # --- write path -------------------------------------------------------

    def test_log_attendance_snapshots_server_worker_id(self):
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)
        log_id = database.log_attendance(worker_id=worker_id, worker_name="caleb", action="clock_in")

        self.assertEqual(self._row(log_id)["server_worker_id"], SERVER_ID)

    def test_log_attendance_keeps_caller_supplied_id_when_worker_row_is_already_gone(self):
        """A deactivation landing between match and record must not strand the event."""
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)
        database.remove_worker_by_server_id(SERVER_ID)

        log_id = database.log_attendance(
            worker_id=worker_id, worker_name="caleb", action="clock_in", server_worker_id=SERVER_ID
        )

        self.assertEqual(self._row(log_id)["server_worker_id"], SERVER_ID)

    def test_roster_exposes_server_ids_for_the_recognizer(self):
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)

        _, ids, _, server_ids = database.get_worker_roster()

        self.assertEqual(ids, [worker_id])
        self.assertEqual(server_ids, {worker_id: SERVER_ID})

    # --- worker deletion --------------------------------------------------

    def test_deactivation_delete_freezes_mapping_on_queued_rows(self):
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)
        legacy_id = self._insert_legacy_row(worker_id)
        self.assertIsNone(self._row(legacy_id)["server_worker_id"])

        self.assertTrue(database.remove_worker_by_server_id(SERVER_ID))

        self.assertIsNone(database.get_worker_by_id(worker_id))
        self.assertEqual(self._row(legacy_id)["server_worker_id"], SERVER_ID)

    def test_hand_run_sql_delete_is_covered_by_the_trigger(self):
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)
        legacy_id = self._insert_legacy_row(worker_id)

        conn = database._get_conn()
        conn.execute("DELETE FROM workers WHERE name = 'caleb'")
        conn.commit()

        self.assertEqual(self._row(legacy_id)["server_worker_id"], SERVER_ID)

    # --- startup migration ------------------------------------------------

    def test_init_db_backfills_queued_rows_only(self):
        worker_id = database.add_worker(name="prime", encoding=ENCODING, server_id="server-prime")
        queued_id = self._insert_legacy_row(worker_id, name="prime", synced=0)
        synced_id = self._insert_legacy_row(worker_id, name="prime", synced=1)
        blank_id = self._insert_legacy_row(worker_id, name="prime", synced=0)
        conn = database._get_conn()
        conn.execute("UPDATE attendance_log SET server_worker_id = '' WHERE id = ?", (blank_id,))
        conn.commit()

        database.init_db()

        self.assertEqual(self._row(queued_id)["server_worker_id"], "server-prime")
        self.assertEqual(self._row(blank_id)["server_worker_id"], "server-prime")
        self.assertIsNone(self._row(synced_id)["server_worker_id"])

    # --- sync -------------------------------------------------------------

    def test_sync_uses_snapshot_after_worker_row_is_gone(self):
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)
        log_id = database.log_attendance(worker_id=worker_id, worker_name="caleb", action="clock_in")
        database.remove_worker_by_server_id(SERVER_ID)
        self.assertIsNone(database.get_server_id(worker_id))

        with mock.patch.object(sync.requests, "post", return_value=_ok_response()) as post:
            self.assertTrue(sync.sync_attendance())

        self.assertTrue(post.call_args.args[0].endswith("/api/attendance/bulk"))
        sent = post.call_args.kwargs["json"]["logs"]
        self.assertEqual([entry["worker_id"] for entry in sent], [SERVER_ID])
        self.assertEqual(self._row(log_id)["synced"], 1)
        self.assertEqual(database.count_unsynced_logs(), 0)

    def test_sync_prefers_live_server_id_over_stale_snapshot(self):
        """Worker deleted and re-created on the server: queued rows follow the current id."""
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id="old-server-id")
        database.log_attendance(worker_id=worker_id, worker_name="caleb", action="clock_in")
        database.add_worker(name="caleb", encoding=ENCODING, server_id=None)  # name match keeps the row
        conn = database._get_conn()
        conn.execute("UPDATE workers SET server_id = 'new-server-id' WHERE id = ?", (worker_id,))
        conn.commit()

        with mock.patch.object(sync.requests, "post", return_value=_ok_response()) as post:
            self.assertTrue(sync.sync_attendance())

        sent = post.call_args.kwargs["json"]["logs"]
        self.assertEqual([entry["worker_id"] for entry in sent], ["new-server-id"])

    def test_orphaned_rows_stay_queued_and_warn_once_per_set(self):
        self._insert_legacy_row(4, ts="2026-06-01T08:00:00")
        self._insert_legacy_row(4, ts="2026-06-02T08:00:00")

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

    def test_orphan_warning_repeats_hourly_while_unchanged(self):
        self._insert_legacy_row(4)
        with mock.patch.object(sync.requests, "post"):
            with self.assertLogs(sync.logger, level=logging.DEBUG) as first:
                sync.sync_attendance()
            sync._last_orphan_warned_at -= sync.ORPHAN_REWARN_SEC + 1
            with self.assertLogs(sync.logger, level=logging.DEBUG) as later:
                sync.sync_attendance()

        self.assertEqual(sum(r.levelno >= logging.WARNING for r in first.records), 1)
        self.assertEqual(sum(r.levelno >= logging.WARNING for r in later.records), 1)

    def test_hand_entered_value_that_is_not_a_server_id_is_never_sent(self):
        """An operator typo (employee id, name) must stay queued rather than be stored server-side."""
        log_id = self._insert_legacy_row(4)
        conn = database._get_conn()
        conn.execute("UPDATE attendance_log SET server_worker_id = 'E1042' WHERE id = ?", (log_id,))
        conn.commit()

        with mock.patch.object(sync.requests, "post") as post:
            with self.assertLogs(sync.logger, level=logging.ERROR) as logs:
                self.assertFalse(sync.sync_attendance())
            post.assert_not_called()

        self.assertIn("'E1042'", logs.output[0])
        self.assertEqual(self._row(log_id)["synced"], 0)

    def test_mixed_batch_sends_mapped_rows_and_keeps_orphans(self):
        worker_id = database.add_worker(name="prime", encoding=ENCODING, server_id="server-prime")
        good_id = database.log_attendance(worker_id=worker_id, worker_name="prime", action="clock_in")
        orphan_id = self._insert_legacy_row(4)

        with mock.patch.object(sync.requests, "post", return_value=_ok_response()) as post:
            self.assertFalse(sync.sync_attendance())  # not fully drained

        sent = post.call_args.kwargs["json"]["logs"]
        self.assertEqual([entry["worker_id"] for entry in sent], ["server-prime"])
        self.assertEqual(self._row(good_id)["synced"], 1)
        self.assertEqual(self._row(orphan_id)["synced"], 0)

    def test_orphan_rows_sync_once_server_worker_id_is_set(self):
        """The operator replay path: set server_worker_id on stranded rows and let sync send them."""
        self._insert_legacy_row(4)
        with mock.patch.object(sync.requests, "post") as post:
            self.assertFalse(sync.sync_attendance())
            post.assert_not_called()

        conn = database._get_conn()
        conn.execute("UPDATE attendance_log SET server_worker_id = ? WHERE worker_id = 4 AND synced = 0", (SERVER_ID,))
        conn.commit()

        with mock.patch.object(sync.requests, "post", return_value=_ok_response()) as post:
            self.assertTrue(sync.sync_attendance())
        sent = post.call_args.kwargs["json"]["logs"]
        self.assertEqual([entry["worker_id"] for entry in sent], [SERVER_ID])
        self.assertEqual(database.count_unsynced_logs(), 0)


if __name__ == "__main__":
    unittest.main()
