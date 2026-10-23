"""Real SQLite and Flask coverage for concurrent kiosk attendance writers."""

import ast
from datetime import datetime, timezone
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
from test_oct02_recognition_roster_race import Fixture


class AtomicClockActionTests(Fixture):
    def setUp(self):
        super().setUp()
        for name, value in {
            "KIOSK_TYPE": "auto",
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
            "recognizer": mock.Mock(liveness_policy=self.policy, known_count=1),
            "web_app": self.display, "logger": mock.Mock(), "last_clocks": self.last_clocks,
            "_log_recognition_attempt": mock.Mock(), "_now_iso": lambda: "synthetic-time",
            "base_degraded_reason": lambda: None,
        }
        exec(compile(ast.Module(body=[record], type_ignores=[]), "main.py", "exec"), namespace)
        self.record_clock = namespace["record_clock"]

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
        original_log, original_last = database.log_attendance, database.get_last_action

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
                    mock.patch.object(database, "get_last_action", side_effect=read_last_under_lock):
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


if __name__ == "__main__":
    unittest.main()
