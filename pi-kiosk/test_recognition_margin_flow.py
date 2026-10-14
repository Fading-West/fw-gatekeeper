"""Exercise production scan/blink branches without camera or dlib imports."""
import ast
import math
from pathlib import Path
import threading
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import numpy as np
import app as web_app
import config
from matching import FreshFaceMatcher, has_minimum_margin


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


def execute_display_cycle(namespace):
    """Run the production hold, pending-clock, and result branches in order."""
    main_loop = next(node for node in ast.walk(TREE)
                     if isinstance(node, ast.While) and any(
                         isinstance(child, ast.If) and ast.unparse(child.test) == 'now < display_until[0]'
                         for child in node.body))
    start = next(i for i, node in enumerate(main_loop.body)
                 if isinstance(node, ast.If) and ast.unparse(node.test) == 'now < display_until[0]')
    loop = ast.For(target=ast.Name(id='_', ctx=ast.Store()),
                   iter=ast.List(elts=[ast.Constant(None)], ctx=ast.Load()),
                   body=main_loop.body[start:], orelse=[])
    module = ast.fix_missing_locations(ast.Module(body=[loop], type_ignores=[]))
    exec(compile(module, 'main.py', 'exec'), namespace)


class RecognitionMarginFlowTests(unittest.TestCase):
    def test_detection_exposes_ambiguous_scores_without_an_approved_name(self):
        detection = next(node for node in ast.walk(TREE)
                         if isinstance(node, ast.FunctionDef) and node.name == 'detection_loop')
        # Run one real detection iteration against a synthetic face/roster.
        detection = ast.parse(ast.unparse(detection)).body[0]
        loop = next(node for node in detection.body if isinstance(node, ast.While))
        detection.body[detection.body.index(loop)] = ast.For(
            target=ast.Name(id='_', ctx=ast.Store()),
            iter=ast.List(elts=[ast.Constant(None)], ctx=ast.Load()), body=loop.body, orelse=[])
        recognizer = mock.Mock()
        recognizer.snapshot_known_faces.return_value = (
            [np.array([1., 0., 0.]), np.array([0., 1., 0.])], [11, 22],
            ['Alex', 'Blair'], {11: 'server-a', 22: 'server-b'})
        for top_score, second_score, expected in [(.7078, .7064, 'rejected_ambiguous'),
                                                   (.58, .5, 'rejected_ambiguous'),
                                                   (.9, .2, 'accepted')]:
            with self.subTest(top_score=top_score):
                vector = np.array([top_score, second_score,
                                   math.sqrt(1 - top_score ** 2 - second_score ** 2)])
                namespace = {'logger': mock.Mock(), 'FreshFaceMatcher': FreshFaceMatcher,
                             'has_minimum_margin': has_minimum_margin, 'config': config, 'np': np,
                             'detect_lock': threading.Lock(), 'pending_frame': [('bgr', 'rgb', 1.)],
                             'cv2': mock.Mock(), 'fr': mock.Mock(), 'detect_count': [0],
                             'embed_face': mock.Mock(return_value=vector), 'recognizer': recognizer,
                             'largest_face': lambda locs: locs[0], 'current_result': [None]}
                namespace['fr'].face_locations.return_value = [(5, 50, 50, 5)]
                module = ast.fix_missing_locations(ast.Module(body=[detection], type_ignores=[]))
                exec(compile(module, 'main.py', 'exec'), namespace)
                namespace['detection_loop']()
                result = namespace['current_result'][0]
                self.assertEqual(result['decision'], expected)
                self.assertEqual(result['name'], 'Alex' if expected == 'accepted' else None)
                self.assertEqual(result['candidate_worker_id'], 11)
                self.assertEqual(result['server_worker_id'], 'server-a')
                self.assertAlmostEqual(result['best_score'], top_score)
                self.assertAlmostEqual(result['second_best_score'], second_score)
                self.assertAlmostEqual(result['score_margin'], top_score - second_score)

    def test_ambiguous_fresh_result_cancels_pending_blink_before_or_after_confirmation(self):
        for confirmed in [False, True]:
            with self.subTest(confirmed=confirmed):
                fresh = {'name': None, 'decision': 'rejected_ambiguous',
                         'candidate_worker_id': 11, 'server_worker_id': 'server-a',
                         'best_score': .7078, 'second_best_score': .7064}
                pending = {'worker_id': 11, 'server_worker_id': 'server-a',
                           'blink_confirmed': confirmed, 'blink_confirmed_at': 1.,
                           'post_blink_confirmed': False, 'result': {'decision': 'accepted'}}
                status = {'state': 'WAITING_FOR_BLINK', 'worker_name': 'Alex', 'worker_id': 'A11',
                          'confidence': .9, 'ear': .2, 'action': 'clock_in', 'liveness_confirmed': True}
                status_patch = mock.patch.object(web_app, '_status', status)
                status_patch.start()
                self.addCleanup(status_patch.stop)
                namespace = {'pending': pending, 'pending_clock': [pending], 'GOLD': 'gold',
                             'current_result': [fresh], 'config': config, 'now': 2.,
                             'liveness': mock.Mock(), 'web_app': web_app,
                             'recognizer': mock.Mock(known_count=2),
                             'display_until': [0.], '_log_recognition_attempt': mock.Mock(),
                             'record_clock': mock.Mock()}
                execute_branch('pending is not None', namespace)
                self.assertIsNone(namespace['pending_clock'][0])
                self.assertIsNone(namespace['current_result'][0])
                namespace['liveness'].reset.assert_called_once()
                namespace['_log_recognition_attempt'].assert_called_once_with(fresh, 'rejected_ambiguous')
                namespace['record_clock'].assert_not_called()
                self.assertEqual(status['state'], 'NOT_RECOGNIZED')
                self.assertIn('try again', status['message'])
                self.assertIsNone(status['worker_id'])
                self.assertIsNone(status['worker_name'])
                self.assertIsNone(status['action'])
                self.assertFalse(status['liveness_confirmed'])
                self.assertEqual(status['confidence'], 0.)
                self.assertEqual(status['ear'], 0.)
                self.assertGreater(namespace['display_until'][0], namespace['now'])

                # After the hold, a worker leaving the camera must return the
                # UI to idle even though cancellation already cleared box_loc.
                namespace.update(result=None, time=mock.Mock())
                namespace['now'] = namespace['display_until'][0] + .1
                execute_branch('result is None', namespace)
                self.assertEqual(status['state'], 'IDLE')
                self.assertIsNone(status['worker_name'])
                self.assertEqual(namespace['display_until'][0], 0.)

                # The next worker starts a new blink verification with their
                # own identity, then completes it using a fresh post-blink scan.
                blair = {'name': 'Blair', 'decision': 'accepted', 'frame_ts': namespace['now'],
                         'face_loc': (5, 50, 50, 5), 'confidence': .9,
                         'candidate_worker_id': 22, 'server_worker_id': 'server-b',
                         'candidate_encoding': np.array([0., 1., 0.])}
                namespace.update(current_result=[blair], roster_fault=None, model_healthy=True, GREEN='green',
                                 database=mock.Mock(), last_clocks={}, datetime=datetime,
                                 timezone=timezone, timedelta=timedelta,
                                 format_worker_display_id=mock.Mock(return_value='B22'))
                namespace['recognizer'].usable_count = 2
                namespace['database'].get_worker_by_id.return_value = {'server_id': 'server-b'}
                namespace['database'].was_recently_clocked.return_value = False
                namespace['liveness'].get_ear.return_value = .22
                execute_display_cycle(namespace)
                self.assertEqual(status['state'], 'WAITING_FOR_BLINK')
                self.assertEqual(status['worker_name'], 'Blair')
                self.assertEqual(status['worker_id'], 'B22')
                self.assertEqual(namespace['pending_clock'][0]['worker_id'], 22)
                self.assertEqual(namespace['pending_clock'][0]['server_worker_id'], 'server-b')

                namespace['pending_clock'][0].update(blink_confirmed=True,
                                                     blink_confirmed_at=namespace['now'])
                namespace['now'] += .1
                namespace['current_result'][0] = dict(blair, frame_ts=namespace['now'])
                namespace['record_clock'].return_value = True
                execute_display_cycle(namespace)
                namespace['record_clock'].assert_called_once_with(
                    blair, 22, 'Blair', 'B22', .9, liveness_confirmed=True, server_worker_id='server-b')
                self.assertIsNone(namespace['pending_clock'][0])
                self.assertEqual(namespace['display_until'][0],
                                 namespace['now'] + config.DISPLAY_TIME_SUCCESS_SEC)

    def test_idle_return_respects_success_error_and_retry_display_holds(self):
        for state, duration in [('CLOCKED_IN', config.DISPLAY_TIME_SUCCESS_SEC),
                                ('ERROR', 2), ('NOT_RECOGNIZED', config.DISPLAY_TIME_SEC),
                                ('SERVICE_DEGRADED', config.DISPLAY_TIME_SEC)]:
            with self.subTest(state=state):
                status = {'state': state, 'message': 'held message', 'worker_name': 'Alex'}
                with mock.patch.object(web_app, '_status', status):
                    recognizer = mock.Mock(known_count=2, usable_count=2)
                    namespace = {'now': 10. + duration - .01, 'display_until': [10. + duration],
                                 'current_result': [{'name': 'Blair'}], 'pending_clock': [None],
                                 'box_loc': None, 'recognizer': recognizer, 'roster_fault': None,
                                 'web_app': web_app, 'time': mock.Mock()}
                    execute_display_cycle(namespace)
                    self.assertEqual(status['state'], state)
                    self.assertEqual(status['message'], 'held message')
                    self.assertEqual(namespace['display_until'][0], 10. + duration)
                    self.assertIsNone(namespace['current_result'][0])

                    namespace['now'] = namespace['display_until'][0]
                    execute_display_cycle(namespace)
                    self.assertEqual(status['state'], 'IDLE')
                    self.assertIsNone(status['worker_name'])
                    self.assertEqual(namespace['display_until'][0], 0.)

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
        boundary = np.array([.58, .5, math.sqrt(1 - .58 ** 2 - .5 ** 2)])
        for vector, expected in [(np.array([.7078, .7064, .001]), False),
                                 (boundary, False), (alex, True), (blair, False)]:
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
