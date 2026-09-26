"""Offline attendance batching/retry tests backed by real SQLite."""
import unittest
from unittest import mock

import test_sync_mapping as mapping
from test_sync_mapping import ENCODING, SERVER_ID
import database
import sync


def response(data):
    return mock.Mock(status_code=200, json=lambda: data)


def rejected(reason='timestamp must be a valid ISO date and time, with optional UTC offset'):
    return mock.Mock(status_code=400, json=lambda: {'error': reason, 'code': 'INVALID_ATTENDANCE'})


class AttendanceBatchTests(unittest.TestCase):
    setUp = mapping.AttendanceServerIdMappingTests.setUp
    _close_db = staticmethod(mapping.AttendanceServerIdMappingTests._close_db)
    _insert_legacy_row = mapping.AttendanceServerIdMappingTests._insert_legacy_row

    def enqueue(self, count):
        worker = database.add_worker('Alex', ENCODING, server_id=SERVER_ID)
        for index in range(count):
            database.log_attendance(worker, 'Alex', 'clock_in', timestamp=f'2026-06-01T08:{index // 60:02}:{index % 60:02}')

    def test_large_offline_queue_uses_bounded_batches(self):
        self.enqueue(235)
        def accept(*args, **kwargs):
            size = len(kwargs['json']['logs'])
            self.assertLessEqual(size, 100)
            return response({'synced': size, 'acknowledged': size})
        with mock.patch.object(sync.requests, 'post', side_effect=accept) as post:
            self.assertTrue(sync.sync_attendance())
        self.assertEqual([len(call.kwargs['json']['logs']) for call in post.call_args_list], [100, 100, 35])
        self.assertEqual(database.count_unsynced_logs(), 0)

    def test_timeout_after_first_page_retains_failed_and_future_pages_for_retry(self):
        self.enqueue(205)
        with mock.patch.object(sync.requests, 'post', side_effect=[response({'acknowledged': 100}), sync.requests.Timeout('lost response')]) as post:
            self.assertFalse(sync.sync_attendance())
            failed_payload = post.call_args.kwargs['json']
        self.assertEqual(database.count_unsynced_logs(), 105)
        with mock.patch.object(sync.requests, 'post', return_value=response({'synced': 0})) as post:
            self.assertTrue(sync.sync_attendance())
            self.assertEqual(post.call_args_list[0].kwargs['json'], failed_payload)
        self.assertEqual(database.count_unsynced_logs(), 0)

    def test_malformed_or_partial_success_response_does_not_discard_records(self):
        self.enqueue(2)
        for data in ({}, [], {'synced': True}, {'synced': -1}, {'synced': 3}, {'acknowledged': 1, 'synced': 2}, {'acknowledged': '2'}):
            with self.subTest(data=data), mock.patch.object(sync.requests, 'post', return_value=response(data)):
                self.assertFalse(sync.sync_attendance())
                self.assertEqual(database.count_unsynced_logs(), 2)
        bad_json = mock.Mock(status_code=200, json=mock.Mock(side_effect=ValueError('not JSON')))
        with mock.patch.object(sync.requests, 'post', return_value=bad_json):
            self.assertFalse(sync.sync_attendance())
        self.assertEqual(database.count_unsynced_logs(), 2)

    def test_orphan_pages_do_not_starve_later_attendance_and_are_revisited(self):
        for _ in range(5):
            self._insert_legacy_row(999)
        self.enqueue(1)
        with mock.patch.object(sync, 'ATTENDANCE_BATCH_SIZE', 2), mock.patch.object(sync, 'ATTENDANCE_PAGES_PER_CYCLE', 2), mock.patch.object(sync.requests, 'post', return_value=response({'acknowledged': 1})) as post:
            self.assertFalse(sync.sync_attendance())
            post.assert_not_called()
            self.assertFalse(sync.sync_attendance())
            post.assert_called_once()
        self.assertEqual(database.count_unsynced_logs(), 5)
        self.assertEqual(database.get_sync_state('attendance_scan_after'), '0')
        conn = database._get_conn()
        conn.execute('UPDATE attendance_log SET server_worker_id = ? WHERE worker_id = 999', (SERVER_ID,))
        conn.commit()
        with mock.patch.object(sync.requests, 'post', return_value=response({'acknowledged': 5})):
            self.assertTrue(sync.sync_attendance())

    def test_poisoned_row_is_isolated_while_later_pages_sync(self):
        self.enqueue(235)
        conn = database._get_conn()
        conn.execute("UPDATE attendance_log SET timestamp = 'bad' WHERE id = 37")
        conn.commit()

        def server(*args, **kwargs):
            logs = kwargs['json']['logs']
            return rejected() if any(log['timestamp'] == 'bad' for log in logs) else response({'acknowledged': len(logs)})

        with mock.patch.object(sync.requests, 'post', side_effect=server) as post:
            self.assertFalse(sync.sync_attendance())
        self.assertLessEqual(len(post.call_args_list), sync.ATTENDANCE_REQUESTS_PER_CYCLE)
        self.assertEqual(database.count_unsynced_logs(), 1)
        rejection = database.list_attendance_rejections()[0]
        self.assertEqual(rejection['log_id'], 37)
        self.assertIn('"timestamp": "bad"', rejection['original_log_json'])
        self.assertEqual(conn.execute('SELECT synced FROM attendance_log WHERE id = 37').fetchone()[0], 0)

        # Restart preserves the quarantine and allows a documented repair/retry.
        self._close_db()
        database.init_db()
        self.assertEqual(len(database.list_attendance_rejections()), 1)
        conn = database._get_conn()
        conn.execute("UPDATE attendance_log SET timestamp = '2026-06-01T09:00:00' WHERE id = 37")
        conn.commit()
        database.retry_attendance_rejection(rejection['id'], 'Corrected malformed local timestamp after review')
        with mock.patch.object(sync.requests, 'post', side_effect=server):
            self.assertTrue(sync.sync_attendance())
        self.assertEqual(database.list_attendance_rejections(), [])
        self.assertEqual(conn.execute('SELECT synced FROM attendance_log WHERE id = 37').fetchone()[0], 1)

    def test_transient_and_auth_errors_never_quarantine(self):
        self.enqueue(2)
        failures = [
            mock.Mock(status_code=400, json=lambda: {'error': 'Bad Request'}),
            mock.Mock(status_code=401, json=lambda: {'error': 'Unauthorized'}),
            mock.Mock(status_code=403, json=lambda: {'error': 'Forbidden'}),
            mock.Mock(status_code=500, json=lambda: {'error': 'server failed'}),
        ]
        for failure in failures:
            with self.subTest(status=failure.status_code), mock.patch.object(sync.requests, 'post', return_value=failure):
                self.assertFalse(sync.sync_attendance())
                self.assertEqual(database.count_unsynced_logs(), 2)
                self.assertEqual(database.list_attendance_rejections(), [])
        with mock.patch.object(sync.requests, 'post', return_value=response({'acknowledged': 2})):
            self.assertTrue(sync.sync_attendance())

    def test_transient_error_during_isolation_keeps_remaining_rows_retryable(self):
        self.enqueue(4)
        conn = database._get_conn()
        conn.execute("UPDATE attendance_log SET timestamp = 'bad' WHERE id = 1")
        conn.commit()
        transient = mock.Mock(status_code=503, json=lambda: {'error': 'Retry pending'})
        with mock.patch.object(sync.requests, 'post', side_effect=[rejected(), rejected(), rejected(), transient]):
            self.assertFalse(sync.sync_attendance())
        self.assertEqual([r['log_id'] for r in database.list_attendance_rejections()], [1])
        self.assertEqual(database.count_unsynced_logs(), 4)

        def server(*args, **kwargs):
            logs = kwargs['json']['logs']
            return response({'acknowledged': len(logs)})
        with mock.patch.object(sync.requests, 'post', side_effect=server):
            self.assertFalse(sync.sync_attendance())
        self.assertEqual(database.count_unsynced_logs(), 1)


if __name__ == '__main__':
    unittest.main()
