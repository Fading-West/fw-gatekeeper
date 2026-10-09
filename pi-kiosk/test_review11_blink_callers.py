import ast
import os
import sys
import unittest
from pathlib import Path
from unittest import mock
import numpy as np
default_root=Path(__file__).resolve().parent.parent if Path(__file__).resolve().parent.name=='pi-kiosk' else Path(__file__).resolve().parents[1]/'worktrees/11-continuous-blink-evidence'
root=Path(os.environ.get('GK_CHECKOUT',default_root))
sys.path.insert(0,str(root/'pi-kiosk'))
import test_oct02_continuous_blink_evidence as fixture
liveness=fixture.liveness

class BlinkIntegrationQA(fixture.BlinkTests):
    def test_kiosk_detector_dropout_cancels_pending_blink(self):
        tree = ast.parse((root / 'pi-kiosk/main.py').read_text())
        run = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run')
        factory = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_empty_recognition_result')
        dropout = next(n for n in ast.walk(run) if isinstance(n, ast.If) and ast.unparse(n.test) == 'not locs')
        pending_branch = next(n for n in ast.walk(run) if isinstance(n, ast.If) and ast.unparse(n.test) == 'pending is not None')
        def execute_branch(branch, context):
            wrapper = ast.Module(body=[ast.For(target=ast.Name(id='_once', ctx=ast.Store()),
                iter=ast.List(elts=[ast.Constant(value=0)], ctx=ast.Load()), body=[branch], orelse=[])], type_ignores=[])
            exec(compile(ast.fix_missing_locations(wrapper), 'production-kiosk-dropout', 'exec'), context)
        checker = self.checker()
        self.feed(checker, .1)
        self.feed(checker, .1)
        pending = {'result': {}, 'worker_id': 1, 'server_worker_id': 'synthetic', 'blink_confirmed': False}
        context = {'locs': [], 'frame_ts': 99.0, 'embedding_history': mock.Mock(), 'current_result': [None],
                   'config': type('Settings', (), {'RECOGNITION_MATCH_THRESHOLD': .45, 'RECOGNITION_MODEL_VERSION': 'synthetic'}),
                   'pending': pending, 'pending_clock': [pending], 'liveness': checker,
                   '_log_recognition_attempt': mock.Mock(), 'web_app': mock.Mock(),
                   'recognizer': type('Recognizer', (), {'known_count': 1}), 'GOLD': 'gold'}
        exec(compile(ast.Module(body=[factory], type_ignores=[]), 'production-factory', 'exec'), context)
        execute_branch(dropout, context)
        self.assertIsNotNone(context['current_result'][0], 'Observed absence must reach the pending caller')
        self.assertEqual(context['current_result'][0]['frame_ts'], 99.0, 'Dropout must survive the PR100 freshness guard')
        execute_branch(pending_branch, context)
        self.assertIsNone(context['pending_clock'][0])
        self.assertFalse(context['web_app'].update_status.call_args.kwargs['face_detected'])
        self.assertFalse(self.feed(checker, .3), 'An open-eye frame after dropout cannot complete the old blink')

    def test_one_degenerate_eye_cannot_supply_closed_eye_evidence(self):
        checker=self.checker()
        for _ in range(2):
            with mock.patch.object(liveness,'_shape_to_np',return_value=np.zeros((68,2))),mock.patch.object(liveness,'_eye_aspect_ratio',side_effect=[float('nan'),.2]):
                checker.update(np.zeros((20,20,3),dtype=np.uint8),(0,19,19,0))
        self.assertFalse(self.feed(checker,.3))

    def test_closed_eye_geometry_is_valid_but_collapsed_landmarks_reset(self):
        checker = self.checker()
        # Positive eye width with zero lid separation is a fully closed eye.
        closed_eye = np.array([(0, 0), (1, 0), (2, 0), (3, 0), (2, 0), (1, 0)])
        landmarks = np.zeros((68, 2))
        landmarks[36:42] = landmarks[42:48] = closed_eye
        with mock.patch.object(liveness, 'euclidean', side_effect=lambda a, b: float(np.linalg.norm(a - b))):
            self.assertEqual(liveness._eye_aspect_ratio(closed_eye), 0)
            for _ in range(2):
                with mock.patch.object(liveness, '_shape_to_np', return_value=landmarks):
                    self.assertFalse(checker.update(np.zeros((20, 20, 3), dtype=np.uint8), (0, 19, 19, 0)))
            self.assertTrue(self.feed(checker, .3))
            checker.reset()
            self.feed(checker, .1)
            self.feed(checker, .1)
            landmarks[36:42] = 0
            with mock.patch.object(liveness, '_shape_to_np', return_value=landmarks):
                self.assertFalse(checker.update(np.zeros((20, 20, 3), dtype=np.uint8), (0, 19, 19, 0)))
            self.assertFalse(self.feed(checker, .3))

    def test_actual_enrollment_face_dropout_resets_closed_eye_sequence(self):
        tree=ast.parse((root/'pi-kiosk/enroll.py').read_text())
        loop=next(n for n in ast.walk(tree) if isinstance(n,ast.While) and 'len(encodings)' in ast.unparse(n.test))
        branch=next(n for n in loop.body if isinstance(n,ast.If) and ast.unparse(n.test)=='face_location is not None')
        unconditional=[n for n in loop.body[:loop.body.index(branch)] if isinstance(n,ast.Assign)
            and isinstance(n.value,ast.Call) and ast.unparse(n.value.func)=='liveness.update']
        # Keep the actual call and dropout else, excluding camera/file capture branches.
        branch.body=[s for s in branch.body if not isinstance(s,ast.If)]
        compiled=compile(ast.Module(body=[*unconditional,branch],type_ignores=[]),'actual-enrollment-liveness-caller','exec')
        checker=self.checker()
        context={'liveness':checker,'frame':np.zeros((20,20,3),dtype=np.uint8),'display':np.zeros((20,20,3),dtype=np.uint8),'cv2':mock.Mock()}
        for face,ear in [((0,19,19,0),.1),((0,19,19,0),.1),(None,.3),((0,19,19,0),.3)]:
            context['face_location']=face;context['live']=False
            with mock.patch.object(liveness,'_shape_to_np',return_value=np.zeros((68,2))),mock.patch.object(liveness,'_eye_aspect_ratio',return_value=ear):
                exec(compiled,context)
        self.assertFalse(context['live'])

    def test_actual_enrollment_capture_failure_resets_closed_eye_sequence(self):
        tree=ast.parse((root/'pi-kiosk/enroll.py').read_text())
        loop=next(n for n in ast.walk(tree) if isinstance(n,ast.While) and 'len(encodings)' in ast.unparse(n.test))
        failure=next(n for n in loop.body if isinstance(n,ast.If) and ast.unparse(n.test)=='not ret')
        wrapper=ast.Module(body=[ast.For(target=ast.Name(id='_once',ctx=ast.Store()),iter=ast.List(elts=[ast.Constant(value=0)],ctx=ast.Load()),body=[failure],orelse=[])],type_ignores=[])
        checker=self.checker();self.feed(checker,.1);self.feed(checker,.1)
        exec(compile(ast.fix_missing_locations(wrapper),'actual-capture-failure','exec'),{'ret':False,'liveness':checker,'time':mock.Mock()})
        self.assertFalse(self.feed(checker,.3))

if __name__=='__main__':unittest.main()
