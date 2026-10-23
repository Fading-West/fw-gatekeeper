"""Roster receipts require durable apply and a live recognizer reload."""
import json
import os
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

    def test_inactive_null_biometrics_revoke_in_receipt_and_legacy_sync(self):
        for protocol in ('full', 'incremental', 'legacy'):
            with self.subTest(protocol=protocol), tempfile.TemporaryDirectory() as tmp, \
                 mock.patch.object(config, 'PHOTO_DIR', tmp):
                database.delete_sync_state('last_roster_applied_at')
                database.delete_sync_state('last_worker_sync')
                if protocol == 'incremental':
                    database.set_sync_state('last_roster_applied_at', '2026-09-01T00:00:00Z')
                photo = Path(tmp) / f'{SERVER_ID}.jpg'
                photo.write_bytes(b'cached biometric thumbnail')
                database.add_worker('Revoked', ENCODING, server_id=SERVER_ID, photo_paths=[str(photo)])
                # Identifiers and active state suffice; no name or biometric data is needed.
                rows = [{'id': SERVER_ID, 'active': 0, 'face_encoding': None, 'photo_url': None}]
                response = roster(rows, full=protocol == 'full')
                if protocol == 'legacy':
                    response = mock.Mock(status_code=200, json=lambda: {
                        'workers': rows, 'synced_at': '2026-09-25T12:00:00Z',
                    })
                with mock.patch.object(sync, '_download_photo') as download, \
                     self.assertLogs(sync.logger, level='INFO') as logs:
                    posted, recognizer = self.cycle(response, post=lambda *a, **kw: ack())
                download.assert_not_called()
                self.assertIsNone(database.get_worker_by_name('Revoked'))
                self.assertFalse(photo.exists())
                recognizer.reload_faces.assert_called_once()
                self.assertFalse(any(record.levelno >= 30 for record in logs.records))
                self.assertIsNone(database.get_sync_state('roster_pending_receipt'))
                self.assertEqual(database.get_sync_state('last_worker_sync'), '2026-09-25T12:00:00Z')
                if protocol == 'legacy':
                    posted.assert_not_called()
                else:
                    posted.assert_called_once()
                    self.assertEqual(database.get_sync_state('last_roster_applied_at'), '2026-09-25T12:00:00Z')

    def test_failed_update_cannot_block_later_explicit_revocations(self):
        update = {'id': 'other-worker', 'name': 'Other', 'active': True,
                  'face_encoding': ENCODING.tolist(), 'photo_url': 'https://photo.invalid'}
        failures = [update, {**update, 'face_encoding': [0.1]}, {'id': 'malformed'}, None]
        watermark = '2026-09-01T00:00:00Z'
        for failed_row in failures:
            with self.subTest(failed_row=failed_row):
                database.add_worker('Revoked', ENCODING, server_id=SERVER_ID)
                database.add_worker('Unenrolled', ENCODING, server_id='null-template')
                database.add_worker('Preserved', ENCODING, server_id='not-in-response')
                database.set_sync_state('last_worker_sync', watermark)
                rows = [failed_row, {'id': SERVER_ID, 'active': False},
                        {'id': 'null-template', 'name': 'Unenrolled', 'active': True,
                         'face_encoding': None, 'photo_url': None}]
                with mock.patch.object(sync, '_download_photo', return_value=None):
                    posted, recognizer = self.cycle(roster(rows))
                posted.assert_not_called()
                recognizer.reload_faces.assert_called_once()
                self.assertIsNone(database.get_worker_by_name('Revoked'))
                self.assertIsNone(database.get_worker_by_name('Unenrolled'))
                # A failed full response cannot authorize deleting omitted rows.
                self.assertIsNotNone(database.get_worker_by_name('Preserved'))
                self.assertIsNone(database.get_sync_state('roster_pending_receipt'))
                self.assertEqual(database.get_sync_state('last_worker_sync'), watermark)

    def test_pending_cleanup_and_failed_revocation_cleanup_do_not_block_removals(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            orphan = Path(tmp) / 'retired.jpg'
            orphan.write_bytes(b'pending cleanup from previous sync')
            database.record_photo_cleanup([orphan], 'retired')
            database.add_worker('Revoked', ENCODING, server_id=SERVER_ID)
            database.add_worker('Unenrolled', ENCODING, server_id='null-template')
            rows = [{'id': SERVER_ID, 'active': False},
                    {'id': 'null-template', 'name': 'Unenrolled', 'active': True,
                     'face_encoding': None, 'photo_url': None}]
            with mock.patch.object(Path, 'unlink', side_effect=PermissionError('read-only disk')):
                posted, recognizer = self.cycle(roster(rows))
            posted.assert_not_called()
            recognizer.reload_faces.assert_called_once()
            self.assertIsNone(database.get_worker_by_name('Revoked'))
            self.assertIsNone(database.get_worker_by_name('Unenrolled'))
            self.assertTrue(orphan.exists())
            self.assertIsNone(database.get_sync_state('roster_pending_receipt'))
            self.assertIsNone(database.get_sync_state('last_worker_sync'))
            posted, _ = self.cycle(roster(rows), post=lambda *a, **kw: ack())
            self.assertEqual(posted.call_count, 1)
            self.assertFalse(orphan.exists())

    def test_failed_revocation_database_write_does_not_block_later_revocations(self):
        database.add_worker('Blocked', ENCODING, server_id='blocked-worker')
        database.add_worker('Revoked', ENCODING, server_id=SERVER_ID)
        conn = database._get_conn()
        conn.execute("CREATE TRIGGER fail_one_delete BEFORE DELETE ON workers "
                     "WHEN OLD.server_id = 'blocked-worker' BEGIN SELECT RAISE(FAIL, 'disk write failed'); END")
        rows = [{'id': 'blocked-worker', 'active': False}, {'id': SERVER_ID, 'active': False}]
        posted, recognizer = self.cycle(roster(rows))
        posted.assert_not_called()
        recognizer.reload_faces.assert_called_once()
        self.assertIsNotNone(database.get_worker_by_name('Blocked'))
        self.assertIsNone(database.get_worker_by_name('Revoked'))
        self.assertIsNone(database.get_sync_state('roster_pending_receipt'))
        self.assertIsNone(database.get_sync_state('last_worker_sync'))

    def test_legacy_invalid_update_cannot_block_explicit_deactivation(self):
        database.add_worker('Revoked', ENCODING, server_id=SERVER_ID)
        legacy = mock.Mock(status_code=200, json=lambda: {
            'workers': [{'id': 'other-worker', 'name': 'Other', 'active': True,
                         'face_encoding': ['invalid']}, {'id': SERVER_ID, 'active': False}],
            'synced_at': '2026-09-25T12:00:00Z',
        })
        posted, recognizer = self.cycle(legacy)
        posted.assert_not_called()
        recognizer.reload_faces.assert_called_once()
        self.assertIsNone(database.get_worker_by_name('Revoked'))
        self.assertIsNone(database.get_sync_state('last_worker_sync'))

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
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', str(Path(tmp) / 'faces')):
            outside = Path(tmp) / 'legacy.jpg'
            outside.write_bytes(b'legacy biometric thumbnail')
            database.add_worker('Alex', ENCODING, server_id=SERVER_ID, photo_paths=[str(outside)])
            posted, _ = self.cycle(roster([{'id': SERVER_ID, 'active': False}]))
            posted.assert_not_called()
            self.assertIsNone(database.get_worker_by_name('Alex'))
            self.assertTrue(outside.exists())

    def test_retired_thumbnail_cleanup_must_succeed_before_ack(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            legacy = Path(tmp) / 'Alex.jpg'
            legacy.write_bytes(b'old biometric thumbnail')
            database.add_worker('Alex', ENCODING, server_id=SERVER_ID, photo_paths=[str(legacy)])
            with mock.patch.object(Path, 'unlink', side_effect=PermissionError('read-only disk')):
                posted, _ = self.cycle(roster([{'id': SERVER_ID, 'active': False}]))
            posted.assert_not_called()
            self.assertTrue(legacy.exists())
            self.assertIsNone(database.get_worker_by_name('Alex'))
            posted, _ = self.cycle(roster([{'id': SERVER_ID, 'active': False}]), post=lambda *a, **kw: ack())
            self.assertEqual(posted.call_count, 1)
            self.assertFalse(legacy.exists())

    def test_row_gone_legacy_thumbnail_blocks_ack_without_deleting_unknown_file(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            legacy = Path(tmp) / 'Alex.jpg'
            legacy.write_bytes(b'old biometric thumbnail')
            # An older client already deleted Alex's SQLite row, losing the
            # reference that could have identified this name-based thumbnail.
            posted, _ = self.cycle(roster([{'id': SERVER_ID, 'active': False}]))
            posted.assert_not_called()
            self.assertEqual(legacy.read_bytes(), b'old biometric thumbnail')
            self.assertIsNone(database.get_sync_state('roster_pending_receipt'))
            legacy.unlink()
            posted, _ = self.cycle(roster([{'id': SERVER_ID, 'active': False}]), post=lambda *a, **kw: ack())
            self.assertEqual(posted.call_count, 1)

    def test_row_gone_server_id_thumbnail_is_cleaned_before_ack(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            known = Path(tmp) / f'{SERVER_ID}.jpg'
            known.write_bytes(b'old biometric thumbnail')
            with mock.patch.object(Path, 'unlink', side_effect=PermissionError('read-only disk')):
                posted, _ = self.cycle(roster([{'id': SERVER_ID, 'active': False}]))
            posted.assert_not_called()
            self.assertTrue(known.exists())
            posted, _ = self.cycle(roster([{'id': SERVER_ID, 'active': False}]), post=lambda *a, **kw: ack())
            self.assertEqual(posted.call_count, 1)
            self.assertFalse(known.exists())

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

    def test_adopting_local_enrollment_retires_all_unshared_capture_photos(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            captures = [Path(tmp) / f'Alex-{index}.jpg' for index in (1, 2)]
            shared = Path(tmp) / 'Shared.jpg'
            for path in [*captures, shared]:
                path.write_bytes(b'old capture')
            local_id = database.add_worker('Alex', ENCODING, employee_id='E1',
                                           photo_paths=[*(str(path) for path in captures), str(shared)])
            database.add_worker('Taylor', ENCODING, server_id='other-server-id', photo_paths=[str(shared)])
            database.set_sync_state('last_roster_applied_at', '2026-09-01T00:00:00Z')
            row = {'id': SERVER_ID, 'name': 'Alex', 'employee_id': 'E1', 'active': True,
                   'face_encoding': ENCODING.tolist(), 'photo_url': 'https://photo.invalid/new'}
            response = roster([row], full=False)
            response.content = b'new photo'
            posted, _ = self.cycle(response, post=lambda *a, **kw: ack())
            self.assertEqual(posted.call_count, 1)
            adopted = database.get_worker_by_name('Alex')
            self.assertEqual(adopted['id'], local_id)
            self.assertEqual(adopted['server_id'], SERVER_ID)
            self.assertTrue(Path(adopted['photo_paths'][0]).exists())
            self.assertTrue(all(not path.exists() for path in captures))
            self.assertTrue(shared.exists())
            self.assertEqual(database.list_unreferenced_photo_files(), [])

    def test_ambiguous_local_enrollment_does_not_retire_any_capture_photo(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            captures = [Path(tmp) / f'Alex-{index}.jpg' for index in (1, 2)]
            for path in captures:
                path.write_bytes(b'old capture')
            database.add_worker('Alex', ENCODING, photo_paths=[str(captures[0])])
            # SQLite permits duplicate local labels; insert the second row
            # directly because add_worker intentionally refuses ambiguity.
            conn = database._get_conn()
            conn.execute(
                "INSERT INTO workers (name, employee_id, encoding_blob, enrolled_at, photo_count, photo_paths) "
                "SELECT name, employee_id, encoding_blob, enrolled_at, 1, ? FROM workers LIMIT 1",
                (json.dumps([str(captures[1])]),),
            )
            conn.commit()
            row = {'id': SERVER_ID, 'name': 'Alex', 'employee_id': '', 'active': True,
                   'face_encoding': ENCODING.tolist(), 'photo_url': None}
            posted, _ = self.cycle(roster([row]))
            posted.assert_not_called()
            self.assertTrue(all(path.exists() for path in captures))
            self.assertEqual(database.get_synced_server_ids(), set())

    def test_conflicting_employee_id_preserves_local_photo_and_blocks_ack(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            local_photo = Path(tmp) / 'Alex-Local.jpg'
            local_photo.write_bytes(b'local capture')
            local_id = database.add_worker('Alex', ENCODING, employee_id='E2', photo_paths=[str(local_photo)])
            row = {'id': SERVER_ID, 'name': 'Alex', 'employee_id': 'E1', 'active': True,
                   'face_encoding': ENCODING.tolist(), 'photo_url': None}
            posted, _ = self.cycle(roster([row]))
            posted.assert_not_called()
            self.assertEqual(database.get_worker_by_id(local_id)['photo_paths'], [str(local_photo)])
            self.assertTrue(local_photo.exists())
            self.assertEqual(len(database.get_all_workers()), 2)

    def test_malformed_full_response_cannot_delete_roster_or_ack(self):
        database.add_worker('Alex', ENCODING, server_id=SERVER_ID)
        missing_workers = mock.Mock(status_code=200, json=lambda: {
            'roster_receipt': 'receipt-one', 'synced_at': '2026-09-25T12:00:00Z', 'full_roster': True,
        })
        malformed_rows = [
            {'id': SERVER_ID},
            {'id': SERVER_ID, 'active': None},
            {'id': SERVER_ID, 'active': 'false'},
            {'id': SERVER_ID, 'name': 'Alex', 'active': True, 'photo_url': None},
            {'id': SERVER_ID, 'name': 'Alex', 'active': True, 'face_encoding': None},
            {'id': SERVER_ID, 'name': 'Alex', 'active': True, 'face_encoding': ENCODING.tolist()},
            {'id': SERVER_ID, 'name': 'Alex', 'active': True, 'face_encoding': [float('nan')] * 512, 'photo_url': None},
        ]
        for response in (missing_workers, *(roster([row], full=True) for row in malformed_rows)):
            with self.subTest(response=response):
                posted, _ = self.cycle(response)
                posted.assert_not_called()
                self.assertIsNotNone(database.get_worker_by_name('Alex'))
                self.assertIsNone(database.get_sync_state('roster_pending_receipt'))

    def test_conflicting_duplicate_rows_revoke_but_cannot_ack(self):
        database.add_worker('Alex', ENCODING, server_id=SERVER_ID)
        rows = [{'id': SERVER_ID, 'active': False},
                {'id': SERVER_ID, 'name': 'Alex', 'active': True,
                 'face_encoding': ENCODING.tolist(), 'photo_url': None}]
        posted, recognizer = self.cycle(roster(rows))
        posted.assert_not_called()
        recognizer.reload_faces.assert_called_once()
        self.assertIsNone(database.get_worker_by_name('Alex'))
        self.assertIsNone(database.get_sync_state('roster_pending_receipt'))
        self.assertIsNone(database.get_sync_state('last_worker_sync'))

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

    def test_sqlite_update_failure_keeps_old_photo_and_reference(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            old = Path(tmp) / 'Alex.jpg'
            old.write_bytes(b'original photo')
            database.add_worker('Alex', ENCODING, server_id=SERVER_ID, photo_paths=[str(old)])
            conn = database._get_conn()
            conn.execute("CREATE TRIGGER fail_photo_update BEFORE UPDATE ON workers BEGIN SELECT RAISE(FAIL, 'disk write failed'); END")
            updated = {'id': SERVER_ID, 'name': 'Alex', 'active': True,
                       'face_encoding': ENCODING.tolist(), 'photo_url': 'https://photo.invalid/new'}
            response = roster([updated])
            response.content = b'new photo'
            posted, _ = self.cycle(response)
            posted.assert_not_called()
            self.assertEqual(old.read_bytes(), b'original photo')
            self.assertEqual(database.get_worker_by_name('Alex')['photo_paths'], [str(old)])
            self.assertEqual(list(Path(tmp).iterdir()), [old])
            conn.execute('DROP TRIGGER fail_photo_update')
            conn.commit()
            posted, _ = self.cycle(response, post=lambda *a, **kw: ack())
            self.assertEqual(posted.call_count, 1)
            self.assertFalse(old.exists())

    def test_cleanup_failure_after_update_keeps_old_file_and_blocks_ack(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            old = Path(tmp) / 'Alex.jpg'
            old.write_bytes(b'original photo')
            database.add_worker('Alex', ENCODING, server_id=SERVER_ID, photo_paths=[str(old)])
            updated = {'id': SERVER_ID, 'name': 'Alex', 'active': True,
                       'face_encoding': ENCODING.tolist(), 'photo_url': 'https://photo.invalid/new'}
            response = roster([updated])
            response.content = b'new photo'
            with mock.patch.object(Path, 'unlink', side_effect=PermissionError('cleanup failed')):
                posted, _ = self.cycle(response)
            posted.assert_not_called()
            self.assertEqual(old.read_bytes(), b'original photo')
            self.assertNotEqual(database.get_worker_by_name('Alex')['photo_paths'], [str(old)])
            # A later cycle recovers the journaled old file before applying
            # the roster again, so no manual cleanup is needed.
            posted, _ = self.cycle(response, post=lambda *a, **kw: ack())
            self.assertEqual(posted.call_count, 1)
            self.assertFalse(old.exists())

    def test_restart_recovers_published_and_retired_photos_without_touching_unknown_files(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            old = Path(tmp) / 'Alex.jpg'
            old.write_bytes(b'old photo')
            database.add_worker('Alex', ENCODING, server_id=SERVER_ID, photo_paths=[str(old)])
            published = Path(tmp) / f'{SERVER_ID}-interrupted.jpg'
            staged = Path(tmp) / f'.{SERVER_ID}-interrupted.tmp'
            database.record_photo_cleanup([published], 'published')
            database.record_photo_cleanup([staged], 'published')
            staged.write_bytes(b'new photo')
            os.replace(staged, published)  # crash before SQLite commit
            self._close_db()
            database.init_db()
            database.recover_photo_cleanup()
            self.assertFalse(published.exists())
            self.assertEqual(old.read_bytes(), b'old photo')
            self.assertEqual(database.get_worker_by_name('Alex')['photo_paths'], [str(old)])

            replacement = Path(tmp) / f'{SERVER_ID}-committed.jpg'
            replacement.write_bytes(b'committed photo')
            database.record_photo_cleanup([old], 'retired')
            database.record_photo_cleanup([replacement], 'published')
            database.add_worker('Alex', ENCODING, server_id=SERVER_ID, photo_paths=[str(replacement)])
            self._close_db()  # crash after SQLite commit, before old photo cleanup
            database.init_db()
            database.recover_photo_cleanup()
            self.assertFalse(old.exists())
            self.assertEqual(replacement.read_bytes(), b'committed photo')
            self.assertEqual(database.get_worker_by_name('Alex')['photo_paths'], [str(replacement)])

            unknown = Path(tmp) / 'Unknown-Legacy.jpg'
            unknown.write_bytes(b'unmanaged photo')
            posted, _ = self.cycle(roster([{'id': SERVER_ID, 'active': False}]))
            posted.assert_not_called()
            self.assertTrue(unknown.exists())

    def test_legacy_deactivation_survives_thumbnail_permission_failure(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            photo = Path(tmp) / 'Alex.jpg'
            photo.write_bytes(b'old biometric thumbnail')
            database.add_worker('Alex', ENCODING, server_id=SERVER_ID, photo_paths=[str(photo)])
            legacy = mock.Mock(status_code=200, json=lambda: {
                'workers': [{'id': SERVER_ID, 'active': False}], 'synced_at': '2026-09-25T12:00:00Z',
            })
            with mock.patch.object(Path, 'unlink', side_effect=PermissionError('read-only disk')):
                _, recognizer = self.cycle(legacy)
            self.assertIsNone(database.get_worker_by_name('Alex'))
            self.assertTrue(photo.exists())
            recognizer.reload_faces.assert_called_once()
            posted, _ = self.cycle(roster([]), post=lambda *a, **kw: ack())
            self.assertEqual(posted.call_count, 1)
            self.assertFalse(photo.exists())


if __name__ == '__main__':
    unittest.main()
