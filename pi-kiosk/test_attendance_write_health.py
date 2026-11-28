"""Synthetic SQLite/Flask regressions for the attendance-write trust fault."""
import sqlite3
import sys
import threading
import types
import unittest
from unittest import mock

import test_sync_mapping as mapping
from test_sync_mapping import ENCODING, SERVER_ID
import attendance_write_health as write_health
import config
import database
import sync

with mock.patch.dict(sys.modules, {"cv2": types.ModuleType("cv2")}):
    import app

REASON = write_health.REASON


class _CommitFails:
    """Delegate to a real connection, failing only its commit."""

    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def commit(self):
        raise sqlite3.OperationalError("disk I/O error")


class AttendanceWriteHealthTests(unittest.TestCase):
    setUp_db = mapping.AttendanceServerIdMappingTests.setUp
    _close_db = staticmethod(mapping.AttendanceServerIdMappingTests._close_db)

    def setUp(self):
        self.setUp_db()
        write_health.reset_for_tests()
        self.addCleanup(write_health.reset_for_tests)
        self.worker = database.add_worker("Synthetic", ENCODING, server_id=SERVER_ID)
        for name, value in (("KIOSK_TYPE", "auto"),):
            patcher = mock.patch.object(config, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def failed(self):
        return write_health.snapshot()["failed"]

    def trigger(self, table):
        database._get_conn().execute(
            f"CREATE TRIGGER fail_{table} BEFORE INSERT ON {table} BEGIN SELECT RAISE(ABORT, 'synthetic'); END")
        return lambda: database._get_conn().execute(f"DROP TRIGGER fail_{table}")

    def recognized(self, **overrides):
        args = {"worker_id": self.worker, "server_worker_id": SERVER_ID, "expected_encoding": ENCODING,
                "worker_name": "Synthetic", "confidence": 0.9}
        return database.log_recognized_attendance(**{**args, **overrides})

    def manual(self, request_id, **overrides):
        return database.record_manual_attendance(request_id=request_id, **{"worker_id": self.worker, **overrides})

    def test_insert_failure_is_reported_until_a_new_recognized_punch_commits(self):
        drop = self.trigger("attendance_log")
        with self.assertRaises(sqlite3.Error):
            self.recognized()
        self.assertTrue(self.failed())
        self.assertEqual(database.count_unsynced_logs(), 0)
        drop()
        self.recognized()
        self.assertFalse(self.failed())
        self.assertEqual(database.count_unsynced_logs(), 1)

    def test_direct_insert_owner_publishes_its_own_outcome(self):
        drop = self.trigger("attendance_log")
        with self.assertRaises(sqlite3.Error):
            database.log_attendance(self.worker, "Synthetic", action="clock_in")
        self.assertTrue(self.failed())
        drop()
        database.log_attendance(self.worker, "Synthetic", action="clock_in")
        self.assertFalse(self.failed())

    def test_receipt_failure_rolls_back_and_nested_insert_success_does_not_clear(self):
        write_health.mark_failed(sqlite3.OperationalError("earlier"))
        drop = self.trigger("manual_attendance_receipts")
        with self.assertRaises(sqlite3.Error):
            self.manual("receipt-fails")
        self.assertTrue(self.failed())
        self.assertEqual(database.count_unsynced_logs(), 0)
        # A non-storage failure after the nested insert neither clears nor sets.
        drop()
        with mock.patch.object(database, "get_attendance_action", side_effect=ValueError("synthetic")):
            with self.assertRaises(ValueError):
                self.manual("after-insert")
        self.assertTrue(self.failed())
        self.assertEqual(database.count_unsynced_logs(), 0)
        self.manual("receipt-fails")
        self.assertFalse(self.failed())

    def test_receipt_replay_does_not_clear(self):
        first = self.manual("replayed")
        write_health.mark_failed(sqlite3.OperationalError("later failure"))
        self.assertEqual(self.manual("replayed"), first)
        self.assertTrue(self.failed())
        self.assertEqual(database.count_unsynced_logs(), 1)

    def test_commit_failure_marks_fault_and_rolls_back(self):
        real = database._get_conn()
        database._local.conn = _CommitFails(real)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                self.recognized()
        finally:
            database._local.conn = real
        self.assertTrue(self.failed())
        self.assertFalse(real.in_transaction)
        self.assertEqual(database.count_unsynced_logs(), 0)

    def test_begin_and_connection_failures_mark_fault(self):
        self._close_db()
        database._get_conn(timeout=0.05)
        blocker = sqlite3.connect(config.DB_PATH)
        blocker.execute("BEGIN IMMEDIATE")
        try:
            with self.assertRaises(sqlite3.OperationalError):
                self.manual("busy")
        finally:
            blocker.rollback()
            blocker.close()
        self.assertTrue(self.failed())
        self.manual("busy")
        self.assertFalse(self.failed())
        self._close_db()
        with mock.patch.object(database.sqlite3, "connect", side_effect=sqlite3.OperationalError("unable to open")):
            with self.assertRaises(sqlite3.OperationalError):
                self.recognized()
        self.assertTrue(self.failed())

    def test_validation_identity_policy_and_telemetry_failures_are_excluded(self):
        with self.assertRaises(LookupError):
            self.manual("unknown", worker_id=self.worker + 99)
        with self.assertRaises(ValueError):
            self.recognized(expected_encoding=ENCODING * 2)
        with self.assertRaises(database.ManualAttendancePolicyError):
            self.manual("policy", action_for_worker=mock.Mock(side_effect=ValueError("bad policy")))
        self.manual("reused", action="clock_in")
        with self.assertRaises(ValueError):
            self.manual("reused", action="clock_out")
        drop = self.trigger("recognition_attempts")
        with self.assertRaises(sqlite3.Error):
            database.log_recognition_attempt(decision="rejected_unknown")
        drop()
        self.assertFalse(self.failed())
        # ...and none of them clears an existing fault.
        write_health.mark_failed(sqlite3.OperationalError("earlier"))
        with self.assertRaises(LookupError):
            self.manual("unknown-again", worker_id=self.worker + 99)
        with self.assertRaises(ValueError):
            self.recognized(expected_encoding=ENCODING * 2)
        self.assertTrue(self.failed())

    def test_publication_happens_with_completion_under_one_lock(self):
        real = database._get_conn()
        observed = []

        class _Observe(_CommitFails):
            def commit(self):
                observed.append(write_health._lock.locked())
                return self._conn.commit()

            def rollback(self):
                observed.append(write_health._lock.locked())
                return self._conn.rollback()

        database._local.conn = _Observe(real)
        drop = None
        try:
            self.recognized()
            with self.assertRaises(ValueError):
                self.recognized(expected_encoding=None)
            # A failing nested insert must not be rolled back (by the write
            # decorator) before its owner can publish under the same lock.
            drop = self.trigger("attendance_log")
            with self.assertRaises(sqlite3.Error):
                self.recognized()
            with self.assertRaises(sqlite3.Error):
                self.manual("nested-insert-fails")
        finally:
            database._local.conn = real
        if drop:
            drop()
        self.assertEqual(observed, [True, True, True, True])
        self.assertTrue(self.failed())

    def test_failure_completing_before_a_pending_punch_commit_is_cleared_by_that_commit(self):
        """Outcomes follow transaction completion: a punch that commits after a
        concurrent failure clears it, whatever order the threads started in."""
        inserted, release = threading.Event(), threading.Event()
        real_infer = database._infer_clock_action

        def pause(*args):
            inserted.set()
            release.wait(5)
            return real_infer(*args)

        errors = []

        def slow_punch():
            try:
                with mock.patch.object(database, "_infer_clock_action", side_effect=pause):
                    self.recognized()
            except Exception as exc:  # pragma: no cover - surfaced below
                errors.append(exc)
            finally:
                self._close_db()

        self._close_db()
        thread = threading.Thread(target=slow_punch)
        thread.start()
        self.assertTrue(inserted.wait(5))
        database._get_conn(timeout=0.05)
        with self.assertRaises(sqlite3.OperationalError):
            self.manual("blocked-by-pending-punch")
        self.assertTrue(self.failed())
        release.set()
        thread.join(5)
        self.assertEqual(errors, [])
        self.assertFalse(self.failed())


class HealthCompositionTests(unittest.TestCase):
    def setUp(self):
        write_health.reset_for_tests()
        self.addCleanup(write_health.reset_for_tests)
        saved = dict(app._health)
        self.addCleanup(lambda: (app._health.clear(), app._health.update(saved)))
        self.clock = mock.patch.object(app, "get_clock_synchronized", return_value=False)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def test_write_reason_composes_with_device_clock_and_policy_and_recovers_alone(self):
        app.update_health(camera_ok=True, model_ok=True, degraded_reason="no_workers_synced")
        write_health.mark_failed(sqlite3.OperationalError("disk I/O error"))
        snapshot = app.get_health_snapshot()
        self.assertEqual(snapshot["degraded_reason"], f"no_workers_synced,clock_unsynchronized,{REASON}")
        self.assertFalse(snapshot["attendance_write_ok"])
        self.assertTrue(snapshot["attendance_write_failed_at"])
        # A device writer replacing degraded_reason cannot erase the write fault.
        app.update_health(degraded_reason=None)
        self.assertEqual(app.get_health_snapshot()["degraded_reason"], f"clock_unsynchronized,{REASON}")
        invalid = types.SimpleNamespace(valid=False, errors=["KIOSK_TYPE invalid"])
        with mock.patch.object(app, "validate_kiosk_policy", return_value=invalid):
            self.assertEqual(app.get_health_snapshot()["degraded_reason"],
                             f"kiosk_policy_error,clock_unsynchronized,{REASON}")
            # Device, policy, clock and write reasons all compose; recovery drops only the write reason.
            app.update_health(degraded_reason="no_workers_synced")
            self.assertEqual(app.get_health_snapshot()["degraded_reason"],
                             f"no_workers_synced,kiosk_policy_error,clock_unsynchronized,{REASON}")
            with write_health.completing():
                write_health.mark_committed_locked()
            self.assertEqual(app.get_health_snapshot()["degraded_reason"],
                             "no_workers_synced,kiosk_policy_error,clock_unsynchronized")
            write_health.mark_failed(sqlite3.OperationalError("disk I/O error"))
            app.update_health(degraded_reason=None)
        params = sync._health_params({**app.get_health_snapshot(), "rejected_logs": 1})
        self.assertEqual(params["degraded_reason"],
                         f"clock_unsynchronized,{REASON}; upload_quarantine: 1 attendance, 0 recognition")
        app.update_health(degraded_reason="no_workers_synced")
        with write_health.completing():
            write_health.mark_committed_locked()
        snapshot = app.get_health_snapshot()
        self.assertEqual(snapshot["degraded_reason"], "no_workers_synced,clock_unsynchronized")
        self.assertTrue(snapshot["attendance_write_ok"])

    def test_health_endpoint_reports_degraded_and_restart_state_starts_clear(self):
        self.clock.stop()
        with mock.patch.object(app, "get_clock_synchronized", return_value=True):
            app.update_health(camera_ok=True, model_ok=True, degraded_reason=None,
                              rejected_logs=0, rejected_attempts=0, sync_auth_ok=None)
            client = app.app.test_client()
            self.assertEqual(client.get("/health").get_json()["status"], "ok")
            write_health.mark_failed(sqlite3.OperationalError("disk I/O error"))
            body = client.get("/health").get_json()
            self.assertEqual((body["status"], body["degraded_reason"]), ("degraded", REASON))
        self.clock.start()
        # Process-local: a fresh process (module state) has no observation.
        self.assertEqual(write_health.REASON, REASON)
        write_health.reset_for_tests()
        self.assertFalse(write_health.snapshot()["failed"])


class ManualRouteTests(unittest.TestCase):
    setUp = AttendanceWriteHealthTests.setUp
    setUp_db = AttendanceWriteHealthTests.setUp_db
    _close_db = staticmethod(mapping.AttendanceServerIdMappingTests._close_db)

    def test_route_storage_failure_reports_fault_and_next_punch_clears(self):
        with mock.patch.object(config, "KIOSK_UI_KEY", "synthetic-ui", create=True), \
                mock.patch.object(config, "KIOSK_SUPERVISOR_PIN", "synthetic-pin", create=True), \
                mock.patch.object(app, "get_clock_synchronized", return_value=True):
            client = app.app.test_client()
            headers = {"X-Kiosk-UI-Key": "synthetic-ui"}
            boot_nonce = client.get("/health").get_json().get("supervisor_boot_nonce")
            self.assertEqual(client.post("/supervisor/unlock", json={"pin": "synthetic-pin", "boot_nonce": boot_nonce},
                                         headers=headers).status_code, 200)
            database._get_conn().execute(
                "CREATE TRIGGER fail_log BEFORE INSERT ON attendance_log BEGIN SELECT RAISE(ABORT, 'synthetic'); END")
            args = {"worker_id": self.worker, "request_id": "route-write"}
            self.assertEqual(client.post("/manual-clock", json=args, headers=headers).status_code, 503)
            self.assertIn(REASON, client.get("/health").get_json()["degraded_reason"].split(","))
            database._get_conn().execute("DROP TRIGGER fail_log")
            self.assertEqual(client.post("/manual-clock", json=args, headers=headers).status_code, 200)
            self.assertNotIn(REASON, (client.get("/health").get_json()["degraded_reason"] or "").split(","))


if __name__ == "__main__":
    unittest.main()
