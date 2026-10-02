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
    def test_one_degenerate_eye_cannot_supply_closed_eye_evidence(self):
        checker=self.checker()
        for _ in range(2):
            with mock.patch.object(liveness,'_shape_to_np',return_value=np.zeros((68,2))),mock.patch.object(liveness,'_eye_aspect_ratio',side_effect=[0,.2]):
                checker.update(np.zeros((20,20,3),dtype=np.uint8),(0,19,19,0))
        self.assertFalse(self.feed(checker,.3))

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
