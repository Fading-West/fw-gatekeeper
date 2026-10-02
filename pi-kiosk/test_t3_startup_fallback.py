"""Synthetic asynchronous model recovery and real startup ordering coverage."""
import ast
import logging
import threading
import types
import unittest
from pathlib import Path
from unittest import mock

from model_recovery import ModelRecovery


class ModelRecoveryTests(unittest.TestCase):
    def test_blocked_loader_does_not_block_start_and_starts_only_once(self):
        entered, release = threading.Event(), threading.Event()
        def checker():
            entered.set()
            release.wait(2)
            return True
        checked = mock.Mock(side_effect=checker)
        recovery = ModelRecovery(checked)
        try:
            recovery.start()
            self.assertTrue(entered.wait(1))
            recovery.start()
            self.assertFalse(recovery.ready)
            self.assertEqual(checked.call_count, 1)
            release.set()
            self.assertTrue(recovery._ready.wait(1))
        finally:
            release.set()
            recovery.stop()

    def test_failed_initialization_retries_and_eventually_recovers(self):
        checker = mock.Mock(side_effect=[RuntimeError("synthetic model missing"), False, True])
        recovery = ModelRecovery(checker, retry_seconds=0)
        try:
            recovery.start()
            self.assertTrue(recovery._ready.wait(1))
            self.assertEqual(checker.call_count, 3)
            recovery.start()
            self.assertEqual(checker.call_count, 3)
        finally:
            recovery.stop()

    def test_stop_interrupts_backoff_and_does_not_publish_late_result(self):
        entered, release = threading.Event(), threading.Event()
        def checker():
            entered.set()
            release.wait(2)
            return True
        recovery = ModelRecovery(checker)
        recovery.start()
        self.assertTrue(entered.wait(1))
        recovery._stop.set()
        release.set()
        recovery.stop()
        self.assertFalse(recovery.ready)
        recovery.start()
        self.assertFalse(recovery.ready)

    def test_real_run_prelude_starts_local_ui_before_model_initialization(self):
        tree = ast.parse(Path(__file__).with_name("main.py").read_text())
        run = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "run")
        # Execute production startup through its first camera construction,
        # replacing only hardware/IO adapters. No camera/server actually starts.
        boundary = next(i for i, node in enumerate(run.body) if isinstance(node, ast.Assign)
                        and any(isinstance(target, ast.Name) and target.id == "camera" for target in node.targets))
        run.body = run.body[:boundary]
        events = []
        fake_recovery = mock.Mock()
        fake_recovery.start.side_effect = lambda: events.append("model")
        recognizer = mock.Mock(known_count=1, usable_count=1, liveness_checker=None)
        web = mock.Mock()
        web.start_server.side_effect = lambda: events.append("ui")
        namespace = {
            "config": types.SimpleNamespace(LIVENESS_REQUIRED=False, DATA_DIR="synthetic", FACES_DIR="synthetic", MODEL_DIR="synthetic", KIOSK_PORT=5555),
            "require_kiosk_api_key": lambda: None, "require_kiosk_ui_key": lambda: None,
            "os": types.SimpleNamespace(makedirs=lambda *args, **kwargs: None),
            "database": mock.Mock(), "logger": logging.getLogger(__name__),
            "web_app": web, "FaceRecognizer": lambda: recognizer,
            "recognition_model_ready": lambda: self.fail("Model loading must be delegated"),
            "ModelRecovery": lambda _: fake_recovery, "SyncWorker": mock.Mock(),
        }
        exec(compile(ast.Module(body=[run], type_ignores=[]), "main.py", "exec"), namespace)
        namespace["run"](types.SimpleNamespace(server=None, kiosk_id=None))
        self.assertEqual(events, ["ui", "model"])
        web.update_health.assert_called_once()
        self.assertFalse(web.update_health.call_args.kwargs["model_ok"])


if __name__ == "__main__":
    unittest.main()
