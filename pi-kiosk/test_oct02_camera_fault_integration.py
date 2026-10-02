"""Execute actual production fault-result expressions and main consumption code."""
import ast
import os
import sys
import unittest
import threading
from unittest import mock
from pathlib import Path
from types import SimpleNamespace

root = Path(os.environ.get('GK_CHECKOUT', Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(root / 'pi-kiosk'))
from scan_freshness import is_fresh_scan
source = ast.parse((root / 'pi-kiosk/main.py').read_text())
factory = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == '_empty_recognition_result')
run = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == 'run')
failure_assignments = [n for n in ast.walk(run) if isinstance(n, ast.Assign)
    and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Name)
    and n.value.func.id == '_empty_recognition_result']
# Select the real scan-consumption branch in main, including its freshness guard.
loop = next(n for n in ast.walk(run) if isinstance(n, ast.While)
    and any(isinstance(s, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'result' for t in s.targets) for s in n.body))
start = next(i for i,s in enumerate(loop.body) if isinstance(s, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'result' for t in s.targets))
consumer = ast.Module(body=loop.body[start:start+2], type_ignores=[])

class FaultFreshnessQA(unittest.TestCase):
    def test_actual_camera_failure_branch_clears_pending_evidence_and_rejects_late_result(self):
        handler = next(n for n in ast.walk(run) if isinstance(n, ast.ExceptHandler)
            and any(isinstance(s, ast.Expr) and isinstance(s.value, ast.Call)
                and s.value.args and isinstance(s.value.args[0], ast.Constant)
                and s.value.args[0].value == 'Capture error: %s' for s in n.body))
        context = {'logger': mock.Mock(), 'e': RuntimeError('synthetic capture loss'),
            'time': SimpleNamespace(time=lambda: 100.0, sleep=lambda n: None),
            'camera_invalidated_at': [0.0], 'pending_clock': [{'worker_id': 'synthetic'}],
            'current_result': [{'frame_ts': 99.0}], 'pending_frame': [('synthetic-frame',)],
            'detect_lock': threading.Lock(), 'liveness': mock.Mock(), 'camera_healthy': True,
            'web_app': mock.Mock(), 'now': 101.0, 'is_fresh_scan': is_fresh_scan}
        wrapped = ast.Module(body=[ast.For(target=ast.Name(id='_iteration', ctx=ast.Store()),
            iter=ast.List(elts=[ast.Constant(value=0)], ctx=ast.Load()), body=handler.body, orelse=[])], type_ignores=[])
        exec(compile(ast.fix_missing_locations(wrapped), 'production-capture-handler', 'exec'), context)
        self.assertIsNone(context['pending_clock'][0])
        self.assertIsNone(context['pending_frame'][0])
        self.assertIsNone(context['current_result'][0])
        context['liveness'].reset.assert_called_once()
        for stamp, expected in [(99.5, False), (100.5, True)]:
            evidence = {'frame_ts': stamp}
            context['current_result'][0] = evidence
            exec(compile(consumer, 'production-recovery-consumer', 'exec'), context)
            self.assertEqual(context['result'] is evidence, expected)

    def test_fresh_faults_survive_the_actual_main_consumption_guard(self):
        self.assertEqual(len(failure_assignments), 3)
        for assignment in failure_assignments:
            with self.subTest(expression=ast.unparse(assignment)):
                context = {'config': SimpleNamespace(RECOGNITION_MATCH_THRESHOLD=.45, RECOGNITION_MODEL_VERSION='synthetic'),
                    'face_loc': (0,2,2,0), 'frame_ts': 99.0, 'current_result': [None],
                    'now': 100.0, 'camera_invalidated_at': [98.0], 'is_fresh_scan': is_fresh_scan}
                exec(compile(ast.Module(body=[factory], type_ignores=[]), 'production-factory', 'exec'), context)
                exec(compile(ast.Module(body=[assignment], type_ignores=[]), 'production-fault-branch', 'exec'), context)
                expected = context['current_result'][0]
                exec(compile(consumer, 'production-main-consumer', 'exec'), context)
                self.assertIs(context['result'], expected)

if __name__ == '__main__': unittest.main()
