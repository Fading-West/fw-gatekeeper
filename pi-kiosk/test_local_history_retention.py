"""Real SQLite coverage for indexed local history and safe bounded retention."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import sqlite3
import unittest
from unittest import mock

import config
import database
import sync
from test_attendance_timezones import local_clock


NOW = datetime(2026, 11, 1, 12, tzinfo=timezone.utc)
OLD = (NOW - timedelta(days=31)).isoformat()
RECENT = (NOW - timedelta(days=29)).isoformat()
BOUNDARY = (NOW - timedelta(days=30)).isoformat()


class LocalHistoryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        patcher = mock.patch.object(config, 'DB_PATH', str(Path(directory.name) / 'test.db'))
        patcher.start()
        self.addCleanup(patcher.stop)
        retention = mock.patch.object(config, 'LOCAL_HISTORY_RETENTION_DAYS', 30)
        retention.start()
        self.addCleanup(retention.stop)
        database._local.conn = None
        self.addCleanup(self.close_database)
        database.init_db()

    @staticmethod
    def close_database():
        conn = getattr(database._local, 'conn', None)
        if conn is not None:
            conn.close()
        database._local.conn = None

    def attendance(self, timestamp=OLD, worker=1, synced=False, action='clock_in'):
        row_id = database.log_attendance(worker, 'Alex', action, timestamp=timestamp)
        if synced:
            database.mark_synced([row_id])
        return row_id

    def attempt(self, timestamp=OLD, synced=False):
        row_id = database.log_recognition_attempt(decision='unknown', timestamp=timestamp)
        if synced:
            database.mark_recognition_attempts_synced([row_id])
        return row_id

    def ids(self, table):
        return [row[0] for row in database._get_conn().execute(f'SELECT id FROM {table} ORDER BY id')]

    def legacy_tables(self):
        conn = database._get_conn()
        conn.executescript('''
            DROP TABLE attendance_log;
            DROP TABLE recognition_attempts;
            CREATE TABLE attendance_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT, worker_id INTEGER NOT NULL,
                worker_name TEXT NOT NULL, action TEXT, timestamp TEXT NOT NULL,
                liveness_confirmed INTEGER DEFAULT 0, confidence REAL DEFAULT 0,
                note TEXT, synced INTEGER DEFAULT 0
            );
            CREATE TABLE recognition_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, synced INTEGER DEFAULT 0
            );
        ''')
        return conn

    @staticmethod
    def old_today(conn, limit):
        start = database.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0, fold=0)
        end = start + timedelta(days=1)
        rows = conn.execute('''SELECT id, worker_id, worker_name, action, timestamp,
            liveness_confirmed, confidence, note FROM attendance_log
            WHERE attendance_epoch(timestamp) >= ? AND attendance_epoch(timestamp) < ?
            ORDER BY attendance_epoch(timestamp) DESC, id DESC LIMIT ?''',
            (start.timestamp(), end.timestamp(), limit)).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item['liveness_confirmed'] = bool(item['liveness_confirmed'])
            item['event_type'] = item['action']
            result.append(item)
        return result

    def test_migration_and_indexed_query_match_old_query_on_both_dst_days(self):
        for day, hours in [('2026-03-08', 23), ('2026-11-01', 25)]:
            instant = datetime.fromisoformat(day + 'T12:00:00+00:00')
            with self.subTest(day=day), local_clock('America/Denver', instant):
                conn = self.legacy_tables()
                start = database.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
                start_epoch = start.timestamp()
                end_epoch = (start + timedelta(days=1)).timestamp()
                self.assertEqual(end_epoch - start_epoch, hours * 3600)
                strings = [
                    datetime.fromtimestamp(start_epoch - 1, timezone.utc).isoformat(),
                    datetime.fromtimestamp(start_epoch, timezone.utc).isoformat(),
                    day + ' 01:30:00', day + 'T01:30:00.123456',
                    day + 'T01:30:00-06:00', day + 'T01:30:00-07:00',
                    day + 'T09:30:00Z', day + 'T09:30:00+00:00',
                    datetime.fromtimestamp(end_epoch - .000001, timezone.utc).isoformat(),
                    datetime.fromtimestamp(end_epoch, timezone.utc).isoformat(),
                    'not-a-timestamp', '2026-02-30T08:00:00',
                ]
                conn.executemany('''INSERT INTO attendance_log
                    (worker_id, worker_name, action, timestamp, liveness_confirmed, note)
                    VALUES (1, 'Alex', 'clock_in', ?, 1, 'evidence')''', [(s,) for s in strings])
                conn.executemany('INSERT INTO recognition_attempts (timestamp) VALUES (?)', [(s,) for s in strings])
                conn.commit()
                expected = {limit: self.old_today(conn, limit) for limit in (2, 50, -1)}
                database.init_db()
                database.init_db()  # Restart is idempotent; source evidence remains intact.
                self.assertEqual([r[0] for r in conn.execute('SELECT timestamp FROM attendance_log ORDER BY id')], strings)
                for table in ('attendance_log', 'recognition_attempts'):
                    epochs = [r[0] for r in conn.execute(f'SELECT timestamp_epoch FROM {table} ORDER BY id')]
                    self.assertEqual(epochs, [database._attendance_epoch(s) for s in strings])
                for limit, old in expected.items():
                    self.assertEqual(database.get_today_logs(limit), old)
                inserted = self.attendance(day + 'T10:00:00Z')
                self.assertEqual(conn.execute('SELECT timestamp_epoch FROM attendance_log WHERE id = ?',
                                             (inserted,)).fetchone()[0], database._attendance_epoch(day + 'T10:00:00Z'))
                self.assertEqual(database.get_today_logs(), self.old_today(conn, 50))

    def test_today_query_uses_range_index_without_udf_or_sort(self):
        with local_clock('America/Denver', NOW):
            self.attendance(NOW.isoformat())
            conn = database._get_conn()
            statements = []
            conn.set_trace_callback(statements.append)
            try:
                with mock.patch.object(database, '_attendance_epoch', side_effect=AssertionError('query invoked UDF')):
                    conn.create_function('attendance_epoch', 1, database._attendance_epoch)
                    database.get_today_logs()
            finally:
                conn.set_trace_callback(None)
                conn.create_function('attendance_epoch', 1, database._attendance_epoch)
            sql = next(s for s in statements if 'FROM attendance_log' in s)
            plan = ' '.join(row['detail'] for row in conn.execute('EXPLAIN QUERY PLAN ' + sql))
            self.assertIn('SEARCH attendance_log USING INDEX idx_attendance_epoch', plan)
            self.assertNotIn('TEMP B-TREE', plan)

    def test_interrupted_epoch_migration_can_be_retried(self):
        conn = self.legacy_tables()
        conn.execute("INSERT INTO recognition_attempts (timestamp) VALUES (?)", (OLD,))
        conn.commit()
        def fail(_):
            raise ValueError('interrupted backfill')
        conn.create_function('attendance_epoch', 1, fail)
        with self.assertRaises(sqlite3.OperationalError):
            database._migrate_event_epoch(conn, 'recognition_attempts')
        self.assertNotIn('timestamp_epoch', [r['name'] for r in conn.execute('PRAGMA table_info(recognition_attempts)')])
        conn.create_function('attendance_epoch', 1, database._attendance_epoch)
        database.init_db()
        self.assertEqual(conn.execute('SELECT timestamp_epoch FROM recognition_attempts').fetchone()[0],
                         database._attendance_epoch(OLD))

    def test_retention_keeps_unsynced_recent_boundary_invalid_and_latest_rows(self):
        with local_clock('America/Denver', NOW):
            deleted = self.attendance(synced=True)
            latest = self.attendance(synced=True, action='clock_out')
            # An older event inserted last must not displace the actual last action.
            older_inserted_last = self.attendance((NOW - timedelta(days=40)).isoformat(), synced=True)
            unsynced = self.attendance(worker=2)
            recent = self.attendance(RECENT, worker=3, synced=True)
            boundary = self.attendance(BOUNDARY, worker=3, synced=True)
            invalid = self.attendance('bad', synced=True)
            old_attempt = self.attempt(synced=True)
            kept_attempts = [self.attempt(), self.attempt(RECENT, synced=True),
                             self.attempt(BOUNDARY, synced=True), self.attempt('bad', synced=True)]
            unsent_logs = database.get_unsynced_logs()
            unsent_attempts = database.get_unsynced_recognition_attempts()
            before_today = database.get_today_logs()
            self.assertEqual(database.get_last_action(1), 'clock_out')
            self.assertEqual(database.prune_synced_history(), {'attendance_log': 2, 'recognition_attempts': 1})
            self.assertEqual(self.ids('attendance_log'), [latest, unsynced, recent, boundary, invalid])
            self.assertEqual(self.ids('recognition_attempts'), kept_attempts)
            self.assertNotIn(deleted, self.ids('attendance_log'))
            self.assertNotIn(older_inserted_last, self.ids('attendance_log'))
            self.assertNotIn(old_attempt, self.ids('recognition_attempts'))
            self.assertEqual(database.get_unsynced_logs(), unsent_logs)
            self.assertEqual(database.get_unsynced_recognition_attempts(), unsent_attempts)
            self.assertEqual(database.get_today_logs(), before_today)
            self.assertEqual(database.get_last_action(1), 'clock_out')

    def test_latest_action_of_removed_worker_is_preserved(self):
        with local_clock('America/Denver', NOW):
            # No workers row exists for this local id.
            self.attendance(worker=999, synced=True)
            latest = self.attendance(worker=999, synced=True, action='clock_out')
            database.prune_synced_history()
            self.assertEqual(self.ids('attendance_log'), [latest])
            self.assertEqual(database.get_last_action(999), 'clock_out')

    def test_active_rejection_evidence_is_kept_even_if_marked_synced(self):
        with local_clock('America/Denver', NOW):
            rejected = self.attendance()
            database.reject_attendance(rejected, 'rejected event')
            database.mark_synced([rejected])
            self.attendance(synced=True)
            database.prune_synced_history()
            self.assertIn(rejected, self.ids('attendance_log'))
            self.assertEqual(database.count_rejected_logs(), 1)

    def test_cleanup_during_upload_keeps_rows_until_acknowledged(self):
        with local_clock('America/Denver', NOW):
            queued = self.attendance()
            self.attendance(RECENT, synced=True)
            attempt = self.attempt()
            # Fetching the upload batch does not make it eligible for pruning.
            database.get_unsynced_logs()
            database.get_unsynced_recognition_attempts()
            database.prune_synced_history()
            self.assertIn(queued, self.ids('attendance_log'))
            self.assertIn(attempt, self.ids('recognition_attempts'))
            database.mark_synced([queued])
            database.mark_recognition_attempts_synced([attempt])
            database.prune_synced_history()
            self.assertNotIn(queued, self.ids('attendance_log'))
            self.assertNotIn(attempt, self.ids('recognition_attempts'))

    def test_batches_are_bounded_and_committed_for_each_table(self):
        with local_clock('America/Denver', NOW):
            for _ in range(7):
                self.attendance(synced=True)
                self.attempt(synced=True)
            with mock.patch.object(database, '_HISTORY_PRUNE_BATCH_SIZE', 3):
                self.assertEqual(database.prune_synced_history(), {'attendance_log': 3, 'recognition_attempts': 3})
                self.assertFalse(database._get_conn().in_transaction)
                self.assertEqual(len(self.ids('attendance_log')), 4)
                self.assertEqual(len(self.ids('recognition_attempts')), 4)
                self.assertEqual(database.prune_synced_history(), {'attendance_log': 3, 'recognition_attempts': 3})
                self.assertEqual(database.prune_synced_history(), {'attendance_log': 0, 'recognition_attempts': 1})

    def test_custom_retention_and_long_debounce_are_respected(self):
        with local_clock('America/Denver', NOW), mock.patch.object(config, 'LOCAL_HISTORY_RETENTION_DAYS', 60):
            kept = self.attendance(synced=True)
            self.attendance(RECENT, synced=True)
            attempt = self.attempt(synced=True)
            self.assertEqual(database.prune_synced_history(), {'attendance_log': 0, 'recognition_attempts': 0})
            self.assertIn(kept, self.ids('attendance_log'))
            self.assertIn(attempt, self.ids('recognition_attempts'))
        with local_clock('America/Denver', NOW), mock.patch.object(config, 'CLOCK_DEBOUNCE_MINUTES', 60 * 24 * 40):
            self.assertTrue(database.was_recently_clocked(1, config.CLOCK_DEBOUNCE_MINUTES))
            database.prune_synced_history()
            self.assertIn(kept, self.ids('attendance_log'))
            self.assertTrue(database.was_recently_clocked(1, config.CLOCK_DEBOUNCE_MINUTES))

    def test_cleanup_uses_age_indexes_without_sorting_the_backlog(self):
        with local_clock('America/Denver', NOW):
            self.attendance(synced=True)
            self.attendance(synced=True)
            self.attempt(synced=True)
            conn = database._get_conn()
            statements = []
            conn.set_trace_callback(statements.append)
            try:
                database.prune_synced_history()
            finally:
                conn.set_trace_callback(None)
            deletes = [s for s in statements if s.startswith('DELETE FROM')]
            self.assertEqual(len(deletes), 2)
            for table, sql in zip(('attendance_log', 'recognition_attempts'), deletes):
                plan = ' '.join(row['detail'] for row in conn.execute('EXPLAIN QUERY PLAN ' + sql))
                self.assertIn(f'idx_{table}_retention (timestamp_epoch<?)', plan)
                self.assertNotIn('TEMP B-TREE', plan)

    def test_invalid_retention_fails_before_any_delete(self):
        for value in (0, -1, True, 1.5, '30', None):
            with self.subTest(value=value), mock.patch.object(config, 'LOCAL_HISTORY_RETENTION_DAYS', value):
                with self.assertRaisesRegex(ValueError, 'positive integer'):
                    database.prune_synced_history()

    def test_sync_cadence_prunes_after_uploads_and_also_when_offline(self):
        for online in (True, False):
            with self.subTest(online=online):
                worker = sync.SyncWorker()
                worker._running = True
                calls = []
                def stop(_):
                    worker._running = False
                with mock.patch.object(sync, 'check_server', return_value=online), \
                     mock.patch.object(sync, 'sync_workers', return_value=True), \
                     mock.patch.object(sync, 'sync_attendance', side_effect=lambda: calls.append('attendance')), \
                     mock.patch.object(sync, 'sync_recognition_attempts', side_effect=lambda: calls.append('attempts')), \
                     mock.patch.object(database, 'prune_synced_history', side_effect=lambda: calls.append('prune')), \
                     mock.patch.object(sync.time, 'sleep', side_effect=stop), \
                     mock.patch.object(config, 'SYNC_INTERVAL', 1):
                    worker._run()
                self.assertEqual(calls, ['attendance', 'attempts', 'prune'] if online else ['prune'])


if __name__ == '__main__':
    unittest.main()
