"""Real SQLite coverage for offset-aware events alongside legacy local rows."""

import ast
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

import config
import database


@contextmanager
def local_clock(zone, instant):
    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            value = instant.astimezone(tz)
            return value if tz is not None else value.replace(tzinfo=None)

    try:
        with mock.patch.dict(os.environ, {"TZ": zone}):
            time.tzset()
            with mock.patch.object(database, "datetime", FrozenDatetime):
                yield FrozenDatetime
    finally:
        time.tzset()


class AttendanceTimezoneTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        patcher = mock.patch.object(config, "DB_PATH", str(Path(directory.name) / "test.db"))
        patcher.start()
        self.addCleanup(patcher.stop)
        database._local.conn = None
        self.addCleanup(self.close_database)
        database.init_db()

    @staticmethod
    def close_database():
        connection = getattr(database._local, "conn", None)
        if connection is not None:
            connection.close()
        database._local.conn = None

    def log(self, timestamp=None, action="clock_in", worker=1):
        return database.log_attendance(worker, "Alex", action, timestamp=timestamp)

    def test_default_writers_preserve_the_instant_in_any_device_timezone(self):
        instant = datetime(2026, 9, 29, 14, 0, tzinfo=timezone.utc)
        for zone in ("America/Denver", "America/Chicago", "UTC"):
            with self.subTest(zone=zone), local_clock(zone, instant) as clock:
                self.log()
                database.log_recognition_attempt(decision="unknown")
                # Exercise the camera telemetry clock without importing camera hardware.
                tree = ast.parse(Path(__file__).with_name("main.py").read_text())
                now_fn = next(node for node in tree.body
                              if isinstance(node, ast.FunctionDef) and node.name == "_now_iso")
                namespace = {"datetime": clock, "timezone": timezone}
                exec(compile(ast.Module(body=[now_fn], type_ignores=[]), "main.py", "exec"), namespace)
                timestamps = [database.get_unsynced_logs()[-1]["timestamp"],
                              database.get_unsynced_recognition_attempts()[-1]["timestamp"],
                              namespace["_now_iso"]()]
                self.assertEqual(timestamps, ["2026-09-29T14:00:00+00:00"] * 3)

    def test_mixed_legacy_and_offset_rows_use_instant_order_and_debounce(self):
        with local_clock("America/Denver", datetime(2026, 9, 29, 14, 2, tzinfo=timezone.utc)):
            self.log("2026-09-29T13:30:00+00:00", "clock_in")
            legacy_id = self.log("2026-09-29 08:00:00", "clock_out")
            self.assertEqual(database.get_last_action(1), "clock_out")
            self.assertTrue(database.was_recently_clocked(1, 3))
            self.assertFalse(database.was_recently_clocked(1, 1))
            current_id = self.log()
            self.assertEqual(database.get_last_action(1), "clock_in")
            self.assertEqual([row["id"] for row in database.get_today_logs(2)], [current_id, legacy_id])

    def test_utc_row_does_not_debounce_for_hours_after_its_actual_scan(self):
        with local_clock("America/Denver", datetime(2026, 9, 29, 14, 0, tzinfo=timezone.utc)):
            self.log("2026-09-29T13:00:00+00:00")
            self.assertFalse(database.was_recently_clocked(1, 5))

    def test_malformed_historical_rows_do_not_break_local_readers(self):
        with local_clock("America/Denver", datetime(2026, 9, 29, 14, 0, tzinfo=timezone.utc)):
            self.log("not-a-timestamp", "clock_out")
            self.log("2026-02-30T08:00:00", "clock_out")
            self.assertFalse(database.was_recently_clocked(1, 5))
            self.assertEqual(database.get_today_logs(), [])
            valid = self.log()
            self.assertTrue(database.was_recently_clocked(1, 5))
            self.assertEqual(database.get_last_action(1), "clock_in")
            self.assertEqual([row["id"] for row in database.get_today_logs()], [valid])

    def test_today_uses_device_local_midnights_for_both_timestamp_formats(self):
        with local_clock("America/Denver", datetime(2026, 9, 30, 5, 59, tzinfo=timezone.utc)):
            self.log("2026-09-29T05:59:59+00:00")  # previous local date
            start = self.log("2026-09-29T06:00:00+00:00")
            legacy = self.log("2026-09-29T23:57:00")
            current = self.log("2026-09-30T05:58:00+00:00")
            self.log("2026-09-30T06:00:00+00:00")  # next local date
            self.assertEqual([row["id"] for row in database.get_today_logs()], [current, legacy, start])

    def test_fall_back_repeated_hour_orders_and_debounces_by_actual_elapsed_time(self):
        with local_clock("America/Denver", datetime(2026, 11, 1, 8, 5, tzinfo=timezone.utc)):
            first = self.log("2026-11-01T01:55:00-06:00", "clock_in")
            self.assertFalse(database.was_recently_clocked(1, 5))
            self.assertTrue(database.was_recently_clocked(1, 15))
            second = self.log("2026-11-01T01:04:00-07:00", "clock_out")
            self.assertEqual(database.get_last_action(1), "clock_out")
            self.assertTrue(database.was_recently_clocked(1, 5))
            self.assertEqual([row["id"] for row in database.get_today_logs()], [second, first])

    def test_dst_local_days_include_all_23_or_25_hours(self):
        cases = [
            (datetime(2026, 3, 8, 12, tzinfo=timezone.utc), "2026-03-08T07:00:00+00:00", 23),
            (datetime(2026, 11, 1, 12, tzinfo=timezone.utc), "2026-11-01T06:00:00+00:00", 25),
        ]
        for now, start_string, hours in cases:
            with self.subTest(day=start_string), local_clock("America/Denver", now):
                start = datetime.fromisoformat(start_string)
                end = start + timedelta(hours=hours)
                self.log((start - timedelta(seconds=1)).isoformat())
                first = self.log(start.isoformat())
                last = self.log((end - timedelta(seconds=1)).isoformat())
                self.log(end.isoformat())
                self.assertEqual([row["id"] for row in database.get_today_logs()], [last, first])

    def test_restart_and_readers_do_not_rewrite_source_evidence_or_identity(self):
        with local_clock("America/Denver", datetime(2026, 9, 29, 14, 0, tzinfo=timezone.utc)):
            self.log("2026-09-29T07:59:00.123456")
            self.log()
            database.log_recognition_attempt(decision="unknown", timestamp="2026-09-29T07:59:00")
            database.log_recognition_attempt(decision="unknown")
            events = database.get_unsynced_logs()
            attempts = database.get_unsynced_recognition_attempts()
            self.close_database()
            database.init_db()
            database.get_today_logs()
            database.get_last_action(1)
            database.was_recently_clocked(1, 5)
            self.assertEqual(database.get_unsynced_logs(), events)
            self.assertEqual(database.get_unsynced_recognition_attempts(), attempts)


if __name__ == "__main__":
    unittest.main()
