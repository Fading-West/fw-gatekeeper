"""Synthetic real-SQLite lock ordering; no services or network."""
import threading
import unittest
from unittest import mock
import numpy as np
from test_oct02_recognition_roster_race import Fixture, database

class RosterTransactionQA(Fixture):
    def test_concurrent_roster_delete_waits_until_verified_scan_commits(self):
        started, finished = threading.Event(), threading.Event()
        errors = []
        original = database.get_worker_by_id
        def delete_worker():
            try:
                started.set()
                database.remove_worker_by_server_id('synthetic-server-id')
            except Exception as error:
                errors.append(error)
            finally:
                self.close()
                finished.set()
        thread = threading.Thread(target=delete_worker)
        def checked(worker_id):
            row = original(worker_id)
            thread.start()
            self.assertTrue(started.wait(1))
            self.assertFalse(finished.wait(.05), 'roster mutation must wait for write transaction')
            return row
        try:
            with mock.patch.object(database, 'get_worker_by_id', side_effect=checked):
                database.log_recognized_attendance(worker_id=self.worker,
                    server_worker_id='synthetic-server-id', expected_encoding=np.ones(512),
                    worker_name='Synthetic Employee', action='clock_in')
        finally:
            thread.join(timeout=2)
        self.assertTrue(finished.is_set())
        self.assertEqual(errors, [])
        self.assertIsNone(original(self.worker))
        logs = database.get_unsynced_logs()
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]['server_worker_id'], 'synthetic-server-id')

if __name__ == '__main__': unittest.main()
