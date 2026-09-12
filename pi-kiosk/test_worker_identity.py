"""Real SQLite regressions for roster identity, duplicate labels and migration."""
import sqlite3
import unittest

import test_sync_mapping as mapping
from test_sync_mapping import ENCODING, SERVER_ID
import database
import sync


class WorkerIdentityTests(unittest.TestCase):
    setUp = mapping.AttendanceServerIdMappingTests.setUp
    _close_db = staticmethod(mapping.AttendanceServerIdMappingTests._close_db)
    _row = mapping.AttendanceServerIdMappingTests._row
    _insert_legacy_row = mapping.AttendanceServerIdMappingTests._insert_legacy_row

    def test_two_server_workers_with_same_name_remain_distinct(self):
        other_id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        first = database.add_worker('Alex', ENCODING, server_id=SERVER_ID, employee_id='FW-1')
        log_id = database.log_attendance(first, 'Alex', 'clock_in')
        second = database.add_worker('alex', -ENCODING, server_id=other_id, employee_id='FW-2')
        self.assertNotEqual(first, second)
        self.assertEqual(len(database.get_all_workers()), 2)
        self.assertEqual(sync._resolve_log_server_id(database.get_unsynced_logs()[0]), SERVER_ID)
        with self.assertRaisesRegex(ValueError, 'Several workers'):
            database.get_worker_by_name('Alex')
        with self.assertRaises(ValueError):
            database.remove_worker('Alex')
        database.remove_worker_by_server_id(other_id)
        self.assertEqual(database.get_worker_by_name('Alex')['id'], first)
        self.assertEqual(self._row(log_id)['server_worker_id'], SERVER_ID)

    def test_same_name_local_worker_with_different_employee_id_is_not_adopted(self):
        first = database.add_worker('Alex', ENCODING, employee_id='FW-1')
        logged = database.log_attendance(first, 'Alex', 'clock_in')
        second = database.add_worker('Alex', -ENCODING, employee_id='FW-2', server_id=SERVER_ID)
        self.assertNotEqual(first, second)
        self.assertIsNone(database.get_worker_by_id(first)['server_id'])
        self.assertIsNone(self._row(logged)['server_worker_id'])

    def test_server_rename_keeps_local_identity_even_when_name_collides(self):
        first = database.add_worker('Alex', ENCODING, server_id=SERVER_ID)
        second = database.add_worker('Taylor', ENCODING, server_id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
        renamed = database.add_worker('Taylor', -ENCODING, server_id=SERVER_ID)
        self.assertEqual(renamed, first)
        self.assertNotEqual(renamed, second)
        self.assertEqual(len(database.get_all_workers()), 2)

    def test_local_enrollment_does_not_overwrite_synced_worker_with_same_name(self):
        synced = database.add_worker('Alex', ENCODING, server_id=SERVER_ID)
        local = database.add_worker('Alex', -ENCODING)
        self.assertNotEqual(local, synced)
        self.assertEqual(database.get_worker_by_id(synced)['server_id'], SERVER_ID)
        adopted = database.add_worker('Alex', -ENCODING, server_id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
        self.assertEqual(adopted, local)

    def test_deactivation_deletes_only_unreferenced_server_id_thumbnail(self):
        import tempfile
        from pathlib import Path
        from unittest import mock
        import config
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config, 'PHOTO_DIR', tmp):
            photo = Path(tmp) / f'{SERVER_ID}.jpg'
            legacy = Path(tmp) / 'Alex.jpg'
            photo.write_bytes(b'new')
            legacy.write_bytes(b'legacy')
            database.add_worker('Alex', ENCODING, server_id=SERVER_ID, photo_paths=[str(photo)])
            database.remove_worker_by_server_id(SERVER_ID)
            self.assertFalse(photo.exists())
            self.assertTrue(legacy.exists())

    def test_deactivation_cleans_owned_legacy_photo_but_preserves_shared_and_external_files(self):
        import tempfile
        from pathlib import Path
        from unittest import mock
        import config
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'photos'
            root.mkdir()
            owned, shared, external = root / 'Alex.jpg', root / 'Shared.jpg', Path(tmp) / 'external.jpg'
            for path in (owned, shared, external):
                path.write_bytes(b'photo')
            with mock.patch.object(config, 'PHOTO_DIR', str(root)):
                database.add_worker('Alex', ENCODING, server_id=SERVER_ID, photo_paths=[str(owned), str(shared), str(external)])
                database.add_worker('Taylor', ENCODING, server_id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', photo_paths=[str(shared)])
                database.remove_worker_by_server_id(SERVER_ID)
                self.assertFalse(owned.exists())
                self.assertTrue(shared.exists())
                self.assertTrue(external.exists())

    def test_legacy_unique_name_schema_migrates_without_reusing_deleted_ids(self):
        conn = database._get_conn()
        conn.execute('DROP TABLE workers')
        conn.execute('''CREATE TABLE workers (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            employee_id TEXT, encoding_blob BLOB NOT NULL, enrolled_at TEXT NOT NULL,
            photo_count INTEGER NOT NULL DEFAULT 0, photo_paths TEXT NOT NULL DEFAULT '[]', server_id TEXT
        )''')
        first = database.add_worker('Alex', ENCODING, server_id=SERVER_ID)
        deleted = database.add_worker('Deleted', ENCODING, server_id='cccccccccccccccccccccccccccccccc')
        conn.execute('DELETE FROM workers WHERE id = ?', (deleted,))
        conn.commit()
        database.init_db()
        database.init_db()  # migration must be repeatable on service restarts
        second = database.add_worker('Alex', -ENCODING, server_id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
        self.assertEqual(database.get_worker_by_id(first)['server_id'], SERVER_ID)
        self.assertGreater(second, deleted)
        legacy = self._insert_legacy_row(first)
        database.remove_worker_by_server_id(SERVER_ID)
        self.assertEqual(self._row(legacy)['server_worker_id'], SERVER_ID)


class ManualWorkerSelectionTests(WorkerIdentityTests):
    def test_manual_clock_rejects_ambiguous_name_and_accepts_specific_id(self):
        import sys
        import types
        from unittest import mock
        import config
        with mock.patch.dict(sys.modules, {"cv2": types.ModuleType("cv2")}):
            import app
        with mock.patch.object(config, "KIOSK_UI_KEY", "test-ui", create=True), mock.patch.object(config, "KIOSK_SUPERVISOR_PIN", "test-pin", create=True):
            client = app.app.test_client()
            from kiosk_ui_auth import KIOSK_SUPERVISOR_SESSION_COOKIE, supervisor_session_token
            client.set_cookie(KIOSK_SUPERVISOR_SESSION_COOKIE, supervisor_session_token())
            headers = {"X-Kiosk-UI-Key": "test-ui"}
            database.add_worker('Alex', ENCODING, server_id=SERVER_ID)
            other = database.add_worker('Alex', -ENCODING, server_id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
            response = client.post('/manual-clock', json={"name": "Alex"}, headers=headers)
            self.assertEqual(response.status_code, 409)
            self.assertEqual(database.count_unsynced_logs(), 0)
            response = client.post('/manual-clock', json={"worker_id": other}, headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(database.get_unsynced_logs()[0]['server_worker_id'], 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')


if __name__ == '__main__':
    unittest.main()
