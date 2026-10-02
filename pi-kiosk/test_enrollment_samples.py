"""Synthetic enrollment samples use the same policy as the server."""
import ast
from pathlib import Path
import types
import unittest
from unittest.mock import Mock

import numpy as np
from enrollment_samples import competing_faces, samples_agree


class EnrollmentSampleTests(unittest.TestCase):
    def vector(self, axis):
        vector = np.zeros(512)
        vector[axis] = 1
        return vector

    def test_mixed_identity_capture_is_rejected_and_correct_retake_can_continue(self):
        subject = self.vector(0)
        other = self.vector(1)
        accepted = [subject]
        self.assertFalse(samples_agree(accepted + [other]))
        self.assertTrue(samples_agree(accepted + [subject]))
        accepted.append(subject)
        self.assertFalse(samples_agree(accepted + [other]))
        self.assertTrue(samples_agree(accepted + [subject]))
        self.assertFalse(samples_agree([subject, other, self.vector(2)]))

    def test_zero_nonfinite_or_wrong_dimension_samples_are_rejected(self):
        for invalid in [np.zeros(512), np.ones(128), np.full(512, np.inf), np.full(512, np.nan)]:
            self.assertFalse(samples_agree([self.vector(0), invalid]))

    def test_competing_detection_matches_server_area_policy_with_coordinate_conversion(self):
        self.assertTrue(competing_faces([(0, 100, 100, 0), (200, 290, 290, 200)]))
        self.assertFalse(competing_faces([(0, 100, 100, 0), (200, 210, 210, 200)]))
        self.assertFalse(competing_faces([(0, 100, 100, 0)]))

    def test_actual_cli_detector_refuses_competing_subjects_before_selecting_largest(self):
        source = ast.parse(Path(__file__).with_name('enroll.py').read_text())
        selected = [node for node in source.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))
                    and node.name in {'CompetingEnrollmentFaces', '_largest_face', '_detect_primary_face'}]
        cv2 = types.SimpleNamespace(COLOR_BGR2RGB=1, cvtColor=Mock(return_value='rgb'), resize=Mock(return_value='small'))
        detector = types.SimpleNamespace(face_locations=Mock(return_value=[(0, 100, 100, 0), (200, 290, 290, 200)]))
        namespace = {'cv2': cv2, 'face_recognition': detector, 'competing_faces': competing_faces, 'Optional': __import__('typing').Optional}
        exec(compile(ast.Module(body=selected, type_ignores=[]), 'synthetic_cli', 'exec'), namespace)
        with self.assertRaises(namespace['CompetingEnrollmentFaces']):
            namespace['_detect_primary_face']('synthetic-frame')
        detector.face_locations.return_value = [(2, 12, 10, 4)]
        self.assertEqual(namespace['_detect_primary_face']('synthetic-frame'), (4, 24, 20, 8))


if __name__ == '__main__':
    unittest.main()
