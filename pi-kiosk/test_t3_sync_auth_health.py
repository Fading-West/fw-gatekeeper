"""Synthetic protected-response and public-health authorization regressions."""
import json
import sys
import types
import unittest
from unittest import mock

import sync
from sync_health import SyncAuthHealth


class SyncAuthHealthTests(unittest.TestCase):
    def setUp(self):
        self.tracker = SyncAuthHealth()
        patcher = mock.patch.object(sync, "sync_auth_health", self.tracker)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = mock.patch.object(sync, "_auth_headers", return_value={"x-kiosk-key": "synthetic-only"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_denials_clear_only_after_that_protected_phase_accepts(self):
        self.assertIsNone(self.tracker.snapshot()["sync_auth_ok"])
        self.tracker.observe("attendance", 401)
        self.tracker.observe("recognition", 403)
        self.tracker.observe("roster", 200)
        self.tracker.observe("attendance", 500)
        self.assertEqual(self.tracker.snapshot()["sync_auth_faults"], ["attendance", "recognition"])
        self.tracker.observe("attendance", 200)
        self.assertEqual(self.tracker.snapshot()["sync_auth_faults"], ["recognition"])
        self.tracker.observe("recognition", 200)
        self.assertTrue(self.tracker.snapshot()["sync_auth_ok"])

    def test_public_reachability_and_health_never_clear_denial(self):
        self.tracker.observe("attendance", 401)
        with mock.patch.object(sync.requests, "get", return_value=mock.Mock(status_code=200)):
            self.assertTrue(sync.check_server())
        reports = []
        sync.SyncWorker(health_reporter=lambda **fields: reports.append(fields))._report(sync_online=True)
        self.assertTrue(reports[-1]["sync_online"])
        self.assertFalse(reports[-1]["sync_auth_ok"])
        with mock.patch.dict(sys.modules, {"cv2": types.ModuleType("cv2")}):
            import app
        healthy_scanner = {**app.get_health_snapshot(), "camera_ok": True, "model_ok": True,
                           "degraded_reason": None, **reports[-1]}
        with mock.patch.object(app, "get_health_snapshot", return_value=healthy_scanner):
            health = app.app.test_client().get("/health").get_json()
        self.assertEqual(health["status"], "degraded")
        self.assertEqual(self.tracker.snapshot()["sync_auth_faults"], ["attendance"])

    def test_attendance_denial_retains_queue_without_quarantine_or_ack(self):
        with mock.patch.object(sync.requests, "post", return_value=mock.Mock(status_code=403)), \
             mock.patch.object(sync.database, "mark_synced") as acknowledged, \
             mock.patch.object(sync.database, "reject_attendance") as quarantined:
            self.assertFalse(sync._upload_attendance([1], [{"synthetic": True}], [1], sync.time.monotonic() + 60))
            acknowledged.assert_not_called()
            quarantined.assert_not_called()
        self.assertEqual(self.tracker.snapshot()["sync_auth_faults"], ["attendance"])

    def test_roster_download_and_ack_are_independent_protected_phases(self):
        with mock.patch.object(sync.database, "has_workers_missing_employee_id", return_value=False), \
             mock.patch.object(sync.database, "get_sync_state", return_value=None), \
             mock.patch.object(sync.requests, "get", return_value=mock.Mock(status_code=401)):
            self.assertFalse(sync.sync_workers())
        with mock.patch.object(sync.database, "get_sync_state", return_value=json.dumps({"receipt": "synthetic"})), \
             mock.patch.object(sync.database, "delete_sync_state") as clear_receipt, \
             mock.patch.object(sync.requests, "post", return_value=mock.Mock(status_code=403)):
            self.assertFalse(sync.acknowledge_applied_roster())
            clear_receipt.assert_not_called()
        self.assertEqual(self.tracker.snapshot()["sync_auth_faults"], ["roster", "roster_ack"])
        self.tracker.observe("roster", 200)
        self.assertEqual(self.tracker.snapshot()["sync_auth_faults"], ["roster_ack"])

    def test_recognition_denial_retains_queued_attempt(self):
        attempt = {"id": 1, "source_attempt_id": "synthetic-attempt"}
        with mock.patch.object(sync.database, "get_unsynced_recognition_attempts", return_value=[attempt]), \
             mock.patch.object(sync.database, "mark_recognition_attempts_synced") as acknowledged, \
             mock.patch.object(sync.requests, "post", return_value=mock.Mock(status_code=401, text="")):
            self.assertFalse(sync.sync_recognition_attempts())
            acknowledged.assert_not_called()
        self.assertEqual(self.tracker.snapshot()["sync_auth_faults"], ["recognition"])

    def test_loop_reports_fault_even_when_a_later_phase_raises(self):
        reports = []
        worker = sync.SyncWorker(health_reporter=lambda **fields: reports.append(fields))
        def deny_then_fail():
            self.tracker.observe("attendance", 401)
            worker._running = False
            raise RuntimeError("synthetic interrupted cycle")
        with mock.patch.object(sync.database, "count_unsynced_logs", return_value=1), \
             mock.patch.object(sync.database, "count_retryable_logs", return_value=1), \
             mock.patch.object(sync.database, "count_rejected_logs", return_value=0), \
             mock.patch.object(sync.database, "count_unsynced_recognition_attempts", return_value=0), \
             mock.patch.object(sync.database, "get_sync_state", return_value=None), \
             mock.patch.object(sync, "check_server", return_value=True), \
             mock.patch.object(sync, "sync_workers", return_value=True), \
             mock.patch.object(sync, "sync_attendance", side_effect=deny_then_fail):
            worker._running = True
            worker._run()
        self.assertFalse(reports[-1]["sync_auth_ok"])


if __name__ == "__main__":
    unittest.main()
