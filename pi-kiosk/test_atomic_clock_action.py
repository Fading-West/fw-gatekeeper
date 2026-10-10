"""Real SQLite and Flask coverage for concurrent kiosk attendance writers."""

import ast
from datetime import datetime, timedelta, timezone
from pathlib import Path
import threading
import unittest
from unittest import mock

import numpy as np

import app
import config
import database
from kiosk_ui_auth import KIOSK_SUPERVISOR_SESSION_COOKIE, supervisor_session_token
from liveness_policy import LivenessPolicy
from test_attendance_timezones import local_clock
from test_oct02_recognition_roster_race import Fixture


class AtomicClockActionTests(Fixture):
    def setUp(self):
        super().setUp()
        for name, value in {
            "KIOSK_TYPE": "auto",
            "AUTO_CLOCK_STALE_HOURS": 16,
            "KIOSK_UI_KEY": "synthetic-ui-key",
            "KIOSK_SUPERVISOR_PIN": "synthetic-supervisor-pin",
        }.items():
            patcher = mock.patch.object(config, name, value, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)

        # Execute the production closure without loading camera/dlib services.
        tree = ast.parse(Path(__file__).with_name("main.py").read_text())
        record = next(node for node in ast.walk(tree)
                      if isinstance(node, ast.FunctionDef) and node.name == "record_clock")
        self.policy = LivenessPolicy(False, mock.Mock())
        self.display = mock.Mock()
        self.last_clocks = {}
        namespace = {
            "config": config, "database": database, "datetime": datetime, "timezone": timezone,
            "timedelta": timedelta,
            "recognizer": mock.Mock(liveness_policy=self.policy, known_count=1),
            "web_app": self.display, "logger": mock.Mock(), "last_clocks": self.last_clocks,
            "_log_recognition_attempt": mock.Mock(), "_now_iso": lambda: "synthetic-time",
            "base_degraded_reason": lambda: None,
        }
        exec(compile(ast.Module(body=[record], type_ignores=[]), "main.py", "exec"), namespace)
        self.record_clock = namespace["record_clock"]
        # Exercise the real camera-loop debounce expressions as well as its
        # write closure, without importing or starting camera hardware.
        debounce = ast.parse("def is_debounced(worker_id):\n    return recently_clocked").body[0]
        debounce.body[:0] = [next(node for node in ast.walk(tree)
                                 if isinstance(node, ast.Assign)
                                 and any(isinstance(target, ast.Name) and target.id == name
                                         for target in node.targets))
                             for name in ("last", "recently_clocked")]
        exec(compile(ast.fix_missing_locations(ast.Module(body=[debounce], type_ignores=[])),
                     "main.py", "exec"), namespace)
        self.is_debounced = namespace["is_debounced"]
        self.clock_namespace = namespace

    def automatic(self):
        return self.record_clock(
            {"candidate_encoding": np.ones(512)}, self.worker, "Synthetic worker", "1", .95,
            liveness_confirmed=False, server_worker_id="synthetic-server-id",
        )

    def manual(self, action=None):
        with app.app.test_client() as client:
            client.set_cookie(KIOSK_SUPERVISOR_SESSION_COOKIE, supervisor_session_token())
            payload = {"worker_id": self.worker}
            if action is not None:
                payload["action"] = action
            response = client.post("/manual-clock", json=payload,
                                   headers={"X-Kiosk-UI-Key": config.KIOSK_UI_KEY})
            self.assertEqual(response.status_code, 200)
            return response.get_json()

    def test_manual_write_during_automatic_liveness_gate_does_not_duplicate_clock_in(self):
        self.manual_during_automatic_gate()

    def test_explicit_supervisor_write_is_seen_by_pending_automatic_clock(self):
        self.manual_during_automatic_gate(action="clock_in")

    def test_two_pending_automatic_writes_do_not_duplicate_clock_in(self):
        self.manual_during_automatic_gate(automatic_competitor=True)

    def manual_during_automatic_gate(self, action=None, automatic_competitor=False):
        paused, release = threading.Event(), threading.Event()
        errors, recorded = [], []
        original = self.policy.record

        def pause_before_write(callback, **fields):
            if threading.current_thread() is thread:
                paused.set()
                if not release.wait(2):
                    raise TimeoutError("automatic writer was not released")
            return original(callback, **fields)

        def automatic_thread():
            try:
                recorded.append(self.automatic())
            except Exception as exc:
                errors.append(exc)
            finally:
                self.close()

        thread = threading.Thread(target=automatic_thread)
        with mock.patch.object(self.policy, "record", side_effect=pause_before_write):
            thread.start()
            try:
                self.assertTrue(paused.wait(2))
                if automatic_competitor:
                    self.assertTrue(self.automatic())
                else:
                    manual = self.manual(action=action)
            finally:
                release.set()
                thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(recorded, [True])
        if not automatic_competitor:
            self.assertEqual(manual["action"], "clock_in")
        logs = database.get_unsynced_logs()
        self.assertEqual([row["action"] for row in logs], ["clock_in", "clock_out"])
        self.assertEqual(self.display.update_status.call_args.kwargs["action"], "clock_out")
        self.assertIn(self.worker, self.last_clocks)

    def test_automatic_write_during_pending_manual_request_does_not_duplicate_clock_in(self):
        paused, release = threading.Event(), threading.Event()
        errors, responses = [], []
        original = database.log_attendance

        def pause_manual_write(*args, **fields):
            if threading.current_thread() is thread:
                paused.set()
                if not release.wait(2):
                    raise TimeoutError("manual writer was not released")
            return original(*args, **fields)

        def manual_thread():
            try:
                responses.append(self.manual())
            except Exception as exc:
                errors.append(exc)
            finally:
                self.close()

        thread = threading.Thread(target=manual_thread)
        with mock.patch.object(database, "log_attendance", side_effect=pause_manual_write):
            thread.start()
            try:
                self.assertTrue(paused.wait(2))
                self.assertTrue(self.automatic())
            finally:
                release.set()
                thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual([row["action"] for row in database.get_unsynced_logs()],
                         ["clock_in", "clock_out"])
        self.assertEqual(responses[0]["action"], "clock_out")

    def test_manual_inference_holds_write_lock_until_insert(self):
        writing, finished = threading.Event(), threading.Event()
        errors = []
        original_log, original_last = database.log_attendance, database._get_last_attendance

        def signal_write(*args, **fields):
            if threading.current_thread() is thread:
                writing.set()
            return original_log(*args, **fields)

        def competing_writer():
            try:
                self.manual(action="clock_out")
            except Exception as exc:
                errors.append(exc)
            finally:
                self.close()
                finished.set()

        def read_last_under_lock(worker_id):
            self.assertTrue(database._get_conn().in_transaction)
            last = original_last(worker_id)
            thread.start()
            self.assertTrue(writing.wait(2))
            self.assertFalse(finished.wait(.05), "competing attendance must wait for the insert")
            return last

        thread = threading.Thread(target=competing_writer)
        try:
            with mock.patch.object(database, "log_attendance", side_effect=signal_write), \
                    mock.patch.object(database, "_get_last_attendance", side_effect=read_last_under_lock):
                response = self.manual()
        finally:
            if thread.ident is not None:
                thread.join(timeout=3)
        self.assertTrue(finished.is_set())
        self.assertEqual(errors, [])
        self.assertEqual(response["action"], "clock_in")
        self.assertEqual([row["action"] for row in database.get_unsynced_logs()],
                         ["clock_in", "clock_out"])

    def test_entry_and_exit_keep_fixed_actions_and_explicit_manual_override(self):
        for kiosk_type, expected in [("entry", "clock_in"), ("exit", "clock_out")]:
            with self.subTest(kiosk_type=kiosk_type), mock.patch.object(config, "KIOSK_TYPE", kiosk_type):
                self.assertTrue(self.automatic())
                automatic_log = database.get_unsynced_logs()[-1]
                response = self.manual()
                self.assertEqual(automatic_log["action"], expected)
                self.assertEqual(self.display.update_status.call_args.kwargs["action"], expected)
                self.assertEqual(response["action"], expected)
                override = "clock_out" if expected == "clock_in" else "clock_in"
                self.assertEqual(self.manual(action=override)["action"], override)

    def test_liveness_failure_blocks_write_and_does_not_arm_debounce(self):
        self.policy.required = True
        self.assertFalse(self.automatic())
        self.assertEqual(database.count_unsynced_logs(), 0)
        self.assertEqual(self.last_clocks, {})

    def test_attendance_does_not_commit_callers_transaction(self):
        conn = database._get_conn()
        with self.assertRaisesRegex(RuntimeError, "rollback"), conn:
            conn.execute("BEGIN IMMEDIATE")
            database.log_attendance(self.worker, "Synthetic worker")
            raise RuntimeError("rollback")
        self.assertFalse(conn.in_transaction)
        self.assertEqual(database.count_unsynced_logs(), 0)

    def test_saved_action_is_independent_of_later_attendance(self):
        first = database.log_attendance(self.worker, "Synthetic worker")
        second = database.log_attendance(self.worker, "Synthetic worker")
        self.assertEqual(database.get_last_action(self.worker), "clock_out")
        self.assertEqual(database.get_attendance_action(first), "clock_in")
        self.assertEqual(database.get_attendance_action(second), "clock_out")

    def test_latest_insert_query_uses_worker_id_index_without_sorting_history(self):
        conn = database._get_conn()
        conn.executemany("""INSERT INTO attendance_log
            (worker_id, worker_name, action, timestamp) VALUES (?, 'Synthetic worker', 'clock_in', ?)""",
            [(self.worker, "2026-10-06T14:00:00+00:00")] * 2000)
        conn.commit()
        database.log_attendance(self.worker, "Synthetic worker", "clock_out",
                                timestamp="2026-10-06T13:00:00+00:00")
        statements = []
        conn.set_trace_callback(statements.append)
        try:
            self.assertEqual(database.get_last_action(self.worker), "clock_out")
        finally:
            conn.set_trace_callback(None)
        query = next(sql for sql in statements if "FROM attendance_log" in sql)
        plan = " ".join(row["detail"] for row in conn.execute("EXPLAIN QUERY PLAN " + query))
        self.assertIn("SEARCH attendance_log USING INDEX idx_attendance_worker_id", plan)
        self.assertNotIn("TEMP B-TREE", plan)

    def assert_inferred_action(self, previous, scan, expected, *, mode="auto", hours=16,
                               last_action="clock_in"):
        # Reset only this isolated fixture so every case starts with one prior scan.
        conn = database._get_conn()
        conn.execute("DELETE FROM attendance_log")
        conn.commit()
        database.log_attendance(self.worker, "Synthetic worker", last_action, timestamp=previous)
        with mock.patch.object(config, "KIOSK_TYPE", mode), \
                mock.patch.object(config, "AUTO_CLOCK_STALE_HOURS", hours), \
                local_clock("America/Denver", datetime.fromisoformat(scan)):
            self.assertTrue(self.automatic())
            self.assertEqual(database.get_unsynced_logs()[-1]["action"], expected)
            self.assertEqual(self.display.update_status.call_args.kwargs["action"], expected)
            # Repeat from the same prior event through the real Flask manual route.
            conn.execute("DELETE FROM attendance_log WHERE id > (SELECT MIN(id) FROM attendance_log)")
            conn.commit()
            self.assertEqual(self.manual()["action"], expected)

    def test_missed_clock_out_recovers_and_later_shifts_keep_their_direction(self):
        start = datetime(2026, 10, 5, 14, tzinfo=timezone.utc)
        database.log_attendance(self.worker, "Synthetic worker", "clock_in", timestamp=start.isoformat())
        for hours, expected in [(24, "clock_in"), (32, "clock_out"), (48, "clock_in")]:
            with self.subTest(hours=hours), local_clock("America/Denver", start + timedelta(hours=hours)):
                self.assertTrue(self.automatic())
                self.assertEqual(database.get_unsynced_logs()[-1]["action"], expected)

    def test_overnight_shift_clocks_out_through_both_paths(self):
        self.assert_inferred_action("2026-10-05T22:00:00-06:00", "2026-10-06T06:00:00-06:00", "clock_out")

    def test_stale_window_boundary_and_config_override_through_both_paths(self):
        start = datetime(2026, 10, 5, 14, tzinfo=timezone.utc)
        for hours in (16, 10.5):
            for seconds, expected in [(-1, "clock_out"), (0, "clock_out"), (1, "clock_in")]:
                with self.subTest(hours=hours, seconds=seconds):
                    scan = start + timedelta(hours=hours, seconds=seconds)
                    self.assert_inferred_action(start.isoformat(), scan.isoformat(), expected, hours=hours)

    def test_stale_state_does_not_change_entry_exit_or_explicit_manual_actions(self):
        for mode, expected in [("entry", "clock_in"), ("exit", "clock_out")]:
            with self.subTest(mode=mode):
                self.assert_inferred_action("2026-10-05T08:00:00-06:00",
                                           "2026-10-06T08:00:00-06:00", expected, mode=mode)
        with local_clock("America/Denver", datetime(2026, 10, 7, 14, tzinfo=timezone.utc)):
            self.assertEqual(self.manual(action="clock_out")["action"], "clock_out")

    def test_old_clock_out_still_starts_a_new_shift_through_both_paths(self):
        self.assert_inferred_action("2026-10-05T08:00:00-06:00", "2026-10-06T08:00:00-06:00",
                                   "clock_in", last_action="clock_out")

    def test_dst_uses_elapsed_hours_through_both_paths(self):
        cases = [
            # Spring: 17 wall-clock hours, but only 16 elapsed hours.
            ("2026-03-07T14:00:00-07:00", "2026-03-08T07:00:00-06:00", "clock_out"),
            ("2026-03-07T14:00:00-07:00", "2026-03-08T07:00:01-06:00", "clock_in"),
            # Fall: 16 wall-clock hours, but 17 elapsed hours.
            ("2026-10-31T14:00:00-06:00", "2026-11-01T06:00:00-07:00", "clock_in"),
            ("2026-10-31T22:00:00-06:00", "2026-11-01T06:00:00-07:00", "clock_out"),
            # During the repeated hour, offsets determine event order and age.
            ("2026-11-01T01:55:00-06:00", "2026-11-01T01:05:00-07:00", "clock_out"),
        ]
        for previous, scan, expected in cases:
            with self.subTest(previous=previous, scan=scan):
                self.assert_inferred_action(previous, scan, expected)

    def test_legacy_local_timestamp_uses_existing_instant_interpretation(self):
        self.assert_inferred_action("2026-10-05T22:00:00", "2026-10-06T06:00:00-06:00", "clock_out")

    def test_stored_timestamp_formats_share_the_stale_boundary(self):
        # All strings identify 2026-10-06 04:00 UTC on the Denver device.
        for previous in ("2026-10-05T22:00:00", "2026-10-05 22:00:00",
                         "2026-10-05T22:00:00.000000", "2026-10-05T22:00:00-06:00",
                         "2026-10-06T04:00:00+00:00", "2026-10-06 04:00:00+00:00",
                         "2026-10-06T04:00:00Z", "2026-10-06T06:00:00+02:00"):
            for scan, expected in (("2026-10-06T20:00:00Z", "clock_out"),
                                   ("2026-10-06T20:00:01Z", "clock_in")):
                with self.subTest(previous=previous, scan=scan):
                    self.assert_inferred_action(previous, scan, expected)

    def test_backward_clock_keeps_toggling_through_both_paths_and_restart(self):
        start = datetime(2026, 10, 6, 14, tzinfo=timezone.utc)
        for last_action in ("clock_in", "clock_out"):
            # One hour models fake-hwclock restoring the last hourly save.
            for seconds in (1, 3600, 24 * 3600):
                for automatic_first in (True, False):
                    with self.subTest(last_action=last_action, seconds=seconds,
                                      automatic_first=automatic_first):
                        conn = database._get_conn()
                        conn.execute("DELETE FROM attendance_log")
                        conn.commit()
                        database.log_attendance(self.worker, "Synthetic worker", last_action,
                                                timestamp=start.isoformat())
                        # Power loss: the SQLite row survives, process state does not.
                        self.close()
                        self.last_clocks.clear()
                        expected_actions = [last_action]
                        expected_times = [start.isoformat()]
                        for index in range(4):
                            scan = start - timedelta(seconds=seconds) + timedelta(minutes=index * 6)
                            expected = "clock_out" if expected_actions[-1] == "clock_in" else "clock_in"
                            with local_clock("America/Denver", scan) as clock, \
                                    mock.patch.dict(self.clock_namespace, {"datetime": clock}):
                                self.assertFalse(self.is_debounced(self.worker))
                                if (index % 2 == 0) == automatic_first:
                                    self.assertTrue(self.automatic())
                                    self.assertEqual(self.display.update_status.call_args.kwargs["action"], expected)
                                else:
                                    self.assertEqual(self.manual()["action"], expected)
                                self.assertTrue(self.is_debounced(self.worker))
                                self.assertEqual(database.get_last_action(self.worker), expected)
                            expected_actions.append(expected)
                            expected_times.append(scan.isoformat())
                            logs = database.get_unsynced_logs()
                            self.assertEqual([row["action"] for row in logs], expected_actions)
                            self.assertEqual([row["timestamp"] for row in logs], expected_times)
                            self.assertFalse(database._get_conn().in_transaction)
                            # Restart once more while the original future row remains.
                            if index == 1:
                                self.close()
                                self.last_clocks.clear()
                        # A forward correction must not resurrect the original row
                        # as toggle state once its timestamp is in the past again.
                        corrected = max(start + timedelta(minutes=2), scan + timedelta(minutes=6))
                        with local_clock("America/Denver", corrected) as clock, \
                                mock.patch.dict(self.clock_namespace, {"datetime": clock}):
                            self.assertFalse(self.is_debounced(self.worker))
                            expected = "clock_out" if expected_actions[-1] == "clock_in" else "clock_in"
                            if seconds == 24 * 3600:
                                # The forward jump now exceeds the positive
                                # stale window, so a new shift starts normally.
                                expected = "clock_in"
                            self.assertEqual(self.manual()["action"], expected)

    def test_backward_clock_does_not_arm_in_memory_debounce_or_change_fixed_actions(self):
        start = datetime(2026, 10, 6, 14, tzinfo=timezone.utc)
        self.last_clocks[self.worker] = start
        with local_clock("America/Denver", start - timedelta(hours=1)) as clock, \
                mock.patch.dict(self.clock_namespace, {"datetime": clock}):
            self.assertFalse(self.is_debounced(self.worker))
        for mode, expected in (("entry", "clock_in"), ("exit", "clock_out")):
            with self.subTest(mode=mode):
                self.assert_inferred_action(start.isoformat(), (start - timedelta(hours=1)).isoformat(),
                                            expected, mode=mode)
        with local_clock("America/Denver", start - timedelta(hours=1)):
            self.assertEqual(self.manual(action="clock_in")["action"], "clock_in")
            self.assertEqual(self.manual(action="clock_out")["action"], "clock_out")

    def test_manual_payload_cannot_supply_the_inference_clock(self):
        start = datetime(2026, 10, 6, 14, tzinfo=timezone.utc)
        database.log_attendance(self.worker, "Synthetic worker", "clock_in", timestamp=start.isoformat())
        with local_clock("America/Denver", start + timedelta(hours=8)), app.app.test_client() as client:
            client.set_cookie(KIOSK_SUPERVISOR_SESSION_COOKIE, supervisor_session_token())
            response = client.post("/manual-clock", json={"worker_id": self.worker,
                                   "timestamp": "9999-12-31T23:59:59Z"},
                                   headers={"X-Kiosk-UI-Key": config.KIOSK_UI_KEY})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json["action"], "clock_out")
        self.assertEqual(database.get_unsynced_logs()[-1]["timestamp"], "2026-10-06T22:00:00+00:00")

    def test_unreadable_legacy_clock_in_does_not_establish_an_active_shift(self):
        self.assert_inferred_action("not-a-timestamp", "2026-10-06T06:00:00-06:00", "clock_in")


if __name__ == "__main__":
    unittest.main()
