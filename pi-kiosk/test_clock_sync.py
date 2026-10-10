"""Clock probes and the shared local-health/heartbeat boundary use OS mocks."""

import subprocess
import unittest
from unittest import mock

import clock_sync


class ClockSyncTests(unittest.TestCase):
    def setUp(self):
        clock_sync._checked_at = None
        clock_sync._cached_status = None
        self.runtime = mock.patch.object(clock_sync, "SYSTEMD_RUNTIME").start()
        self.runtime.is_dir.return_value = True
        self.marker = mock.patch.object(clock_sync, "SYNC_MARKER").start()
        self.marker.is_file.return_value = False
        self.run = mock.patch.object(clock_sync.subprocess, "run").start()
        self.addCleanup(mock.patch.stopall)

    def test_parses_only_explicit_successful_sync_status(self):
        for value, expected in [("yes\n", True), (" no \n", False),
                                ("TRUE", True), ("false", False),
                                ("", None), ("n/a", None)]:
            with self.subTest(value=value):
                clock_sync._checked_at = None
                self.run.return_value = subprocess.CompletedProcess([], 0, value)
                self.assertIs(clock_sync.get_clock_synchronized(), expected)
        self.assertEqual(self.run.call_args.args[0],
                         ["timedatectl", "show", "-p", "NTPSynchronized", "--value"])
        self.assertEqual(self.run.call_args.kwargs["timeout"], 0.5)

    def test_fallback_for_missing_command_timeout_and_failed_or_unparseable_output(self):
        for failure in [FileNotFoundError(), subprocess.TimeoutExpired("timedatectl", 0.5),
                        subprocess.CompletedProcess([], 1, "no"),
                        subprocess.CompletedProcess([], 0, "unknown")]:
            for marker_present in [False, True]:
                with self.subTest(failure=failure, marker_present=marker_present):
                    clock_sync._checked_at = None
                    self.run.side_effect = failure if isinstance(failure, Exception) else None
                    self.run.return_value = failure
                    self.marker.is_file.return_value = marker_present
                    self.assertIs(clock_sync.get_clock_synchronized(), True if marker_present else None)

    def test_explicit_unsynchronized_result_wins_over_old_marker(self):
        self.marker.is_file.return_value = True
        self.run.return_value = subprocess.CompletedProcess([], 0, "no")
        self.assertIs(clock_sync.get_clock_synchronized(), False)
        self.marker.is_file.assert_not_called()

    def test_non_systemd_hosts_remain_unknown_without_subprocess_or_marker(self):
        self.runtime.is_dir.return_value = False
        self.marker.is_file.return_value = True
        self.assertIsNone(clock_sync.get_clock_synchronized())
        self.run.assert_not_called()
        self.marker.is_file.assert_not_called()

    def test_filesystem_errors_never_escape(self):
        for path_mock, method in [(self.runtime, "is_dir"), (self.marker, "is_file")]:
            with self.subTest(method=method):
                clock_sync._checked_at = None
                self.run.side_effect = FileNotFoundError()
                getattr(path_mock, method).side_effect = PermissionError()
                self.assertIsNone(clock_sync.get_clock_synchronized())
                getattr(path_mock, method).side_effect = None

    def test_cache_refreshes_against_monotonic_time_including_unknown(self):
        for initial_output, initial_status in [("no", False), ("unknown", None)]:
            with self.subTest(initial_output=initial_output):
                clock_sync._checked_at = None
                self.run.reset_mock()
                self.run.return_value = subprocess.CompletedProcess([], 0, initial_output)
                with mock.patch.object(clock_sync.time, "monotonic", return_value=100):
                    self.assertIs(clock_sync.get_clock_synchronized(), initial_status)
                self.run.return_value = subprocess.CompletedProcess([], 0, "yes")
                with mock.patch.object(clock_sync.time, "monotonic", return_value=129.9):
                    self.assertIs(clock_sync.get_clock_synchronized(), initial_status)
                self.assertEqual(self.run.call_count, 1)
                with mock.patch.object(clock_sync.time, "monotonic", return_value=130):
                    self.assertIs(clock_sync.get_clock_synchronized(), True)
                self.assertEqual(self.run.call_count, 2)


