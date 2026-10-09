"""Synthetic asynchronous model recovery and real startup ordering coverage."""
import ast
from datetime import datetime, timedelta
import logging
import threading
import types
import unittest
from pathlib import Path
from unittest import mock

from model_recovery import ModelRecovery


class ModelRecoveryTests(unittest.TestCase):
    def test_initialization_loop_preserves_manual_confirmation_then_restores_fault(self):
        source = ast.parse(Path(__file__).with_name('app.py').read_text())
        helpers = [node for node in source.body if isinstance(node, ast.FunctionDef)
                   and node.name in {'update_status', 'update_status_unless_confirming'}]
        now = [datetime(2026, 10, 8, 12, 0, 0)]
        class Clock(datetime):
            @classmethod
            def now(cls):
                return now[0]
        status = {'state': 'CLOCKED_IN', 'message': 'Attendance recorded', 'timestamp': now[0].isoformat()}
        namespace = {'_status': status, '_status_lock': threading.Lock(), 'datetime': Clock,
                     'config': types.SimpleNamespace(DISPLAY_TIME_SUCCESS_SEC=3)}
        exec(compile(ast.Module(body=helpers, type_ignores=[]), 'production-confirmation', 'exec'), namespace)
        tree = ast.parse(Path(__file__).with_name('main.py').read_text())
        run = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'run')
        waiting = next(node for node in ast.walk(run) if isinstance(node, ast.If)
                       and ast.unparse(node.test) == 'not model_recovery.ready'
                       and any(isinstance(child, ast.Expr) and isinstance(child.value, ast.Call)
                               and ast.unparse(child.value.func) == 'web_app.update_health' for child in node.body))
        web = types.SimpleNamespace(update_health=mock.Mock(), update_status=namespace['update_status'],
            update_status_unless_confirming=namespace['update_status_unless_confirming'])
        context = {'model_recovery': types.SimpleNamespace(ready=False), 'web_app': web,
                   'pending_clock': [None], 'current_result': [None],
                   'recognizer': types.SimpleNamespace(known_count=1), 'time': mock.Mock()}
        wrapper = ast.Module(body=[ast.For(target=ast.Name(id='_once', ctx=ast.Store()),
            iter=ast.List(elts=[ast.Constant(value=0)], ctx=ast.Load()), body=[waiting], orelse=[])], type_ignores=[])
        compiled = compile(ast.fix_missing_locations(wrapper), 'production-model-wait', 'exec')
        exec(compiled, context)
        self.assertEqual(status['state'], 'CLOCKED_IN')
        now[0] += timedelta(seconds=3)
        exec(compiled, context)
        self.assertEqual(status['state'], 'SERVICE_DEGRADED')
        self.assertIn('Recognition unavailable', status['message'])

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

    def test_empty_camera_model_recovery_clears_only_its_own_fault(self):
        source = ast.parse(Path(__file__).with_name("main.py").read_text())
        transition = next(node for node in ast.walk(source) if isinstance(node, ast.If)
                          and ast.unparse(node.test) == 'model_recovery.ready and (not initial_model_loaded)')
        for fault in (None, 'no_workers_synced', 'liveness_required_unavailable'):
            web = mock.Mock()
            context = {'model_recovery': types.SimpleNamespace(ready=True), 'initial_model_loaded': False,
                       'web_app': web, 'base_degraded_reason': lambda: fault}
            exec(compile(ast.Module(body=[transition], type_ignores=[]), 'production-recovery', 'exec'), context)
            self.assertTrue(context['model_healthy'])
            self.assertEqual(web.replace_status_if.call_count, int(fault is None))

    def test_recovery_status_comparison_preserves_manual_confirmation(self):
        source = ast.parse(Path(__file__).with_name('app.py').read_text())
        helper = next(node for node in source.body if isinstance(node, ast.FunctionDef)
                      and node.name == 'replace_status_if')
        status = {'state': 'CLOCKED_IN', 'message': 'Attendance recorded'}
        context = {'_status': status, '_status_lock': threading.Lock(),
                   'datetime': __import__('datetime').datetime}
        exec(compile(ast.Module(body=[helper], type_ignores=[]), 'production-status', 'exec'), context)
        replace = context['replace_status_if']
        self.assertFalse(replace('SERVICE_DEGRADED', 'Recognition unavailable', state='IDLE', message='Ready'))
        self.assertEqual(status['state'], 'CLOCKED_IN')
        status.update(state='SERVICE_DEGRADED', message='Recognition unavailable')
        self.assertTrue(replace('SERVICE_DEGRADED', 'Recognition unavailable', state='IDLE', message='Ready'))


if __name__ == "__main__":
    unittest.main()
