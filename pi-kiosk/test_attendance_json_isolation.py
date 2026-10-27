"""Unencodable persisted attendance must not block later valid punches."""
import json
import unittest
from unittest import mock

import requests

import database
import sync
import test_sync_mapping as mapping
from test_sync_mapping import ENCODING, SERVER_ID


class AttendanceJsonIsolationTests(unittest.TestCase):
    setUp = mapping.AttendanceServerIdMappingTests.setUp
    _close_db = staticmethod(mapping.AttendanceServerIdMappingTests._close_db)

    def enqueue(self, confidence, index=0):
        worker = database.add_worker("Alex", ENCODING, server_id=SERVER_ID)
        return database.log_attendance(
            worker, "Alex", "clock_in", confidence=confidence,
            timestamp=f"2026-10-25T08:{index // 60:02}:{index % 60:02}+00:00",
        )

    @staticmethod
    def accept_encoded_request(*args, **kwargs):
        # Exercise Requests' real finite-JSON check without any network traffic.
        requests.Request("POST", "https://synthetic.invalid", json=kwargs["json"]).prepare()
        return mock.Mock(status_code=200, json=lambda: {
            "acknowledged": len(kwargs["json"]["logs"]),
        })

    def test_infinite_confidence_is_retained_while_later_pages_drain(self):
        bad = self.enqueue(float("inf"))
        for index in range(1, 121):
            self.enqueue(.95, index)
        conn = database._get_conn()
        original = dict(conn.execute("SELECT * FROM attendance_log WHERE id = ?", (bad,)).fetchone())
        with mock.patch.object(sync.requests, "post", side_effect=self.accept_encoded_request) as post:
            for _ in range(3):
                self.assertFalse(sync.sync_attendance())  # retained quarantine still counts
        self.assertEqual(database.count_retryable_logs(), 0)
        self.assertEqual(database.count_rejected_logs(), 1)
        self.assertEqual(database.count_unsynced_logs(), 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM attendance_log WHERE synced = 1").fetchone()[0], 120)
        self.assertEqual(dict(conn.execute("SELECT * FROM attendance_log WHERE id = ?", (bad,)).fetchone()), original)
        rejection = database.list_attendance_rejections()[0]
        self.assertEqual(json.loads(rejection["original_log_json"]), original)
        self.assertIn("finite JSON", rejection["reason"])
        self.assertLess(post.call_count, 32)

    def test_negative_infinity_survives_restart_and_audited_repair(self):
        bad = self.enqueue(float("-inf"))
        self.enqueue(.95, 1)
        with mock.patch.object(sync.requests, "post", side_effect=self.accept_encoded_request):
            self.assertFalse(sync.sync_attendance())
        self._close_db()
        database.init_db()
        rejections = database.list_attendance_rejections()
        self.assertEqual(len(rejections), 1)
        rejection = rejections[0]
        original_snapshot = rejection["original_log_json"]
        conn = database._get_conn()
        conn.execute("UPDATE attendance_log SET confidence = .95 WHERE id = ?", (bad,))
        conn.commit()
        database.retry_attendance_rejection(rejection["id"], "Repaired nonfinite confidence after review")
        with mock.patch.object(sync.requests, "post", side_effect=self.accept_encoded_request):
            self.assertTrue(sync.sync_attendance())
        self.assertEqual(database.count_unsynced_logs(), 0)
        audit = conn.execute("SELECT * FROM attendance_rejections WHERE id = ?", (rejection["id"],)).fetchone()
        self.assertEqual(audit["original_log_json"], original_snapshot)
        self.assertIsNotNone(audit["released_at"])
        self.assertIn("after review", audit["release_note"])

    def test_isolation_respects_request_budget_and_retries_unresolved_rows(self):
        for index in range(12):
            self.enqueue(float("inf") if index < 8 else .95, index)
        with mock.patch.object(sync, "ATTENDANCE_REQUESTS_PER_CYCLE", 3), \
             mock.patch.object(sync.requests, "post", side_effect=self.accept_encoded_request) as post:
            self.assertFalse(sync.sync_attendance())
            self.assertLessEqual(post.call_count, 3)
        self.assertGreater(database.count_retryable_logs(), 0)
        with mock.patch.object(sync.requests, "post", side_effect=self.accept_encoded_request):
            for _ in range(3):
                sync.sync_attendance()
        self.assertEqual(database.count_retryable_logs(), 0)
        self.assertEqual(database.count_rejected_logs(), 8)
        self.assertEqual(database._get_conn().execute("SELECT COUNT(*) FROM attendance_log WHERE synced = 1").fetchone()[0], 4)

    def test_expired_deadline_retains_evidence_without_quarantine(self):
        self.enqueue(float("inf"))
        rows = database.get_unsynced_logs()
        with mock.patch.object(sync.time, "monotonic", return_value=10), \
             mock.patch.object(sync.requests, "post") as post:
            self.assertFalse(sync._upload_attendance([rows[0]["id"]], [{"confidence": float("inf")}], [64], 10))
        post.assert_not_called()
        self.assertEqual(database.count_rejected_logs(), 0)
        self.assertEqual(database.count_retryable_logs(), 1)


if __name__ == "__main__":
    unittest.main()
