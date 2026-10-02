"""Independent durable sync phases survive unrelated subsystem failures."""
import unittest
from unittest import mock

import test_sync_mapping as mapping
import database
import sync


class SyncIsolationTests(unittest.TestCase):
    setUp = mapping.AttendanceServerIdMappingTests.setUp

    def cycle(self, *, roster_error=None, reload_error=None, attendance_error=None, telemetry_error=None):
        recognizer = mock.Mock()
        recognizer.reload_faces.side_effect = reload_error
        reports = []
        worker = sync.SyncWorker(recognizer=recognizer, health_reporter=lambda **fields: reports.append(fields))
        worker._running = True
        def finish(_):
            worker._running = False
        with mock.patch.object(sync, "check_server", return_value=True), mock.patch.object(sync, "sync_workers", side_effect=roster_error, return_value=True) as roster, mock.patch.object(sync, "acknowledge_applied_roster", return_value=True) as ack, mock.patch.object(sync, "sync_attendance", side_effect=attendance_error, return_value=True) as attendance, mock.patch.object(sync, "sync_recognition_attempts", side_effect=telemetry_error, return_value=True) as telemetry, mock.patch.object(sync.time, "sleep", side_effect=finish):
            worker._run()
        return reports, roster, recognizer, ack, attendance, telemetry

    def test_roster_reload_failure_preserves_receipt_but_attempts_both_uploads(self):
        database.set_sync_state("roster_pending_receipt", "synthetic-receipt")
        reports, _, recognizer, ack, attendance, telemetry = self.cycle(reload_error=ValueError("synthetic roster corrupt"))
        recognizer.reload_faces.assert_called_once()
        ack.assert_not_called()
        attendance.assert_called_once()
        telemetry.assert_called_once()
        self.assertEqual(database.get_sync_state("roster_pending_receipt"), "synthetic-receipt")
        self.assertFalse(any("last_sync_at" in report for report in reports))

    def test_roster_exception_still_reloads_and_attempts_both_uploads(self):
        _, _, recognizer, ack, attendance, telemetry = self.cycle(roster_error=RuntimeError("synthetic download failure"))
        recognizer.reload_faces.assert_called_once()
        ack.assert_not_called()
        attendance.assert_called_once()
        telemetry.assert_called_once()

    def test_attendance_exception_does_not_starve_recognition(self):
        _, _, _, _, attendance, telemetry = self.cycle(attendance_error=RuntimeError("synthetic attendance storage failure"))
        attendance.assert_called_once()
        telemetry.assert_called_once()

    def test_all_phases_retry_after_faults_clear(self):
        self.cycle(roster_error=RuntimeError("roster"), attendance_error=RuntimeError("attendance"), telemetry_error=RuntimeError("telemetry"))
        database.set_sync_state("roster_pending_receipt", "synthetic-receipt")
        reports, roster, recognizer, ack, attendance, telemetry = self.cycle()
        for callback in (roster, recognizer.reload_faces, ack, attendance, telemetry):
            callback.assert_called_once()
        self.assertTrue(any("last_sync_at" in report for report in reports))


if __name__ == "__main__":
    unittest.main()