class ClockHealthTests(unittest.TestCase):
    def setUp(self):
        import app
        self.app = app
        patcher = mock.patch.dict(app._health, camera_ok=True, model_ok=True, degraded_reason=None)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = app.app.test_client()

    def test_unsynchronized_clock_degrades_health_and_heartbeat(self):
        import sync
        with mock.patch.object(self.app, "get_clock_synchronized", return_value=False):
            health = self.client.get("/health").get_json()
            self.assertEqual(health["status"], "degraded")
            self.assertEqual(health["degraded_reason"], "clock_unsynchronized")
            self.assertIs(health["clock_synchronized"], False)
            self.assertEqual(sync._health_params(self.app.get_health_snapshot())["degraded_reason"],
                             "clock_unsynchronized")
            with mock.patch.object(sync.database, "has_workers_missing_employee_id", return_value=False), \
                 mock.patch.object(sync.database, "get_sync_state", return_value=None), \
                 mock.patch.object(sync, "_auth_headers", return_value={}), \
                 mock.patch.object(sync.requests, "get", return_value=mock.Mock(status_code=503)) as request:
                self.assertFalse(sync.sync_workers(health=self.app.get_health_snapshot()))
                self.assertEqual(request.call_args.kwargs["params"]["degraded_reason"],
                                 "clock_unsynchronized")
            with mock.patch.object(self.app.database, "list_workers", return_value=[]):
                self.assertEqual(self.app.get_status_snapshot()["health"]["degraded_reason"],
                                 "clock_unsynchronized")

    def test_unknown_and_synchronized_clocks_do_not_degrade(self):
        import sync
        for status in [None, True]:
            with self.subTest(status=status), mock.patch.object(self.app, "get_clock_synchronized", return_value=status):
                health = self.client.get("/health").get_json()
                self.assertEqual(health["status"], "ok")
                self.assertIsNone(health["degraded_reason"])
                self.assertNotIn("degraded_reason", sync._health_params(self.app.get_health_snapshot()))

    def test_clock_recovery_restores_underlying_degradation(self):
        self.app.update_health(degraded_reason="no_workers_synced")
        with mock.patch.object(self.app, "get_clock_synchronized", side_effect=[False, True]):
            self.assertEqual(self.app.get_health_snapshot()["degraded_reason"], "clock_unsynchronized")
            self.assertEqual(self.app.get_health_snapshot()["degraded_reason"], "no_workers_synced")

    def test_unsynchronized_clock_keeps_supervisor_attendance_available(self):
        from kiosk_ui_auth import KIOSK_SUPERVISOR_SESSION_COOKIE, supervisor_session_token
        worker = {"id": 1, "name": "Synthetic Worker", "employee_id": "TEST-1", "server_id": "a" * 32}
        with mock.patch.object(self.app.config, "KIOSK_UI_KEY", "test-only", create=True), \
             mock.patch.object(self.app.config, "KIOSK_SUPERVISOR_PIN", "test-only", create=True), \
             mock.patch.object(self.app, "get_clock_synchronized", return_value=False), \
             mock.patch.object(self.app.database, "get_worker_by_id", return_value=worker), \
             mock.patch.object(self.app.database, "log_attendance", return_value=123) as record, \
             mock.patch.object(self.app, "update_status"):
            self.assertEqual(self.app.get_health_snapshot()["degraded_reason"], "clock_unsynchronized")
            self.client.set_cookie(KIOSK_SUPERVISOR_SESSION_COOKIE, supervisor_session_token())
            response = self.client.post('/manual-clock', headers={"X-Kiosk-UI-Key": "test-only"},
                                        json={"worker_id": 1, "action": "clock_in"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["log_id"], 123)
            record.assert_called_once()


if __name__ == "__main__":
    unittest.main()
