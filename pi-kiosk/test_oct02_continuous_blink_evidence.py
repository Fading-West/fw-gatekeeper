import sys, types, unittest
from unittest import mock
import numpy as np
# The state-machine test supplies deterministic landmarks; native camera,
# dlib predictor and distance calculation are intentionally outside this test.
dlib=types.ModuleType('dlib'); dlib.rectangle=lambda *args: args
scipy=types.ModuleType('scipy'); spatial=types.ModuleType('scipy.spatial'); distance=types.ModuleType('scipy.spatial.distance'); distance.euclidean=lambda a,b:0
with mock.patch.dict(sys.modules,{'dlib':dlib,'scipy':scipy,'scipy.spatial':spatial,'scipy.spatial.distance':distance}):
 import liveness
class BlinkTests(unittest.TestCase):
 def checker(self):
  checker=liveness.LivenessChecker.__new__(liveness.LivenessChecker)
  checker.ear_threshold=.21; checker.blink_frames=2; checker.timeout_sec=5; checker._predictor=lambda *args:None; checker.failed=False; checker.reset()
  return checker
 def feed(self,checker,ear):
  with mock.patch.object(liveness,'_shape_to_np',return_value=np.zeros((68,2))),mock.patch.object(liveness,'_eye_aspect_ratio',return_value=ear):
   return checker.update(np.zeros((20,20,3),dtype=np.uint8),(0,19,19,0),frame_check=lambda *args:True)
 def test_dropouts_and_invalid_rectangles_cannot_complete_blink(self):
  for invalid in [None,(1,1,1,1)]:
   checker=self.checker(); self.feed(checker,.1); self.feed(checker,.1)
   checker.update(np.zeros((20,20,3),dtype=np.uint8),invalid)
   self.assertFalse(self.feed(checker,.3))
 def test_nonfinite_or_degenerate_landmarks_cannot_complete_blink(self):
  for invalid in [-.1,float('nan'),float('inf')]:
   checker=self.checker(); self.feed(checker,.1); self.feed(checker,invalid)
   self.assertFalse(self.feed(checker,.3))
 def test_consecutive_valid_identity_bound_blink_completes(self):
  checker=self.checker(); self.feed(checker,.1); self.feed(checker,.1)
  self.assertTrue(self.feed(checker,.3))
if __name__=='__main__': unittest.main()
