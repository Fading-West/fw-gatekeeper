import unittest
from scan_freshness import is_fresh_scan
class FreshnessTests(unittest.TestCase):
 def test_stale_future_invalid_and_interrupted_results_rejected(self):
  for result in [None, {}, {'frame_ts':float('nan')}, {'frame_ts':94.9}, {'frame_ts':101}, {'frame_ts':97}]:
   self.assertFalse(is_fresh_scan(result,100,invalidated_at=98))
 def test_current_post_recovery_result_accepted(self):
  self.assertTrue(is_fresh_scan({'frame_ts':99},100,invalidated_at=98))
if __name__=='__main__': unittest.main()
