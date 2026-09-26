"""Roster receipts require durable apply and a live recognizer reload."""
import unittest
import tempfile
from pathlib import Path
from unittest import mock

from test_sync_mapping import ENCODING, SERVER_ID, AttendanceServerIdMappingTests
import config
import database
import sync


def roster(rows, receipt='receipt-one', full=True):
    return mock.Mock(status_code=200, json=lambda: {
        'workers': rows, 'roster_receipt': receipt,
        'synced_at': '2026-09-25T12:00:00Z', 'full_roster': full,
    })


def ack(receipt='receipt-one'):
    return mock.Mock(status_code=200, json=lambda: {
        'acknowledged': True, 'applied_at': '2026-09-25T12:00:00Z',
    })


class RosterReceiptTests(unittest.TestCase):
    setUp = AttendanceServerIdMappingTests.setUp
    _close_db = staticmethod(AttendanceServerIdMappingTests._close_db)

    def cycle(self, response, *, recognizer=None, post=None, online=True):
        recognizer = recognizer or mock.Mock()
        worker = sync.SyncWorker(recognizer=recognizer)
        worker._running = True
        def stop(_seconds):
            worker._running = False
        with mock.patch.object(sync, 'check_server', return_value=online), \
             mock.patch.object(sync.requests, 'get', return_value=response), \
             mock.patch.object(sync.requests, 'post', side_effect=post) as posted, \
             mock.patch.object(sync, 'sync_attendance', return_value=True), \
             mock.patch.object(sync, 'sync_recognition_attempts', return_value=True), \
             mock.patch.object(sync.time, 'sleep', side_effect=stop), \
             mock.patch.object(config, 'SYNC_INTERVAL', 1):
            worker._run()
        return posted, recognizer

    def test_download_failure_and_partial_apply_never_ack(self):
        row = {'id': SERVER_ID, 'name': 'Alex', 'employee_id': 'E1', 'active': True,
               'face_encoding': ENCODING.tolist(), 'photo_url': 'https://photo.invalid'}
        with mock.patch.object(sync, '_download_photo', return_value=None):
            posted, _ = self.cycle(roster([row]))
        posted.assert_not_called()
        self.assertIsNone(database.get_sync_state('roster_pending_receipt'))

        good = {**row, 'photo_url': None}
        invalid = {**good, 'id': 'second', 'face_encoding': [0.1]}
        posted, _ = self.cycle(roster([good, invalid]))
        posted.assert_not_called()
        self.assertIsNotNone(database.get_worker_by_name('Alex'))
        self.assertIsNone(database.get_sync_state('roster_pending_receipt'))

    def test_reload_failure_then_retry_after_restart(self):
        database.add_worker('Alex', ENCODING, server_id=SERVER_ID)
        failing = mock.Mock()
        failing.reload_faces.side_effect = RuntimeError('reload failed')
        posted, _ = self.cycle(roster([{'id': SERVER_ID, 'active': False}]), recognizer=failing)
        posted.assert_not_called()
        self.assertIsNone(database.get_worker_by_name('Alex'))
        self.assertIsNotNone(database.get_sync_state('roster_pending_receipt'))
        self.assertIsNone(database.get_sync_state('last_roster_applied_at'))
        self._close_db()
        database.init_db()

        # A cached receipt alone is insufficient: an offline restart cannot ack.
        posted, _ = self.cycle(roster([]), online=False)
        posted.assert_not_called()
        posted, recognizer = self.cycle(roster([]), post=lambda *a, **kw: ack())
        self.assertEqual(posted.call_count, 1)
        recognizer.reload_faces.assert_called_once()
        self.assertEqual(database.get_sync_state('last_roster_applied_at'), '2026-09-25T12:00:00Z')

    def test_lost_ack_reapplies_then_retries_same_receipt(self):
        with self.assertLogs(sync.logger, level='WARNING'):
            posted, _ = self.cycle(roster([]), post=sync.requests.Timeout('lost ack'))
        self.assertEqual(posted.call_count, 1)
        self.assertIsNone(database.get_sync_state('last_roster_applied_at'))
        self.assertIsNotNone(database.get_sync_state('roster_pending_receipt'))
        posted, _ = self.cycle(roster([]), post=lambda *a, **kw: ack())
        self.assertEqual(posted.call_count, 1)
        self.assertIsNone(database.get_sync_state('roster_pending_receipt'))

    def test_unmanaged_profile_and_outside_thumbnail_block_ack(self):
        database.add_worker('Unmanaged', ENCODING)
        posted, _ = self.cycle(roster([]))
        posted.assert_not_called()
        self.assertIsNotNone(database.get_worker_by_name('Unmanaged'))
        database.remove_worker('Unmanaged')
        database.add_worker('Alex', ENCODING, server_id=SERVER_ID, photo_paths=['/outside/legacy.jpg'])
        posted, _ = self.cycle(roster([{'id': SERVER_ID, 'active': False}]))
        posted.assert_not_called()
        self.assertIsNotNone(database.get_worker_by_name('Alex'))

    def test_retired_thumbnail_cleanup_must_succeed_before_ack(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            legacy = Path(tmp) / 'Alex.jpg'
            legacy.write_bytes(b'old biometric thumbnail')
            database.add_worker('Alex', ENCODING, server_id=SERVER_ID, photo_paths=[str(legacy)])
            with mock.patch.object(Path, 'unlink', side_effect=PermissionError('read-only disk')):
                posted, _ = self.cycle(roster([{'id': SERVER_ID, 'active': False}]))
            posted.assert_not_called()
            self.assertTrue(legacy.exists())
            self.assertIsNotNone(database.get_worker_by_name('Alex'))
            posted, _ = self.cycle(roster([{'id': SERVER_ID, 'active': False}]), post=lambda *a, **kw: ack())
            self.assertEqual(posted.call_count, 1)
            self.assertFalse(legacy.exists())

    def test_invalid_update_preserves_existing_photo_and_reference(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            photo = Path(tmp) / f'{SERVER_ID}.jpg'
            photo.write_bytes(b'original photo')
            database.add_worker('Alex', ENCODING, server_id=SERVER_ID, photo_paths=[str(photo)])
            invalid = {'id': SERVER_ID, 'name': 'Alex', 'active': True,
                       'face_encoding': [0.1], 'photo_url': 'https://photo.invalid/new'}
            posted, _ = self.cycle(roster([invalid]))
            posted.assert_not_called()
            self.assertEqual(photo.read_bytes(), b'original photo')
            self.assertEqual(database.get_worker_by_name('Alex')['photo_paths'], [str(photo)])

    def test_malformed_full_response_cannot_delete_roster_or_ack(self):
        database.add_worker('Alex', ENCODING, server_id=SERVER_ID)
        missing_workers = mock.Mock(status_code=200, json=lambda: {
            'roster_receipt': 'receipt-one', 'synced_at': '2026-09-25T12:00:00Z', 'full_roster': True,
        })
        malformed_rows = [
            {'id': SERVER_ID},
            {'id': SERVER_ID, 'name': 'Alex', 'active': True, 'photo_url': None},
            {'id': SERVER_ID, 'name': 'Alex', 'active': True, 'face_encoding': ENCODING.tolist()},
            {'id': SERVER_ID, 'name': 'Alex', 'active': True, 'face_encoding': [float('nan')] * 512, 'photo_url': None},
        ]
        for response in (missing_workers, *(roster([row], full=True) for row in malformed_rows)):
            with self.subTest(response=response):
                posted, _ = self.cycle(response)
                posted.assert_not_called()
                self.assertIsNotNone(database.get_worker_by_name('Alex'))
                self.assertIsNone(database.get_sync_state('roster_pending_receipt'))

    def test_explicit_null_template_removes_cached_template_before_ack(self):
        database.add_worker('Alex', ENCODING, server_id=SERVER_ID)
        row = {'id': SERVER_ID, 'name': 'Alex', 'active': True,
               'face_encoding': None, 'photo_url': None}
        posted, recognizer = self.cycle(roster([row]), post=lambda *a, **kw: ack())
        self.assertEqual(posted.call_count, 1)
        recognizer.reload_faces.assert_called_once()
        self.assertIsNone(database.get_worker_by_name('Alex'))

    def test_failed_photo_publish_keeps_prior_file_and_no_ack(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            photo = Path(tmp) / f'{SERVER_ID}.jpg'
            photo.write_bytes(b'original photo')
            database.add_worker('Alex', ENCODING, server_id=SERVER_ID, photo_paths=[str(photo)])
            updated = {'id': SERVER_ID, 'name': 'Alex', 'active': True,
                       'face_encoding': ENCODING.tolist(), 'photo_url': 'https://photo.invalid/new'}
            response = roster([updated])
            response.content = b'new photo'
            with mock.patch.object(sync.os, 'replace', side_effect=PermissionError('publish failed')):
                posted, _ = self.cycle(response)
            posted.assert_not_called()
            self.assertEqual(photo.read_bytes(), b'original photo')
            self.assertEqual(list(Path(tmp).glob('*.tmp')), [])


if __name__ == '__main__':
    unittest.main()
