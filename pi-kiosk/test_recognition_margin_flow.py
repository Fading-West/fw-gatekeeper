"""Exercise production scan/blink branches without camera or dlib imports."""
import ast
from pathlib import Path
import unittest
from unittest import mock

import numpy as np
import config
from matching import FreshFaceMatcher


TREE = ast.parse(Path(__file__).with_name('main.py').read_text())


def execute_branch(condition, namespace):
    branch = next(node for node in ast.walk(TREE)
                  if isinstance(node, ast.If) and ast.unparse(node.test) == condition)
    # A one-iteration loop preserves the production branch's continue behavior.
    loop = ast.For(target=ast.Name(id='_', ctx=ast.Store()),
                   iter=ast.List(elts=[ast.Constant(None)], ctx=ast.Load()),
                   body=[branch], orelse=[])
    module = ast.fix_missing_locations(ast.Module(body=[loop], type_ignores=[]))
    exec(compile(module, 'main.py', 'exec'), namespace)


class RecognitionMarginFlowTests(unittest.TestCase):
    def test_ambiguous_fresh_result_cancels_pending_blink_before_or_after_confirmation(self):
        for confirmed in [False, True]:
            with self.subTest(confirmed=confirmed):
                fresh = {'name': None, 'decision': 'rejected_ambiguous',
                         'candidate_worker_id': 11, 'server_worker_id': 'server-a',
                         'best_score': .7078, 'second_best_score': .7064}
                pending = {'worker_id': 11, 'server_worker_id': 'server-a',
                           'blink_confirmed': confirmed, 'blink_confirmed_at': 1.,
                           'post_blink_confirmed': False, 'result': {'decision': 'accepted'}}
                namespace = {'pending': pending, 'pending_clock': [pending], 'GOLD': 'gold',
                             'current_result': [fresh], 'config': config, 'now': 2.,
                             'liveness': mock.Mock(), 'web_app': mock.Mock(),
                             'recognizer': mock.Mock(known_count=2),
                             'display_until': [0.], '_log_recognition_attempt': mock.Mock(),
                             'record_clock': mock.Mock()}
                execute_branch('pending is not None', namespace)
                self.assertIsNone(namespace['pending_clock'][0])
                self.assertIsNone(namespace['current_result'][0])
                namespace['liveness'].reset.assert_called_once()
                namespace['_log_recognition_attempt'].assert_called_once_with(fresh, 'rejected_ambiguous')
                namespace['record_clock'].assert_not_called()
                status = namespace['web_app'].update_status.call_args.kwargs
                self.assertEqual(status['state'], 'NOT_RECOGNIZED')
                self.assertIn('try again', status['message'])
                self.assertIsNone(status['worker_id'])
                self.assertGreater(namespace['display_until'][0], namespace['now'])

    def test_clear_post_blink_identity_still_records_only_after_blink_frame(self):
        for frame_ts, expected in [(.5, False), (2., True)]:
            with self.subTest(frame_ts=frame_ts):
                fresh = {'name': 'Alex', 'decision': 'accepted', 'frame_ts': frame_ts,
                         'candidate_worker_id': 11, 'server_worker_id': 'server-a'}
                pending = {'worker_id': 11, 'server_worker_id': 'server-a',
                           'display_name': 'Alex', 'display_id': 'A11', 'confidence': .9,
                           'blink_confirmed': True, 'blink_confirmed_at': 1.,
                           'post_blink_confirmed': False, 'deadline': 5., 'result': fresh}
                namespace = {'pending': pending, 'pending_clock': [pending],
                             'current_result': [fresh], 'config': config, 'now': 2.,
                             'liveness': mock.Mock(), 'web_app': mock.Mock(), 'time': mock.Mock(),
                             'recognizer': mock.Mock(known_count=2), 'display_until': [0.],
                             'record_clock': mock.Mock(return_value=True),
                             '_log_recognition_attempt': mock.Mock()}
                execute_branch('pending is not None', namespace)
                self.assertEqual(namespace['record_clock'].called, expected)
                if expected:
                    namespace['record_clock'].assert_called_once_with(
                        fresh, 11, 'Alex', 'A11', .9, liveness_confirmed=True, server_worker_id='server-a')
                    self.assertIsNone(namespace['pending_clock'][0])
                    namespace['liveness'].reset.assert_called_once()
                else:
                    self.assertIs(namespace['pending_clock'][0], pending)
                namespace['_log_recognition_attempt'].assert_not_called()

    def test_worker_gets_neutral_retry_message_and_ambiguous_telemetry(self):
        result = {'decision': 'rejected_ambiguous'}
        namespace = {'name': None, 'unknown_streak': config.RECOGNITION_UNKNOWN_STREAK - 1,
                     'config': config, 'GOLD': 'gold', 'RED': 'red', 'web_app': mock.Mock(),
                     'recognizer': mock.Mock(known_count=2), 'confidence': .7078,
                     'result': result, 'decision': 'rejected_ambiguous',
                     '_log_recognition_attempt': mock.Mock(), 'display_until': [0.], 'now': 2.}
        execute_branch('name is None', namespace)
        namespace['_log_recognition_attempt'].assert_called_once_with(result, 'rejected_ambiguous')
        status = namespace['web_app'].update_status.call_args.kwargs
        self.assertEqual(status['message'], 'Please try again or ask your supervisor')
        self.assertIsNone(status['worker_id'])

    def test_blink_frames_need_clear_winner_with_current_pending_identity(self):
        callback = next(node for node in ast.walk(TREE)
                        if isinstance(node, ast.FunctionDef) and node.name == '_frame_matches_pending')
        alex, blair = np.array([1., 0., 0.]), np.array([0., 1., 0.])
        recognizer = mock.Mock()
        recognizer.snapshot_known_faces.return_value = ([alex, blair], [11, 22],
                                                       ['Alex', 'Blair'], {11: 'server-a', 22: 'server-b'})
        namespace = {'embed_face': mock.Mock(), 'logger': mock.Mock(), 'np': np,
                     'config': config, 'FreshFaceMatcher': FreshFaceMatcher,
                     'recognizer': recognizer, 'now': 2.,
                     'pending': {'worker_id': 11, 'server_worker_id': 'server-a', 'encoding': alex}}
        exec(compile(ast.Module(body=[callback], type_ignores=[]), 'main.py', 'exec'), namespace)
        for vector, expected in [(np.array([.7078, .7064, .001]), False), (alex, True), (blair, False)]:
            with self.subTest(vector=vector):
                namespace['embed_face'].return_value = vector
                self.assertEqual(namespace['_frame_matches_pending']('frame', 'box'), expected)
        recognizer.snapshot_known_faces.return_value = ([alex], [11], ['Alex'], {11: 'server-a'})
        namespace['embed_face'].return_value = np.array([.46, .8879, 0.])
        self.assertTrue(namespace['_frame_matches_pending']('frame', 'box'))
        recognizer.snapshot_known_faces.return_value = ([alex], [11], ['Alex'], {11: 'replacement'})
        self.assertFalse(namespace['_frame_matches_pending']('frame', 'box'))


if __name__ == '__main__':
    unittest.main()
