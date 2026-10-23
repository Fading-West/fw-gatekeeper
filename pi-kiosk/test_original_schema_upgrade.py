"""Upgrade an original (v1) kiosk database without crashing or flipping clock-outs."""

import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

import numpy as np

import config
import database
import sync

SERVER_ID = "a" * 32
ALEX = np.linspace(-1.0, 1.0, 128)
BLAIR = np.linspace(1.0, -1.0, 128)
NEW_ENCODING = np.linspace(0.1, 0.9, 512)

# The schema and writers of the first kiosk release (commit c04cd2a).
ORIGINAL_SCHEMA = """
    CREATE TABLE IF NOT EXISTS workers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        face_encoding TEXT NOT NULL,
        photo_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS attendance_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        worker_id INTEGER NOT NULL,
        worker_name TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('clock_in', 'clock_out')),
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        confidence REAL,
        kiosk_id TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (worker_id) REFERENCES workers(id)
    );

    CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
"""

ATTENDANCE_COLUMNS = "id, worker_id, worker_name, timestamp, confidence, kiosk_id, synced"


class OriginalSchemaUpgradeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.db_path = str(Path(directory.name) / "attendance.db")
        patcher = mock.patch.object(config, "DB_PATH", self.db_path)
        patcher.start()
        self.addCleanup(patcher.stop)
        database._local.conn = None
        self.addCleanup(self.close_database)
        conn = sqlite3.connect(self.db_path)
        conn.executescript(ORIGINAL_SCHEMA)
        insert_worker = ("INSERT INTO workers (id, name, face_encoding, photo_path, created_at) "
                         "VALUES (?, ?, ?, ?, ?)")
        conn.execute(insert_worker, (1, "Alex", json.dumps(ALEX.tolist()), "faces/Alex.jpg", "2026-02-28 20:00:00"))
        conn.execute(insert_worker, (2, "Blair", json.dumps(BLAIR.tolist()), None, "2026-02-28 21:00:00"))
        conn.execute(insert_worker, (5, "Removed", json.dumps(ALEX.tolist()), None, "2026-02-28 22:00:00"))
        conn.execute("DELETE FROM workers WHERE id = 5")
        conn.executescript("""
            INSERT INTO attendance_log VALUES
                (11, 1, 'Alex', 'clock_in', '2026-02-28T08:00:00', 0.8, 'entry', 1),
                (12, 1, 'Alex', 'clock_out', '2026-02-28T17:00:00', 0.9, 'exit', 0),
                (90, 1, 'Deleted', 'clock_in', '2026-02-28T18:00:00', 0.7, 'entry', 1);
            DELETE FROM attendance_log WHERE id = 90;
            INSERT INTO sync_state VALUES ('last_worker_sync', '2026-02-28T23:00:00');
        """)
        conn.commit()
        conn.close()

    @staticmethod
    def close_database():
        conn = getattr(database._local, "conn", None)
        if conn is not None:
            conn.close()
        database._local.conn = None

    def legacy_change(self, sql):
        conn = sqlite3.connect(self.db_path)
        conn.executescript(sql)
        conn.close()

    def test_original_database_upgrades(self):
        self.assert_upgrade()

    def test_original_database_after_crashed_startup_upgrades(self):
        # Every later release added these, then crashed on enrolled_at.
        self.legacy_change("""
            ALTER TABLE workers ADD COLUMN encoding_blob BLOB;
            ALTER TABLE workers ADD COLUMN employee_id TEXT;
        """)
        self.assert_upgrade()

    def test_database_touched_by_old_attendance_migration_recovers_event_types(self):
        # The old upgrader gave EVERY legacy row this default, so a nonempty
        # action cannot be trusted while the original event_type still exists.
        self.legacy_change("ALTER TABLE attendance_log ADD COLUMN action TEXT "
                           "CHECK(action IN ('clock_in', 'clock_out')) DEFAULT 'clock_in'")
        self.assert_upgrade()

    def test_database_upgraded_while_workers_were_empty_recovers(self):
        # With no workers, older releases upgraded "successfully": they added
        # every current column, the faulty action default and the delete
        # trigger, but kept both legacy NOT NULL columns.
        self.legacy_change("""
            DELETE FROM workers;
            ALTER TABLE workers ADD COLUMN encoding_blob BLOB;
            ALTER TABLE workers ADD COLUMN employee_id TEXT;
            ALTER TABLE workers ADD COLUMN enrolled_at TEXT DEFAULT (datetime('now'));
            ALTER TABLE workers ADD COLUMN photo_count INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE workers ADD COLUMN photo_paths TEXT NOT NULL DEFAULT '[]';
            ALTER TABLE workers ADD COLUMN server_id TEXT;
            ALTER TABLE attendance_log ADD COLUMN action TEXT
                CHECK(action IN ('clock_in', 'clock_out')) DEFAULT 'clock_in';
            ALTER TABLE attendance_log ADD COLUMN server_worker_id TEXT;
            CREATE TRIGGER attendance_keep_server_id_before_worker_delete
            BEFORE DELETE ON workers FOR EACH ROW
            WHEN OLD.server_id IS NOT NULL AND OLD.server_id != ''
            BEGIN
                UPDATE attendance_log SET server_worker_id = OLD.server_id
                WHERE worker_id = OLD.id AND synced = 0
                  AND (server_worker_id IS NULL OR server_worker_id = '');
            END;
        """)
        database.init_db()
        self.close_database()
        database.init_db()
        conn = database._get_conn()
        self.assertEqual([row[0] for row in conn.execute(
            "SELECT action FROM attendance_log ORDER BY id")], ["clock_in", "clock_out"])
        self.assertNotIn("face_encoding", {row["name"] for row in conn.execute("PRAGMA table_info(workers)")})
        worker = database.add_worker("Taylor", NEW_ENCODING, server_id=SERVER_ID)
        self.assertGreater(worker, 5, "Never reuse a deleted local worker id")
        log_id = database.log_attendance(worker, "Taylor", "clock_in")
        # The reinstalled delete trigger still freezes a missing snapshot.
        conn.execute("UPDATE attendance_log SET server_worker_id = NULL WHERE id = ?", (log_id,))
        conn.commit()
        database.remove_worker_by_server_id(SERVER_ID)
        self.assertEqual(conn.execute("SELECT server_worker_id FROM attendance_log WHERE id = ?",
                                      (log_id,)).fetchone()[0], SERVER_ID)

    def test_failed_worker_upgrade_rolls_back_and_retries(self):
        with mock.patch.object(database, "_serialize_encoding", side_effect=RuntimeError("power loss")):
            with self.assertRaises(RuntimeError):
                database.init_db()
        self.close_database()
        conn = sqlite3.connect(self.db_path)
        columns = [row[1] for row in conn.execute("PRAGMA table_info(workers)")]
        conn.close()
        self.assertEqual(columns, ["id", "name", "face_encoding", "photo_path", "created_at", "synced_at"])
        self.assert_upgrade()

    def assert_upgrade(self):
        conn = sqlite3.connect(self.db_path)
        before = conn.execute(f"SELECT {ATTENDANCE_COLUMNS} FROM attendance_log ORDER BY id").fetchall()
        conn.close()

        database.init_db()
        conn = database._get_conn()
        schema = conn.execute("SELECT name, sql FROM sqlite_master ORDER BY name").fetchall()
        workers = [dict(row) for row in conn.execute("SELECT * FROM workers ORDER BY id")]
        self.close_database()
        database.init_db()  # A real restart must be a no-op.
        conn = database._get_conn()
        self.assertEqual([tuple(row) for row in conn.execute(
            "SELECT name, sql FROM sqlite_master ORDER BY name")], [tuple(row) for row in schema])
        self.assertEqual([dict(row) for row in conn.execute("SELECT * FROM workers ORDER BY id")], workers)

        # Workers keep their ids, encodings, and enrollment time.
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(workers)")}
        self.assertNotIn("face_encoding", columns)
        alex = database.get_worker_by_id(1)
        np.testing.assert_array_equal(alex["encoding_blob"], ALEX)
        np.testing.assert_array_equal(database.get_worker_by_id(2)["encoding_blob"], BLAIR)
        self.assertEqual(alex["enrolled_at"], "2026-02-28 20:00:00")
        self.assertEqual([w["id"] for w in database.get_all_workers()], [1, 2])

        # Attendance keeps every original direction and field.
        after = conn.execute(f"SELECT {ATTENDANCE_COLUMNS} FROM attendance_log ORDER BY id").fetchall()
        self.assertEqual([tuple(row) for row in after], before)
        self.assertEqual([row[0] for row in conn.execute(
            "SELECT action FROM attendance_log ORDER BY id")], ["clock_in", "clock_out"])
        self.assertEqual(database.get_last_action(1), "clock_out")
        self.assertEqual(database.get_sync_state("last_worker_sync"), "2026-02-28T23:00:00")

        # Current writers can add workers and attendance.
        new_worker = database.add_worker("Taylor", NEW_ENCODING, server_id="b" * 32)
        self.assertGreater(new_worker, 5, "Never reuse a deleted local worker id")
        np.testing.assert_array_equal(database.get_worker_by_id(new_worker)["encoding_blob"], NEW_ENCODING)
        conn.execute("UPDATE workers SET server_id = ? WHERE id = 1", (SERVER_ID,))
        conn.commit()
        new_log = database.log_attendance(1, "Alex", "clock_in", note="After upgrade")
        self.assertGreater(new_log, 90, "Never reuse a deleted local event id")
        database.init_db()
        self.assertEqual(database.get_last_action(1), "clock_in")

        # Upload carries the original exit, followed by the new arrival.
        def acknowledge_claim_group(*args, **kwargs):
            return mock.Mock(status_code=200, json=lambda: {"acknowledged": len(kwargs["json"]["logs"])})
        with mock.patch.object(sync, "_auth_headers", return_value={}), \
             mock.patch.object(sync.requests, "post", side_effect=acknowledge_claim_group) as upload:
            self.assertTrue(sync.sync_attendance())
        logs = sorted((row for call in upload.call_args_list for row in call.kwargs["json"]["logs"]),
                      key=lambda row: row["timestamp"])
        self.assertEqual([(row["worker_id"], row["event_type"], row["action"], row["timestamp"]) for row in logs], [
            (SERVER_ID, "clock_out", "clock_out", "2026-02-28T17:00:00"),
            (SERVER_ID, "clock_in", "clock_in", logs[1]["timestamp"]),
        ])
        self.assertEqual(logs[0]["kiosk_id"], "exit")
        self.assertEqual(database.count_unsynced_logs(), 0)


if __name__ == "__main__":
    unittest.main()
