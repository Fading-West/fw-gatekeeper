"""Synthetic SQLite/Flask regressions for durable manual clock operations."""
import concurrent.futures
import sys
import types
import unittest
from unittest import mock

import test_sync_mapping as mapping
from test_sync_mapping import ENCODING, SERVER_ID
import config
import database


class ManualAttendanceTests(unittest.TestCase):
    setUp = mapping.AttendanceServerIdMappingTests.setUp

    def worker(self):
        return database.add_worker("Synthetic", ENCODING, server_id=SERVER_ID)

    def test_lost_response_replay_survives_restart_and_worker_removal(self):
        worker = self.worker()
        args = {"request_id": "operation-one", "worker_id": worker}
        with mock.patch.object(config, "KIOSK_TYPE", "auto"):
            first = database.record_manual_attendance(**args)
            database.remove_worker_by_server_id(SERVER_ID)
            mapping.AttendanceServerIdMappingTests._close_db()
            database.init_db()
            self.assertEqual(database.record_manual_attendance(**args), first)
        self.assertEqual(database.count_unsynced_logs(), 1)

    def test_distinct_intent_toggles_but_duplicate_intent_does_not(self):
        worker = self.worker()
        with mock.patch.object(config, "KIOSK_TYPE", "auto"):
            first = database.record_manual_attendance(request_id="one", worker_id=worker)
            self.assertEqual(database.record_manual_attendance(request_id="one", worker_id=worker), first)
            second = database.record_manual_attendance(request_id="two", worker_id=worker)
            third = database.record_manual_attendance(request_id="three", worker_id=worker)
        self.assertEqual([first["action"], second["action"], third["action"]], ["clock_in", "clock_out", "clock_in"])
        self.assertEqual(database.count_unsynced_logs(), 3)

    def test_concurrent_duplicate_records_once(self):
        worker = self.worker()
        def submit(_):
            try:
                return database.record_manual_attendance(request_id="concurrent", worker_id=worker)
            finally:
                mapping.AttendanceServerIdMappingTests._close_db()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(database.count_unsynced_logs(), 1)

    def test_reused_identity_conflicts_and_removed_worker_cannot_record(self):
        worker = self.worker()
        database.record_manual_attendance(request_id="one", worker_id=worker, action="clock_in")
        with self.assertRaises(ValueError):
            database.record_manual_attendance(request_id="one", worker_id=worker, action="clock_out")
        database.remove_worker_by_server_id(SERVER_ID)
        with self.assertRaises(LookupError):
            database.record_manual_attendance(request_id="two", worker_id=worker)
        self.assertEqual(database.count_unsynced_logs(), 1)

    def test_receipt_failure_rolls_back_attendance_and_retry_succeeds(self):
        worker = self.worker()
        conn = database._get_conn()
        conn.execute("CREATE TRIGGER receipt_failure BEFORE INSERT ON manual_attendance_receipts BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
        with self.assertRaises(Exception):
            database.record_manual_attendance(request_id="one", worker_id=worker)
        self.assertEqual(database.count_unsynced_logs(), 0)
        conn.execute("DROP TRIGGER receipt_failure")
        database.record_manual_attendance(request_id="one", worker_id=worker)
        self.assertEqual(database.count_unsynced_logs(), 1)

    def test_route_validates_payload_and_keeps_operation_replay(self):
        with mock.patch.dict(sys.modules, {"cv2": types.ModuleType("cv2")}):
            import app
        with mock.patch.object(config, "KIOSK_UI_KEY", "synthetic-ui", create=True), mock.patch.object(config, "KIOSK_SUPERVISOR_PIN", "synthetic-pin", create=True):
            from kiosk_ui_auth import KIOSK_SUPERVISOR_SESSION_COOKIE, supervisor_session_token
            client = app.app.test_client()
            client.set_cookie(KIOSK_SUPERVISOR_SESSION_COOKIE, supervisor_session_token())
            headers = {"X-Kiosk-UI-Key": "synthetic-ui"}
            worker = self.worker()
            args = {"worker_id": worker, "request_id": "route-operation"}
            first = client.post("/manual-clock", json=args, headers=headers)
            self.assertEqual(first.status_code, 200)
            self.assertEqual(client.post("/manual-clock", json=args, headers=headers).json, first.json)
            for invalid in ([1], {"worker_id": worker, "action": []}, {"worker_id": True}, {"worker_id": worker, "request_id": ""}):
                self.assertEqual(client.post("/manual-clock", json=invalid, headers=headers).status_code, 400)
            client.delete_cookie(KIOSK_SUPERVISOR_SESSION_COOKIE)
            self.assertEqual(client.post("/manual-clock", json=args, headers=headers).status_code, 401)


if __name__ == "__main__":
    unittest.main()
