"""Behavioral regression tests for changing faces in the kiosk's camera view."""
import unittest
import math
import runpy
import types
from pathlib import Path
from unittest import mock
import numpy as np
import config
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

    def test_reported_near_tie_cannot_borrow_accepted_history(self):
        self.match(self.alex, 1.)
        vector = np.array([.7078, .7064, math.sqrt(1 - .7078 ** 2 - .7064 ** 2)])
        scores, accepted = self.match(vector, 1.1)
        self.assertAlmostEqual(scores[0][0], .7078)
        self.assertAlmostEqual(scores[1][0], .7064)
        self.assertFalse(accepted)
        self.assertEqual(len(self.matcher), 0)
        _, accepted = self.match(self.alex, 1.2)
        self.assertTrue(accepted)
        self.assertEqual(len(self.matcher), 1)

    def test_clear_winner_is_accepted(self):
        _, accepted = self.match(np.array([.9, .2, math.sqrt(.15)]), 1.)
        self.assertTrue(accepted)

    def test_exact_margin_is_accepted_but_just_below_is_rejected(self):
        for top_score, expected in [(.58, True), (.579999, False)]:
            with self.subTest(top_score=top_score):
                self.matcher.clear()
                self.roster = [
                    (0, np.array([top_score, math.sqrt(1 - top_score ** 2), 0.])),
                    (1, np.array([.5, 0., math.sqrt(.75)])),
                ]
                _, accepted = self.match(self.alex, 1.)
                self.assertEqual(accepted, expected)

    def test_single_worker_needs_threshold_but_no_margin(self):
        self.roster = [(0, self.alex)]
        for top_score, expected in [(.46, True), (.44, False)]:
            with self.subTest(top_score=top_score):
                vector = np.array([top_score, math.sqrt(1 - top_score ** 2), 0.])
                scores, accepted = self.match(vector, 1.)
                self.assertEqual(len(scores), 1)
                self.assertEqual(accepted, expected)

    def test_average_near_tie_after_competitor_refresh_is_rejected(self):
        # The current frame still clearly identifies Alex, but Blair's refreshed
        # template is too close to the accumulated embedding to approve it.
        _, accepted = self.match(np.array([1., -.3, 0.]), 1.)
        self.assertTrue(accepted)
        self.roster[1] = (1, np.array([3., -1., 0.]))
        scores, accepted = self.match(np.array([1., .3, 0.]), 1.1)
        self.assertEqual(scores[0][1], 0)
        self.assertGreater(scores[0][0], self.matcher.threshold)
        self.assertLess(scores[0][0] - scores[1][0], config.RECOGNITION_MIN_MARGIN)
        self.assertFalse(accepted)
        self.assertEqual(len(self.matcher), 0)

    def test_operator_margin_override_is_used(self):
        with mock.patch.object(config, 'RECOGNITION_MIN_MARGIN', .2):
            self.matcher = FreshFaceMatcher(window=3, threshold=.45)
        _, accepted = self.match(np.array([.75, .6, math.sqrt(1 - .75 ** 2 - .6 ** 2)]), 1.)
        self.assertFalse(accepted)

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


class RecognitionMarginConfigTests(unittest.TestCase):
    def load_config(self, margin):
        local = types.ModuleType('config_local')
        local.RECOGNITION_MIN_MARGIN = margin
        with mock.patch.dict('sys.modules', {'config_local': local}):
            return runpy.run_path(str(Path(__file__).with_name('config.py')))

    def test_valid_operator_overrides(self):
        for margin in [.01, .08, 1, 2]:
            self.assertEqual(self.load_config(margin)['RECOGNITION_MIN_MARGIN'], margin)

    def test_invalid_operator_overrides_fail_closed(self):
        for margin in [0, -.01, 2.01, float('nan'), float('inf'), True, '.08', None]:
            with self.subTest(margin=margin), self.assertRaisesRegex(ValueError, 'RECOGNITION_MIN_MARGIN'):
                self.load_config(margin)


if __name__ == '__main__':
    unittest.main()
