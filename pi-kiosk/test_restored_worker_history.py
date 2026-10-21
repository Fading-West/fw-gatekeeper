"""A worker removed by roster sync and restored later keeps their attendance history.

Deactivating a worker deletes the kiosk row; reactivating them (same Convex id)
inserts a new local row with a new autoincrement id. Direction toggling and the
debounce must still see the events already recorded for that Convex worker.
"""
import unittest
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
            self.assertEqual(app._manual_action_for_worker(restored), "clock_out")

    def test_restored_worker_is_still_debounced(self):
        restored = self._restore()
        self.assertTrue(database.was_recently_clocked(restored, 5))

    def test_other_workers_history_is_not_shared(self):
        self._restore()
        other = database.add_worker("taylor", -ENCODING, server_id=OTHER_SERVER_ID)
        local_only = database.add_worker("morgan", -ENCODING)
        for worker_id in (other, local_only):
            self.assertIsNone(database.get_last_action(worker_id))
            self.assertFalse(database.was_recently_clocked(worker_id, 5))


if __name__ == "__main__":
    unittest.main()
