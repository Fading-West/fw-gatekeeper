"""Behavioral regression tests for changing faces in the kiosk's camera view."""
import unittest
import numpy as np
from matching import FreshFaceMatcher


class FreshFaceMatchingTests(unittest.TestCase):
    def setUp(self):
        self.matcher = FreshFaceMatcher(window=3, threshold=0.45)
        self.alex = np.array([1., 0., 0.])
        self.blair = np.array([0., 1., 0.])
        self.roster = [(0, self.alex), (1, self.blair)]
        self.worker_ids = [11, 22]
        self.server_ids = {11: 'server-a', 22: 'server-b'}

    def match(self, vector, when):
        return self.matcher.match(vector, self.roster, self.worker_ids, self.server_ids, when)

    def test_handoff_without_empty_frame_matches_new_person_not_old_average(self):
        self.match(self.alex, 1.)
        self.match(self.alex, 1.1)
        scores, accepted = self.match(self.blair, 1.2)
        self.assertTrue(accepted)
        self.assertEqual(scores[0][1], 1)
        self.assertAlmostEqual(scores[0][0], 1.)
        self.assertEqual(len(self.matcher), 1)

    def test_unknown_current_face_cannot_borrow_previous_workers_strong_scores(self):
        self.match(self.alex, 1.)
        self.match(self.alex, 1.1)
        _, accepted = self.match(np.array([.2, .1, .97]), 1.2)
        self.assertFalse(accepted)
        self.assertEqual(len(self.matcher), 0)

    def test_consecutive_same_person_frames_still_smooth_noise(self):
        self.match(np.array([1., .2, 0.]), 1.)
        scores, accepted = self.match(np.array([1., -.2, 0.]), 1.1)
        self.assertTrue(accepted)
        self.assertAlmostEqual(scores[0][0], 1.)
        self.assertEqual(len(self.matcher), 2)

    def test_equal_candidates_are_ambiguous(self):
        _, accepted = self.match(np.array([1., 1., 0.]), 1.)
        self.assertFalse(accepted)
        self.assertEqual(len(self.matcher), 0)

    def test_roster_change_time_gap_and_out_of_order_frames_reset_history(self):
        self.match(self.alex, 1.)
        self.match(self.alex, 1.1)
        self.server_ids[11] = 'replacement-server-id'
        self.match(self.alex, 1.2)
        self.assertEqual(len(self.matcher), 1)
        self.match(self.alex, 1.3)
        self.roster[0] = (0, self.alex.copy())
        self.match(self.alex, 1.4)
        self.assertEqual(len(self.matcher), 1)
        self.match(self.alex, 10.)
        self.assertEqual(len(self.matcher), 1)
        self.match(self.alex, 9.)
        self.assertEqual(len(self.matcher), 1)

    def test_missing_face_and_nonfinite_model_result_clear_history(self):
        self.match(self.alex, 1.)
        self.matcher.clear()  # no-face branch in the capture loop
        self.assertEqual(len(self.matcher), 0)
        self.match(self.alex, 1.1)
        with self.assertRaises(ValueError):
            self.match(np.array([float('nan'), 0., 0.]), 1.2)
        self.assertEqual(len(self.matcher), 0)


if __name__ == '__main__':
    unittest.main()
