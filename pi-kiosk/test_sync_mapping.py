#!/usr/bin/env python3
"""Behavioral coverage: queued attendance keeps its server worker id across deactivation."""

import logging
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

try:
    import numpy as np
    import requests  # noqa: F401  (imported by sync)
except ImportError as exc:  # pragma: no cover - environment guard
    # The other kiosk tests in `npm test` are pure Python; this one exercises
    # database.py and sync.py, which need the kiosk runtime deps.
    print(f"SKIP test_sync_mapping: {exc}. Install pi-kiosk/requirements.txt to run it.", file=sys.stderr)
    sys.exit(0)

KIOSK_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(KIOSK_DIR))

import config  # noqa: E402
import database  # noqa: E402
import sync  # noqa: E402

fake_embeddings = types.ModuleType("embeddings")
fake_embeddings.EXPECTED_EMBEDDING_DIM = 512
fake_liveness = types.ModuleType("liveness")
fake_liveness.LivenessChecker = mock.Mock
with mock.patch.dict(sys.modules, {"embeddings": fake_embeddings, "liveness": fake_liveness}):
    import recognition  # noqa: E402

from matching import FreshFaceMatcher

ENCODING = np.ones(512, dtype=np.float64)
SERVER_ID = "jh7f1wb6ndevpfktsdq1vmwmd584grnd"


def _ok_response():
    return mock.Mock(status_code=200, text="", json=lambda: {"synced": 0})


class AttendanceServerIdMappingTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for name, value in (
            ("DB_PATH", os.path.join(tmp.name, "attendance.db")),
            ("KIOSK_API_KEY", "test-kiosk-key"),
        ):
            patcher = mock.patch.object(config, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self._close_db)
        database._local.conn = None
        sync._last_orphan_signature = None
        sync._last_orphan_warned_at = 0.0
        database.init_db()

    @staticmethod
    def _close_db():
        conn = getattr(database._local, "conn", None)
        if conn is not None:
            conn.close()
        database._local.conn = None

    def _insert_legacy_row(self, worker_id, name="caleb", action="clock_in", ts="2026-06-01T08:00:00", synced=0):
        """A row as written by a release that predates server_worker_id."""
        conn = database._get_conn()
        cursor = conn.execute(
            "INSERT INTO attendance_log (worker_id, worker_name, action, timestamp, synced) VALUES (?, ?, ?, ?, ?)",
            (worker_id, name, action, ts, synced),
        )
        conn.commit()
        return int(cursor.lastrowid)

    def _row(self, log_id):
        return database._get_conn().execute(
            "SELECT worker_id, server_worker_id, synced FROM attendance_log WHERE id = ?", (log_id,)
        ).fetchone()

    # --- write path -------------------------------------------------------

    def test_log_attendance_snapshots_server_worker_id(self):
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)
        log_id = database.log_attendance(worker_id=worker_id, worker_name="caleb", action="clock_in")

        self.assertEqual(self._row(log_id)["server_worker_id"], SERVER_ID)

    def test_log_attendance_keeps_caller_supplied_id_when_worker_row_is_already_gone(self):
        """A deactivation landing between match and record must not strand the event."""
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)
        database.remove_worker_by_server_id(SERVER_ID)

        log_id = database.log_attendance(
            worker_id=worker_id, worker_name="caleb", action="clock_in", server_worker_id=SERVER_ID
        )

        self.assertEqual(self._row(log_id)["server_worker_id"], SERVER_ID)

    def test_recognition_snapshot_identity_survives_delete_and_roster_reload(self):
        """Exercise the match-to-write contract used by main.py during a sync race."""
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)
        recognizer = recognition.FaceRecognizer()
        recognizer.load_faces()
        encodings, ids, names, server_ids = recognizer.snapshot_known_faces()
        matched = {
            "worker_id": ids[0],
            "name": names[0],
            "encoding": encodings[0],
            "server_worker_id": server_ids[ids[0]],
        }

        database.remove_worker_by_server_id(SERVER_ID)
        database.add_worker(name="replacement", encoding=-ENCODING, server_id="replacement-server-id")
        recognizer.reload_faces()  # sync reload lands before main consumes the old detection result

        log_id = database.log_attendance(
            worker_id=matched["worker_id"],
            worker_name=matched["name"],
            action="clock_in",
            server_worker_id=matched["server_worker_id"],
        )
        with mock.patch.object(sync.requests, "post", return_value=_ok_response()) as post:
            self.assertTrue(sync.sync_attendance())
        self.assertEqual(post.call_args.kwargs["json"]["logs"][0]["worker_id"], SERVER_ID)
        self.assertEqual(self._row(log_id)["server_worker_id"], SERVER_ID)

        main_source = (KIOSK_DIR / "main.py").read_text(encoding="utf-8")
        self.assertIn("known_server_ids.get(candidate_worker_id)", main_source)
        self.assertIn('server_worker_id = result.get("server_worker_id")', main_source)
        self.assertIn('fresh.get("candidate_worker_id"), fresh.get("server_worker_id")', main_source)
        self.assertNotIn('recognizer.server_id_for(worker_id)', main_source)

    def test_roster_exposes_server_ids_for_the_recognizer(self):
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)

        _, ids, _, server_ids = database.get_worker_roster()

        self.assertEqual(ids, [worker_id])
        self.assertEqual(server_ids, {worker_id: SERVER_ID})

    # --- live roster synchronization --------------------------------------

    def _run_sync_cycle(self, recognizer, rows, online=True):
        reporter = mock.Mock()
        worker = sync.SyncWorker(recognizer=recognizer, health_reporter=reporter)
        worker._running = True
        response = mock.Mock(status_code=200, json=lambda: {
            "workers": rows, "synced_at": "2026-09-02T12:00:00",
        })
        def stop_after_cycle(_seconds):
            worker._running = False
        with mock.patch.object(sync, "check_server", return_value=online), \
             mock.patch.object(sync.requests, "get", return_value=response), \
             mock.patch.object(sync, "sync_attendance", return_value=True), \
             mock.patch.object(sync, "sync_recognition_attempts", return_value=True), \
             mock.patch.object(sync.time, "sleep", side_effect=stop_after_cycle), \
             mock.patch.object(config, "SYNC_INTERVAL", 1):
            worker._run()
        return reporter

    def _loaded_recognizer(self):
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID, employee_id="E1")
        database.set_sync_state("last_worker_sync", "2026-09-01T12:00:00")
        recognizer = recognition.FaceRecognizer()
        recognizer.load_faces()
        return worker_id, recognizer

    def _matches(self, recognizer, matcher, frame_ts, encoding=ENCODING):
        encodings, ids, _, server_ids = recognizer.snapshot_known_faces()
        _, approved = matcher.match(encoding, list(enumerate(encodings)), ids, server_ids, frame_ts)
        return approved

    def test_partial_sync_publishes_deactivation_without_claiming_success(self):
        for invalid_row in (
            {"id": "invalid", "name": "Invalid", "active": True, "face_encoding": [0.1]},
            None,  # Unexpected exception after an already-committed deletion.
        ):
            with self.subTest(invalid_row=invalid_row):
                worker_id, recognizer = self._loaded_recognizer()
                matcher = FreshFaceMatcher(window=3, threshold=0.5)
                self.assertTrue(self._matches(recognizer, matcher, 1.0))
                reporter = self._run_sync_cycle(recognizer, [
                    {"id": SERVER_ID, "active": False}, invalid_row,
                ])
                self.assertIsNone(database.get_worker_by_id(worker_id))
                self.assertFalse(self._matches(recognizer, matcher, 2.0))
                self.assertEqual(database.get_sync_state("last_worker_sync"), "2026-09-01T12:00:00")
                self.assertFalse(any("last_sync_at" in call.kwargs for call in reporter.call_args_list))

    def test_reload_failure_clears_stale_roster_and_later_reload_recovers(self):
        _, recognizer = self._loaded_recognizer()
        matcher = FreshFaceMatcher(window=3, threshold=0.5)
        self.assertTrue(self._matches(recognizer, matcher, 1.0))
        with mock.patch.object(database, "get_worker_roster", side_effect=RuntimeError("SQLite unavailable")):
            reporter = self._run_sync_cycle(recognizer, [{"id": SERVER_ID, "active": False}])
        self.assertFalse(self._matches(recognizer, matcher, 2.0))
        self.assertEqual(recognizer.usable_count, 0)
        self.assertFalse(any("last_sync_at" in call.kwargs for call in reporter.call_args_list))
        database.add_worker(name="replacement", encoding=-ENCODING, server_id="replacement", employee_id="E2")
        reporter = self._run_sync_cycle(recognizer, [])
        self.assertTrue(self._matches(recognizer, matcher, 3.0, -ENCODING))
        self.assertTrue(any("last_sync_at" in call.kwargs for call in reporter.call_args_list))

    def test_successful_sync_publishes_replacement_and_advances_watermark(self):
        _, recognizer = self._loaded_recognizer()
        matcher = FreshFaceMatcher(window=3, threshold=0.5)
        self.assertTrue(self._matches(recognizer, matcher, 1.0))
        reporter = self._run_sync_cycle(recognizer, [
            {"id": SERVER_ID, "active": False},
            {"id": "replacement", "name": "Replacement", "employee_id": "E2", "active": True,
             "face_encoding": (-ENCODING).tolist()},
        ])
        self.assertFalse(self._matches(recognizer, matcher, 2.0))
        self.assertTrue(self._matches(recognizer, matcher, 3.0, -ENCODING))
        self.assertEqual(database.get_sync_state("last_worker_sync"), "2026-09-02T12:00:00")
        self.assertTrue(any("last_sync_at" in call.kwargs for call in reporter.call_args_list))

    def test_unchanged_and_offline_cycles_preserve_recognition(self):
        for online in (True, False):
            with self.subTest(online=online):
                _, recognizer = self._loaded_recognizer()
                matcher = FreshFaceMatcher(window=3, threshold=0.5)
                self.assertTrue(self._matches(recognizer, matcher, 1.0))
                reporter = self._run_sync_cycle(recognizer, [], online=online)
                self.assertTrue(self._matches(recognizer, matcher, 2.0))
                self.assertEqual(any("last_sync_at" in call.kwargs for call in reporter.call_args_list), online)
                self.assertEqual(database.get_sync_state("last_worker_sync"),
                                 "2026-09-02T12:00:00" if online else "2026-09-01T12:00:00")

    # --- worker deletion --------------------------------------------------

    def test_deactivation_delete_freezes_mapping_on_queued_rows(self):
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)
        legacy_id = self._insert_legacy_row(worker_id)
        self.assertIsNone(self._row(legacy_id)["server_worker_id"])

        self.assertTrue(database.remove_worker_by_server_id(SERVER_ID))

        self.assertIsNone(database.get_worker_by_id(worker_id))
        self.assertEqual(self._row(legacy_id)["server_worker_id"], SERVER_ID)

    def test_hand_run_sql_delete_is_covered_by_the_trigger(self):
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)
        legacy_id = self._insert_legacy_row(worker_id)

        conn = database._get_conn()
        conn.execute("DELETE FROM workers WHERE name = 'caleb'")
        conn.commit()

        self.assertEqual(self._row(legacy_id)["server_worker_id"], SERVER_ID)

    def test_delete_preserves_original_snapshot_after_live_id_changes(self):
        server_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        server_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=server_a)
        log_id = database.log_attendance(worker_id=worker_id, worker_name="caleb", action="clock_in")
        conn = database._get_conn()
        conn.execute("UPDATE workers SET server_id = ? WHERE id = ?", (server_b, worker_id))
        conn.commit()

        conn.execute("DELETE FROM workers WHERE id = ?", (worker_id,))
        conn.commit()

        self.assertEqual(self._row(log_id)["server_worker_id"], server_a)
        with mock.patch.object(sync.requests, "post", return_value=_ok_response()) as post:
            self.assertTrue(sync.sync_attendance())
        self.assertEqual(post.call_args.kwargs["json"]["logs"][0]["worker_id"], server_a)

    # --- startup migration ------------------------------------------------

    def test_init_db_backfills_queued_rows_only(self):
        worker_id = database.add_worker(name="prime", encoding=ENCODING, server_id="cccccccccccccccccccccccccccccccc")
        queued_id = self._insert_legacy_row(worker_id, name="prime", synced=0)
        synced_id = self._insert_legacy_row(worker_id, name="prime", synced=1)
        blank_id = self._insert_legacy_row(worker_id, name="prime", synced=0)
        conn = database._get_conn()
        conn.execute("UPDATE attendance_log SET server_worker_id = '' WHERE id = ?", (blank_id,))
        conn.commit()

        database.init_db()

        self.assertEqual(self._row(queued_id)["server_worker_id"], "cccccccccccccccccccccccccccccccc")
        self.assertEqual(self._row(blank_id)["server_worker_id"], "cccccccccccccccccccccccccccccccc")
        self.assertIsNone(self._row(synced_id)["server_worker_id"])

    def test_init_db_replaces_old_installed_delete_trigger(self):
        conn = database._get_conn()
        conn.execute("DROP TRIGGER attendance_keep_server_id_before_worker_delete")
        conn.execute(
            """
            CREATE TRIGGER attendance_keep_server_id_before_worker_delete
            BEFORE DELETE ON workers FOR EACH ROW
            BEGIN
                UPDATE attendance_log SET server_worker_id = OLD.server_id
                WHERE worker_id = OLD.id AND synced = 0
                  AND (server_worker_id IS NULL OR server_worker_id = '');
            END
            """
        )
        conn.commit()

        database.init_db()
        trigger_sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' "
            "AND name = 'attendance_keep_server_id_before_worker_delete'"
        ).fetchone()["sql"]
        self.assertIn("server_worker_id IS NULL", trigger_sql)

        worker_id = database.add_worker(name="upgrade", encoding=ENCODING, server_id="server-b")
        log_id = database.log_attendance(
            worker_id=worker_id,
            worker_name="upgrade",
            action="clock_in",
            server_worker_id="server-a",
        )
        database.remove_worker_by_server_id("server-b")
        self.assertEqual(self._row(log_id)["server_worker_id"], "server-a")

    # --- sync -------------------------------------------------------------

    def test_sync_uses_snapshot_after_worker_row_is_gone(self):
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id=SERVER_ID)
        log_id = database.log_attendance(worker_id=worker_id, worker_name="caleb", action="clock_in")
        database.remove_worker_by_server_id(SERVER_ID)
        self.assertIsNone(database.get_server_id(worker_id))

        with mock.patch.object(sync.requests, "post", return_value=_ok_response()) as post:
            self.assertTrue(sync.sync_attendance())

        self.assertTrue(post.call_args.args[0].endswith("/api/attendance/bulk"))
        sent = post.call_args.kwargs["json"]["logs"]
        self.assertEqual([entry["worker_id"] for entry in sent], [SERVER_ID])
        self.assertEqual(self._row(log_id)["synced"], 1)
        self.assertEqual(database.count_unsynced_logs(), 0)

    def test_sync_preserves_original_server_id_when_live_id_changes(self):
        """The identity captured when attendance happened must remain authoritative."""
        worker_id = database.add_worker(name="caleb", encoding=ENCODING, server_id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        database.log_attendance(worker_id=worker_id, worker_name="caleb", action="clock_in")
        database.add_worker(name="caleb", encoding=ENCODING, server_id=None)  # name match keeps the row
        conn = database._get_conn()
        conn.execute("UPDATE workers SET server_id = 'new-server-id' WHERE id = ?", (worker_id,))
        conn.commit()

        with mock.patch.object(sync.requests, "post", return_value=_ok_response()) as post:
            self.assertTrue(sync.sync_attendance())

        sent = post.call_args.kwargs["json"]["logs"]
        self.assertEqual([entry["worker_id"] for entry in sent], ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"])

    def test_orphaned_rows_stay_queued_and_warn_once_per_set(self):
        self._insert_legacy_row(4, ts="2026-06-01T08:00:00")
        self._insert_legacy_row(4, ts="2026-06-02T08:00:00")

        with mock.patch.object(sync.requests, "post") as post:
            with self.assertLogs(sync.logger, level=logging.DEBUG) as first:
                self.assertFalse(sync.sync_attendance())
            with self.assertLogs(sync.logger, level=logging.DEBUG) as second:
                self.assertFalse(sync.sync_attendance())
            post.assert_not_called()

        first_warnings = [r for r in first.records if r.levelno >= logging.WARNING]
        second_warnings = [r for r in second.records if r.levelno >= logging.WARNING]
        self.assertEqual(len(first_warnings), 1)
        self.assertIn("local_worker_id=4 name=caleb x2", first_warnings[0].getMessage())
        self.assertEqual(second_warnings, [])
        # Still counted for health reporting; nothing was silently dropped or marked synced.
        self.assertEqual(database.count_unsynced_logs(), 2)

    def test_orphan_warning_repeats_hourly_while_unchanged(self):
        self._insert_legacy_row(4)
        with mock.patch.object(sync.requests, "post"):
            with self.assertLogs(sync.logger, level=logging.DEBUG) as first:
                sync.sync_attendance()
            sync._last_orphan_warned_at -= sync.ORPHAN_REWARN_SEC + 1
            with self.assertLogs(sync.logger, level=logging.DEBUG) as later:
                sync.sync_attendance()

        self.assertEqual(sum(r.levelno >= logging.WARNING for r in first.records), 1)
        self.assertEqual(sum(r.levelno >= logging.WARNING for r in later.records), 1)

    def test_hand_entered_value_that_is_not_a_server_id_is_never_sent(self):
        """An operator typo (employee id, name) must stay queued rather than be stored server-side."""
        log_id = self._insert_legacy_row(4)
        conn = database._get_conn()
        conn.execute("UPDATE attendance_log SET server_worker_id = 'E1042' WHERE id = ?", (log_id,))
        conn.commit()

        with mock.patch.object(sync.requests, "post") as post:
            with self.assertLogs(sync.logger, level=logging.ERROR) as logs:
                self.assertFalse(sync.sync_attendance())
            post.assert_not_called()

        self.assertIn("'E1042'", logs.output[0])
        self.assertEqual(self._row(log_id)["synced"], 0)

    def test_mixed_batch_sends_mapped_rows_and_keeps_orphans(self):
        worker_id = database.add_worker(name="prime", encoding=ENCODING, server_id="cccccccccccccccccccccccccccccccc")
        good_id = database.log_attendance(worker_id=worker_id, worker_name="prime", action="clock_in")
        orphan_id = self._insert_legacy_row(4)

        with mock.patch.object(sync.requests, "post", return_value=_ok_response()) as post:
            self.assertFalse(sync.sync_attendance())  # not fully drained

        sent = post.call_args.kwargs["json"]["logs"]
        self.assertEqual([entry["worker_id"] for entry in sent], ["cccccccccccccccccccccccccccccccc"])
        self.assertEqual(self._row(good_id)["synced"], 1)
        self.assertEqual(self._row(orphan_id)["synced"], 0)

    def test_orphan_rows_sync_once_server_worker_id_is_set(self):
        """The operator replay path: set server_worker_id on stranded rows and let sync send them."""
        self._insert_legacy_row(4)
        with mock.patch.object(sync.requests, "post") as post:
            self.assertFalse(sync.sync_attendance())
            post.assert_not_called()

        conn = database._get_conn()
        conn.execute("UPDATE attendance_log SET server_worker_id = ? WHERE worker_id = 4 AND synced = 0", (SERVER_ID,))
        conn.commit()

        with mock.patch.object(sync.requests, "post", return_value=_ok_response()) as post:
            self.assertTrue(sync.sync_attendance())
        sent = post.call_args.kwargs["json"]["logs"]
        self.assertEqual([entry["worker_id"] for entry in sent], [SERVER_ID])
        self.assertEqual(database.count_unsynced_logs(), 0)


if __name__ == "__main__":
    unittest.main()
