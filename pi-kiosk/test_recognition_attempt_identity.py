"""Durable recognition telemetry identities backed by real SQLite."""
import unittest
import uuid
from unittest import mock

import test_sync_mapping as mapping
from test_sync_mapping import ENCODING, SERVER_ID
import config
import database
import sync


class RecognitionAttemptIdentityTests(unittest.TestCase):
    setUp = mapping.AttendanceServerIdMappingTests.setUp
    _close_db = staticmethod(mapping.AttendanceServerIdMappingTests._close_db)

    def test_recreated_database_row_ids_receive_distinct_uuid_identities(self):
        first_id = database.log_recognition_attempt(decision='unknown', timestamp='2026-09-01T08:00:00')
        first = database.get_unsynced_recognition_attempts()[0]
        conn = database._get_conn()
        conn.execute('DELETE FROM recognition_attempts')
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'recognition_attempts'")
        conn.commit()
        second_id = database.log_recognition_attempt(decision='unknown', timestamp='2026-09-01T08:00:00')
        second = database.get_unsynced_recognition_attempts()[0]
        self.assertEqual(first_id, second_id)
        self.assertNotEqual(first['source_attempt_id'], second['source_attempt_id'])
        self.assertEqual(uuid.UUID(first['source_attempt_id']).version, 4)
        self.assertEqual(uuid.UUID(second['source_attempt_id']).version, 4)
        self.assertIsNone(second['legacy_source_attempt_id'])

    def test_legacy_backfill_survives_restart_and_preserves_lost_ack_payload(self):
        worker = database.add_worker('Alex', ENCODING, server_id=SERVER_ID)
        conn = database._get_conn()
        conn.execute("INSERT INTO recognition_attempts (decision, candidate_worker_id) VALUES ('unknown', ?)", (worker,))
        conn.commit()
        with mock.patch.object(config, 'KIOSK_ID', 'original-kiosk'), mock.patch.object(
            sync.requests, 'post', side_effect=sync.requests.Timeout('lost acknowledgement')
        ) as post:
            self.assertFalse(sync.sync_recognition_attempts())
            first = post.call_args.kwargs['json']['attempts'][0]
        self.assertEqual(first['legacySourceAttemptId'], 'original-kiosk:1')
        self.assertEqual(uuid.UUID(first['sourceAttemptId']).version, 4)
        self.assertEqual(first['candidateWorkerId'], SERVER_ID)
        self._close_db()
        database.init_db()
        database.remove_worker_by_server_id(SERVER_ID)
        with mock.patch.object(config, 'KIOSK_ID', 'changed-kiosk'), mock.patch.object(
            sync.requests, 'post', return_value=mock.Mock(status_code=409, text='source identity conflict')
        ) as post:
            self.assertFalse(sync.sync_recognition_attempts())
            self.assertEqual(post.call_args.kwargs['json']['attempts'][0], first)
        self.assertEqual(database.count_unsynced_recognition_attempts(), 1)
        with mock.patch.object(sync.requests, 'post', return_value=mock.Mock(status_code=200)) as post:
            self.assertTrue(sync.sync_recognition_attempts())
            self.assertEqual(post.call_args.kwargs['json']['attempts'][0], first)
        self.assertEqual(database.count_unsynced_recognition_attempts(), 0)

    def test_new_attempt_snapshots_candidate_identity_before_worker_deletion(self):
        worker = database.add_worker('Alex', ENCODING, server_id=SERVER_ID)
        database.log_recognition_attempt(decision='accepted', candidate_worker_id=worker, threshold=0.5)
        persisted = database.get_unsynced_recognition_attempts()[0]
        database.remove_worker_by_server_id(SERVER_ID)
        with mock.patch.object(sync.requests, 'post', return_value=mock.Mock(status_code=409, text='conflict')) as post:
            self.assertFalse(sync.sync_recognition_attempts())
            first = post.call_args.kwargs['json']['attempts'][0]
        self.assertEqual(first['candidateWorkerId'], SERVER_ID)
        self.assertEqual(first['sourceAttemptId'], persisted['source_attempt_id'])
        self.assertNotIn('legacySourceAttemptId', first)
        self.assertEqual(database.count_unsynced_recognition_attempts(), 1)

    def test_upgrade_adds_identity_columns_without_rewriting_synced_history(self):
        conn = database._get_conn()
        conn.execute('DROP TABLE recognition_attempts')
        conn.execute('CREATE TABLE recognition_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, synced INTEGER)')
        conn.execute("INSERT INTO recognition_attempts (timestamp, synced) VALUES ('2026-09-01T08:00:00', 1)")
        conn.commit()
        database.init_db()
        self.assertEqual(database.get_unsynced_recognition_attempts(), [])
        row = database._get_conn().execute('SELECT source_attempt_id FROM recognition_attempts').fetchone()
        self.assertIsNone(row['source_attempt_id'])
        database.log_recognition_attempt(decision='unknown')
        self.assertEqual(uuid.UUID(database.get_unsynced_recognition_attempts()[0]['source_attempt_id']).version, 4)


if __name__ == '__main__':
    unittest.main()
