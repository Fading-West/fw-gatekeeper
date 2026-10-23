"""A worker removed by roster sync and restored later keeps their attendance history.

Deactivating a worker deletes the kiosk row; reactivating them (same Convex id)
inserts a new local row with a new autoincrement id. Direction toggling and the
debounce must still see the events already recorded for that Convex worker.
"""
import unittest
from datetime import datetime
from unittest import mock

import test_sync_mapping as mapping
from test_sync_mapping import ENCODING, SERVER_ID
import app
import config
import database

OTHER_SERVER_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


class RestoredWorkerHistoryTests(unittest.TestCase):
    setUp = mapping.AttendanceServerIdMappingTests.setUp
    _close_db = staticmethod(mapping.AttendanceServerIdMappingTests._close_db)
    _insert_legacy_row = mapping.AttendanceServerIdMappingTests._insert_legacy_row
    _row = mapping.AttendanceServerIdMappingTests._row

    def _assert_restored_history(self, restored):
        self.assertEqual(database.get_last_action(restored), "clock_in")
        self.assertTrue(database.was_recently_clocked(restored, 5))

    def _restore(self):
        first = database.add_worker("caleb", ENCODING, server_id=SERVER_ID)
        database.log_attendance(first, "caleb", "clock_in")
        database.remove_worker_by_server_id(SERVER_ID)
        restored = database.add_worker("caleb", ENCODING, server_id=SERVER_ID)
        self.assertNotEqual(restored, first)
        return restored

    def test_restored_worker_toggles_from_previous_clock_in(self):
        restored = self._restore()
        self.assertEqual(database.get_last_action(restored), "clock_in")
        with mock.patch.object(config, "KIOSK_TYPE", "auto"):
            # Action selection now shares the write transaction with the insert.
            log_id = database.log_attendance(restored, "caleb")
        self.assertEqual(database.get_attendance_action(log_id), "clock_out")

    def test_restored_worker_is_still_debounced(self):
        restored = self._restore()
        self.assertTrue(database.was_recently_clocked(restored, 5))

    def test_upgraded_kiosk_keeps_already_synced_legacy_history(self):
        """A clock-in uploaded by a release without server_worker_id, then an upgrade."""
        worker = database.add_worker("caleb", ENCODING, server_id=SERVER_ID)
        conn = database._get_conn()
        conn.executescript("""
            DROP TRIGGER attendance_keep_server_id_before_worker_delete;
            DROP INDEX IF EXISTS idx_attendance_server_worker;
            ALTER TABLE attendance_log DROP COLUMN server_worker_id;
        """)
        cursor = conn.execute(
            "INSERT INTO attendance_log (worker_id, worker_name, action, timestamp, synced) VALUES (?, 'caleb', 'clock_in', ?, 1)",
            (worker, datetime.now().isoformat(timespec="seconds")),
        )
        conn.commit()
        log_id = int(cursor.lastrowid)
        database.init_db()  # upgrade startup: adds the column, then backfills
        self.assertEqual(self._row(log_id)["server_worker_id"], SERVER_ID)
        database.remove_worker_by_server_id(SERVER_ID)
        self._assert_restored_history(database.add_worker("caleb", ENCODING, server_id=SERVER_ID))

    def test_removal_snapshots_synced_rows_logged_before_adoption(self):
        """Rows logged while the worker was local-only sync through the workers table."""
        local = database.add_worker("caleb", ENCODING)
        log_id = database.log_attendance(local, "caleb", "clock_in")
        self.assertIsNone(self._row(log_id)["server_worker_id"])
        self.assertEqual(database.add_worker("caleb", ENCODING, server_id=SERVER_ID), local)
        database.mark_synced([log_id])
        database.remove_worker_by_server_id(SERVER_ID)
        self.assertEqual(self._row(log_id)["server_worker_id"], SERVER_ID)
        self._assert_restored_history(database.add_worker("caleb", ENCODING, server_id=SERVER_ID))

    def test_backfill_never_overwrites_or_guesses_identity(self):
        worker = database.add_worker("caleb", ENCODING, server_id=SERVER_ID)
        captured = database.log_attendance(worker, "caleb", "clock_in", server_worker_id=OTHER_SERVER_ID)
        orphan = self._insert_legacy_row(worker + 100, synced=1)
        database.init_db()
        self.assertEqual(self._row(captured)["server_worker_id"], OTHER_SERVER_ID)
        self.assertIsNone(self._row(orphan)["server_worker_id"])

    def test_other_workers_history_is_not_shared(self):
        self._restore()
        other = database.add_worker("taylor", -ENCODING, server_id=OTHER_SERVER_ID)
        local_only = database.add_worker("morgan", -ENCODING)
        for worker_id in (other, local_only):
            self.assertIsNone(database.get_last_action(worker_id))
            self.assertFalse(database.was_recently_clocked(worker_id, 5))


if __name__ == "__main__":
    unittest.main()
