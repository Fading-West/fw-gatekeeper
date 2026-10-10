"""Real SQLite coverage for indexed local history and safe bounded retention."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import runpy
import sys
import tempfile
import sqlite3
import threading
from types import ModuleType
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
        database._migrate_history()

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
                database._migrate_history()
                database.init_db()  # Restart is idempotent; source evidence remains intact.
                database._migrate_history()
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

    def test_startup_only_prepares_schema_without_backfill_or_epoch_indexes(self):
        conn = self.legacy_tables()
        conn.executemany("INSERT INTO attendance_log (worker_id, worker_name, action, timestamp) "
                         "VALUES (1, 'Alex', 'clock_in', ?)", [(OLD,)] * 205)
        conn.commit()
        with mock.patch.object(database, '_attendance_epoch', side_effect=AssertionError('startup parsed history')):
            database.init_db()
        self.assertEqual(json.loads(database.get_sync_state('epoch_backfill:attendance_log')), [0, 205])
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM attendance_log WHERE timestamp_epoch IS NULL').fetchone()[0], 205)
        self.assertIsNone(conn.execute("SELECT name FROM sqlite_master WHERE name = 'idx_attendance_epoch'").fetchone())

    def test_partial_backfill_today_matches_old_query_at_every_batch_on_dst_days(self):
        for day, hours in [('2026-03-08', 23), ('2026-11-01', 25)]:
            with self.subTest(day=day), local_clock('America/Denver', datetime.fromisoformat(day + 'T12:00:00+00:00')):
                conn = self.legacy_tables()
                start = database.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0, fold=0)
                end = start + timedelta(days=1)
                self.assertEqual(end.timestamp() - start.timestamp(), hours * 3600)
                strings = ['invalid', OLD,
                           datetime.fromtimestamp(start.timestamp() - 1, timezone.utc).isoformat(),
                           datetime.fromtimestamp(start.timestamp(), timezone.utc).isoformat(),
                           day + ' 01:30:00', day + 'T01:30:00.123456',
                           day + 'T01:30:00-06:00', day + 'T01:30:00-07:00',
                           day + 'T09:30:00Z', day + 'T09:30:00+00:00',
                           datetime.fromtimestamp(end.timestamp() - .000001, timezone.utc).isoformat(),
                           datetime.fromtimestamp(end.timestamp(), timezone.utc).isoformat(),
                           '2026-02-30T08:00:00']
                conn.executemany("INSERT INTO attendance_log (worker_id, worker_name, action, timestamp) "
                                 "VALUES (1, 'Alex', 'clock_in', ?)", [(s,) for s in strings])
                conn.commit()
                database.init_db()
                # Inserts beyond the high-water ID must appear during backfill.
                live = self.attendance(day + 'T10:15:00Z')
                attempt = self.attempt(day + 'T10:15:00Z')
                self.assertIsNotNone(conn.execute('SELECT timestamp_epoch FROM recognition_attempts WHERE id = ?',
                                                 (attempt,)).fetchone()[0])
                expected = {limit: self.old_today(conn, limit) for limit in (0, 2, 50, -1)}
                def verify():
                    for limit, rows in expected.items():
                        self.assertEqual(database.get_today_logs(limit), rows)
                    self.assertIn(live, [row['id'] for row in database.get_today_logs(-1)])
                verify()
                with mock.patch.object(database, '_EPOCH_BACKFILL_BATCH_SIZE', 2):
                    database._migrate_event_epoch(conn, 'attendance_log', pause=verify)
                verify()  # Fast path after the final committed cursor deletion.

    def test_today_query_survives_backfill_finishing_after_cursor_read(self):
        with local_clock('America/Denver', NOW):
            row_id = self.attendance(NOW.isoformat())
            conn = database._get_conn()
            conn.execute('UPDATE attendance_log SET timestamp_epoch = NULL WHERE id = ?', (row_id,))
            database.set_sync_state('epoch_backfill:attendance_log', json.dumps([0, row_id]))
            expected = self.old_today(conn, 50)
            read_state = database.get_sync_state
            def finish_after_read(key):
                progress = read_state(key)
                database._migrate_event_epoch(conn, 'attendance_log')
                return progress
            with mock.patch.object(database, 'get_sync_state', side_effect=finish_after_read):
                self.assertEqual(database.get_today_logs(), expected)

    def test_partial_backfill_preserves_latest_action_debounce_and_defers_retention(self):
        with local_clock('America/Denver', NOW):
            cached = self.attendance(OLD, synced=True)
            latest = self.attendance(NOW.isoformat(), synced=True, action='clock_out')
            conn = database._get_conn()
            conn.execute('UPDATE attendance_log SET timestamp_epoch = NULL WHERE id = ?', (latest,))
            database.set_sync_state('epoch_backfill:attendance_log', json.dumps([cached, latest]))
            self.attempt(synced=True)
            self.assertEqual(database.get_last_action(1), 'clock_out')
            self.assertTrue(database.was_recently_clocked(1, 5))
            self.assertFalse(database.was_recently_clocked(2, 5))
            before = {table: self.ids(table) for table in ('attendance_log', 'recognition_attempts')}
            self.assertEqual(database.prune_synced_history(), {'attendance_log': 0, 'recognition_attempts': 0})
            self.assertEqual({table: self.ids(table) for table in before}, before)
            database._migrate_history()
            self.assertEqual(database.get_last_action(1), 'clock_out')
            self.assertTrue(database.was_recently_clocked(1, 5))
            self.assertEqual(database.prune_synced_history(), {'attendance_log': 1, 'recognition_attempts': 1})
            self.assertEqual(self.ids('attendance_log'), [latest])

    def test_background_worker_allows_reads_and_manual_writes_and_starts_only_once(self):
        with local_clock('America/Denver', NOW):
            conn = self.legacy_tables()
            conn.execute("INSERT INTO attendance_log (worker_id, worker_name, action, timestamp) "
                         "VALUES (1, 'Alex', 'clock_in', ?)", (NOW.isoformat(),))
            conn.commit()
            database.init_db()
            parsing = threading.Event()
            release = threading.Event()
            original_epoch = database._attendance_epoch
            def blocked_parse(timestamp):
                if threading.current_thread().name == 'history-migration':
                    parsing.set()
                    if not release.wait(5):
                        raise RuntimeError('test did not release parser')
                return original_epoch(timestamp)
            with mock.patch.object(database, '_attendance_epoch', side_effect=blocked_parse):
                worker = database.start_history_migration()
                try:
                    self.assertTrue(parsing.wait(5))
                    self.assertIs(database.start_history_migration(), worker)
                    self.assertEqual([row['id'] for row in database.get_today_logs()], [1])
                    # Write through the public API while the worker is between locks.
                    live = self.attendance(NOW.isoformat(), action='clock_out')
                    self.assertEqual(database.get_last_action(1), 'clock_out')
                finally:
                    release.set()
                    worker.join(5)
            self.assertFalse(worker.is_alive())
            self.assertIsNone(database.get_sync_state('epoch_backfill:attendance_log'))
            self.assertEqual([row['id'] for row in database.get_today_logs()], [live, 1])

    def test_background_worker_retries_failure_and_closes_its_own_connection(self):
        row_id = self.attendance(NOW.isoformat())
        conn = database._get_conn()
        conn.execute('UPDATE attendance_log SET timestamp_epoch = NULL WHERE id = ?', (row_id,))
        database.set_sync_state('epoch_backfill:attendance_log', json.dumps([0, row_id]))
        migrate = database._migrate_history
        worker_connections = []
        def fail_once(pause=None):
            worker_connections.append(database._get_conn())
            if len(worker_connections) == 1:
                raise sqlite3.OperationalError('transient database lock')
            migrate(pause=pause)
        def check_retry_delay(seconds):
            if seconds == 30:
                self.assertIsNotNone(database.get_sync_state('epoch_backfill:attendance_log'))
        with mock.patch.object(database, '_migrate_history', side_effect=fail_once), \
             mock.patch.object(database.time, 'sleep', side_effect=check_retry_delay) as sleep, \
             mock.patch.object(database.logger, 'exception') as log:
            worker = database.start_history_migration()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(worker_connections), 2)
        self.assertIs(worker_connections[0], worker_connections[1])
        with self.assertRaises(sqlite3.ProgrammingError):
            worker_connections[0].execute('SELECT 1')
        sleep.assert_any_call(30)
        log.assert_called_once()
        self.assertIsNone(database.get_sync_state('epoch_backfill:attendance_log'))
        self.assertEqual(conn.execute('SELECT timestamp_epoch FROM attendance_log WHERE id = ?',
                                     (row_id,)).fetchone()[0], database._attendance_epoch(NOW.isoformat()))

    def test_interrupted_epoch_migration_can_be_retried(self):
        conn = self.legacy_tables()
        strings = ['invalid', OLD, RECENT, BOUNDARY, OLD]
        conn.executemany("INSERT INTO recognition_attempts (timestamp) VALUES (?)", [(s,) for s in strings])
        conn.commit()
        original_epoch = database._attendance_epoch
        calls = []
        def interrupted(timestamp):
            calls.append(timestamp)
            if len(calls) == 4:
                raise RuntimeError('interrupted backfill')
            return original_epoch(timestamp)
        with mock.patch.object(database, '_EPOCH_BACKFILL_BATCH_SIZE', 2), \
             mock.patch.object(database, '_attendance_epoch', side_effect=interrupted):
            with self.assertRaisesRegex(RuntimeError, 'interrupted backfill'):
                database._migrate_event_epoch(conn, 'recognition_attempts')
        self.assertFalse(conn.in_transaction)
        self.assertEqual(json.loads(database.get_sync_state('epoch_backfill:recognition_attempts')), [2, 5])
        self.assertEqual([r[0] for r in conn.execute('SELECT timestamp_epoch FROM recognition_attempts ORDER BY id')],
                         [None, original_epoch(OLD), None, None, None])
        self.close_database()  # The committed schema and progress survive process restart.
        with mock.patch.object(database, '_attendance_epoch', wraps=original_epoch) as parse:
            database.init_db()
            database._migrate_history()
        self.assertEqual([call.args[0] for call in parse.call_args_list], strings[2:])
        self.assertIsNone(database.get_sync_state('epoch_backfill:recognition_attempts'))
        conn = database._get_conn()
        self.assertEqual([r[0] for r in conn.execute('SELECT timestamp_epoch FROM recognition_attempts ORDER BY id')],
                         [original_epoch(s) for s in strings])
        database.init_db()
        database._migrate_history()

    def test_epoch_column_and_resume_marker_are_atomic(self):
        conn = self.legacy_tables()
        def fail_marker(sql, *_):
            return sqlite3.SQLITE_DENY if sql == sqlite3.SQLITE_INSERT else sqlite3.SQLITE_OK
        conn.set_authorizer(fail_marker)
        try:
            with self.assertRaises(sqlite3.DatabaseError):
                database._migrate_event_epoch(conn, 'recognition_attempts')
        finally:
            conn.set_authorizer(None)
        self.assertNotIn('timestamp_epoch', [r['name'] for r in conn.execute('PRAGMA table_info(recognition_attempts)')])
        self.assertIsNone(database.get_sync_state('epoch_backfill:recognition_attempts'))
        database.init_db()
        database._migrate_history()

    def test_backfill_releases_write_lock_between_batches_and_before_parsing(self):
        conn = self.legacy_tables()
        conn.executemany('INSERT INTO recognition_attempts (timestamp) VALUES (?)', [(OLD,)] * 5)
        conn.commit()
        competitor = sqlite3.connect(config.DB_PATH, timeout=0)
        self.addCleanup(competitor.close)
        original_epoch = database._attendance_epoch
        seen_progress = []
        def parse_without_lock(timestamp):
            # A second writer can acquire the database during every conversion.
            competitor.execute('BEGIN IMMEDIATE')
            progress = competitor.execute("SELECT value FROM sync_state WHERE key = 'epoch_backfill:recognition_attempts'").fetchone()
            seen_progress.append(json.loads(progress[0])[0])
            competitor.rollback()
            return original_epoch(timestamp)
        conn.create_function('attendance_epoch', 1, parse_without_lock)
        try:
            with mock.patch.object(database, '_EPOCH_BACKFILL_BATCH_SIZE', 2, create=True), \
                 mock.patch.object(database, '_attendance_epoch', side_effect=parse_without_lock):
                database._migrate_event_epoch(conn, 'recognition_attempts')
        finally:
            conn.create_function('attendance_epoch', 1, original_epoch)
        self.assertEqual(seen_progress, [0, 0, 2, 2, 4])
        self.assertFalse(conn.in_transaction)

    def test_failed_write_batch_rolls_back_its_progress_and_can_resume(self):
        conn = self.legacy_tables()
        conn.executemany('INSERT INTO recognition_attempts (timestamp) VALUES (?)', [(OLD,)] * 5)
        conn.commit()
        database._ensure_column(conn, 'recognition_attempts', 'timestamp_epoch', 'timestamp_epoch REAL')
        conn.execute("INSERT INTO sync_state VALUES ('epoch_backfill:recognition_attempts', '[0, 5]')")
        conn.executescript('''CREATE TRIGGER fail_epoch_update BEFORE UPDATE OF timestamp_epoch
            ON recognition_attempts WHEN NEW.id = 4 BEGIN SELECT RAISE(ABORT, 'interrupted batch'); END;''')
        with mock.patch.object(database, '_EPOCH_BACKFILL_BATCH_SIZE', 2):
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'interrupted batch'):
                database._migrate_event_epoch(conn, 'recognition_attempts')
        self.assertEqual(json.loads(database.get_sync_state('epoch_backfill:recognition_attempts')), [2, 5])
        self.assertEqual([r[0] for r in conn.execute('SELECT id FROM recognition_attempts WHERE timestamp_epoch IS NOT NULL')], [1, 2])
        conn.execute('DROP TRIGGER fail_epoch_update')
        database.init_db()
        database._migrate_history()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM recognition_attempts WHERE timestamp_epoch IS NOT NULL').fetchone()[0], 5)

    def test_recognition_insert_populates_epoch(self):
        row_id = self.attempt('2026-11-01T01:30:00.123456-07:00')
        row = database._get_conn().execute('SELECT timestamp, timestamp_epoch FROM recognition_attempts WHERE id = ?',
                                          (row_id,)).fetchone()
        self.assertEqual(row['timestamp_epoch'], database._attendance_epoch(row['timestamp']))

    def test_latest_action_with_only_invalid_evidence_before_and_after_backfill(self):
        self.attendance('invalid', action='clock_in')
        last = self.attendance('also-invalid', action='clock_out')
        database.set_sync_state('epoch_backfill:attendance_log', json.dumps([0, last]))
        self.assertEqual(database.get_last_action(1), 'clock_out')
        self.assertIsNone(database.get_last_action(2))
        database._migrate_history()
        self.assertEqual(database.get_last_action(1), 'clock_out')
        self.assertIsNone(database.get_last_action(2))

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
            age_queries = [next(s for s in statements if s.startswith('SELECT id, timestamp_epoch FROM attendance_log')),
                           next(s for s in statements if s.startswith('DELETE FROM recognition_attempts'))]
            for table, sql in zip(('attendance_log', 'recognition_attempts'), age_queries):
                plan = ' '.join(row['detail'] for row in conn.execute('EXPLAIN QUERY PLAN ' + sql))
                self.assertIn(f'idx_{table}_retention (timestamp_epoch<?)', plan)
                self.assertNotIn('TEMP B-TREE', plan)

    def test_protected_backlog_has_bounded_scan_work(self):
        with local_clock('America/Denver', NOW):
            conn = database._get_conn()
            # Every row is a different worker's latest action: none is deletable.
            conn.executemany('''INSERT INTO attendance_log
                (worker_id, worker_name, action, timestamp, timestamp_epoch, synced)
                VALUES (?, 'Alex', 'clock_in', ?, ?, 1)''',
                [(worker, OLD, database._attendance_epoch(OLD)) for worker in range(5000)])
            conn.commit()
            for after in (None, [database._attendance_epoch(OLD), 4000]):
                with self.subTest(after=after):
                    if after is not None:
                        database.set_sync_state('attendance_prune_after', json.dumps(after))
                    steps = []
                    def limit_work():
                        steps.append(None)
                        return len(steps) > 30
                    conn.set_progress_handler(limit_work, 1000)
                    try:
                        self.assertEqual(database.prune_synced_history()['attendance_log'], 0)
                    finally:
                        conn.set_progress_handler(None, 0)
            self.assertEqual(len(self.ids('attendance_log')), 5000)

    def test_cursor_batch_crosses_timestamp_groups_without_skipping_or_overfilling(self):
        with local_clock('America/Denver', NOW), mock.patch.object(database, '_HISTORY_PRUNE_BATCH_SIZE', 3):
            older = (NOW - timedelta(days=40)).isoformat()
            early = [self.attendance(older, synced=True) for _ in range(4)]
            later = [self.attendance(OLD, synced=True) for _ in range(4)]
            latest = self.attendance(RECENT, synced=True)
            self.assertEqual(database.prune_synced_history()['attendance_log'], 3)
            self.assertEqual(self.ids('attendance_log'), early[3:] + later + [latest])
            # One remaining tied ID and two later-epoch rows fill the next batch.
            self.assertEqual(database.prune_synced_history()['attendance_log'], 3)
            self.assertEqual(self.ids('attendance_log'), later[2:] + [latest])
            self.assertEqual(database.prune_synced_history()['attendance_log'], 2)
            self.assertEqual(self.ids('attendance_log'), [latest])
            self.assertEqual(database.prune_synced_history()['attendance_log'], 0)
            self.assertIsNone(database.get_sync_state('attendance_prune_after'))

    def test_cleanup_advances_past_protected_prefix_and_wraps_after_restart(self):
        with local_clock('America/Denver', NOW), mock.patch.object(database, '_HISTORY_PRUNE_BATCH_SIZE', 3):
            protected = [self.attendance(worker=worker, synced=True) for worker in range(7)]
            deletable = self.attendance(worker=99, synced=True)
            latest = self.attendance(worker=99, synced=True)
            self.assertEqual(database.prune_synced_history()['attendance_log'], 0)
            self.close_database()
            database.init_db()
            database._migrate_history()
            self.assertEqual(database.prune_synced_history()['attendance_log'], 0)
            self.assertEqual(database.prune_synced_history()['attendance_log'], 1)
            self.assertEqual(self.ids('attendance_log'), protected + [latest])
            self.assertNotIn(deletable, self.ids('attendance_log'))
            # An older row acknowledged behind the cursor is found after wrap.
            behind = self.attendance((NOW - timedelta(days=40)).isoformat(), worker=99)
            database.mark_synced([behind])
            self.assertEqual(database.prune_synced_history()['attendance_log'], 0)
            self.assertIsNone(database.get_sync_state('attendance_prune_after'))
            self.assertEqual(database.prune_synced_history()['attendance_log'], 1)
            self.assertNotIn(behind, self.ids('attendance_log'))

    def test_invalid_retention_fails_before_any_delete(self):
        for value in (0, -1, True, 1.5, '30', None):
            with self.subTest(value=value), mock.patch.object(config, 'LOCAL_HISTORY_RETENTION_DAYS', value):
                with self.assertRaisesRegex(ValueError, 'positive integer'):
                    database.prune_synced_history()

    def test_retention_validation_applies_after_local_config_override(self):
        for value in (1, 60, 0, -1, True, 1.5, '30', None):
            local = ModuleType('config_local')
            local.LOCAL_HISTORY_RETENTION_DAYS = value
            with self.subTest(value=value), mock.patch.dict(sys.modules, {'config_local': local}):
                if type(value) is int and value > 0:
                    result = runpy.run_path(str(Path(__file__).with_name('config.py')))
                    self.assertEqual(result['LOCAL_HISTORY_RETENTION_DAYS'], value)
                else:
                    with self.assertRaisesRegex(ValueError, 'LOCAL_HISTORY_RETENTION_DAYS'):
                        runpy.run_path(str(Path(__file__).with_name('config.py')))

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
