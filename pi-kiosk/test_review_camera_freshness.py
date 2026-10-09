"""Exercise the production write and pending-verification expiry boundaries."""
import ast
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

from scan_freshness import is_fresh_scan

SOURCE = ast.parse(Path(__file__).with_name("main.py").read_text())
RUN = next(node for node in SOURCE.body if isinstance(node, ast.FunctionDef) and node.name == "run")


class FreshnessBoundaryTests(unittest.TestCase):
    def test_slow_work_cannot_write_an_expired_scan(self):
        writer = next(node for node in RUN.body if isinstance(node, ast.FunctionDef) and node.name == "record_clock")
        policy = mock.Mock()
        context = {"is_fresh_scan": is_fresh_scan, "time": SimpleNamespace(time=lambda: 106.0),
                   "camera_invalidated_at": [0.0], "recognizer": SimpleNamespace(liveness_policy=policy, known_count=1),
                   "config": SimpleNamespace(KIOSK_TYPE="entry"), "database": mock.Mock(),
                   "last_clocks": {}, "datetime": datetime, "timezone": timezone, "web_app": mock.Mock(),
                   "base_degraded_reason": lambda: None, "_now_iso": lambda: "synthetic-time",
                   "_log_recognition_attempt": mock.Mock(), "logger": mock.Mock()}
        exec(compile(ast.Module(body=[writer], type_ignores=[]), "production-write", "exec"), context)
        result = {"frame_ts": 100.0}
        # It was fresh when consumption began, before expensive blink work.
        self.assertTrue(is_fresh_scan(result, 104.0))
        self.assertFalse(context["record_clock"](result, 1, "Synthetic worker", "1", .9, True))
        policy.record.assert_not_called()

    def test_expired_pending_attempt_cannot_accept_late_post_blink_result(self):
        branch = next(node for node in ast.walk(RUN) if isinstance(node, ast.If)
                      and ast.unparse(node.test) == "pending is not None")
        pending = {"deadline": 100.0, "result": {"frame_ts": 99.0}, "blink_confirmed": True,
                   "blink_confirmed_at": 99.0, "worker_id": 1, "server_worker_id": "synthetic",
                   "post_blink_confirmed": False, "display_name": "Synthetic worker", "display_id": "1", "confidence": .9}
        recorder = mock.Mock()
        context = {"pending": pending, "pending_clock": [pending], "now": 101.0,
                   "current_result": [{"frame_ts": 100.5, "name": "Synthetic worker",
                                       "candidate_worker_id": 1, "server_worker_id": "synthetic"}],
                   "liveness": mock.Mock(), "web_app": mock.Mock(), "record_clock": recorder,
                   "recognizer": SimpleNamespace(known_count=1), "_log_recognition_attempt": mock.Mock(),
                   "config": SimpleNamespace(DISPLAY_TIME_SUCCESS_SEC=3), "display_until": [0.0],
                   "is_fresh_scan": is_fresh_scan, "camera_invalidated_at": [0.0]}
        wrapper = ast.Module(body=[ast.For(target=ast.Name(id="_once", ctx=ast.Store()),
            iter=ast.List(elts=[ast.Constant(value=0)], ctx=ast.Load()), body=[branch], orelse=[])], type_ignores=[])
        exec(compile(ast.fix_missing_locations(wrapper), "production-pending", "exec"), context)
        self.assertIsNone(context["pending_clock"][0])
        self.assertIsNone(context["current_result"][0])
        recorder.assert_not_called()
        context["liveness"].reset.assert_called_once()
        context["_log_recognition_attempt"].assert_called_once_with(pending["result"], "rejected_liveness_timeout")


if __name__ == "__main__":
    unittest.main()
