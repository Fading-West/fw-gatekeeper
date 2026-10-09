"""Run the production main/detector loops with controlled synthetic camera work.

Only native/model/database/server dependencies are replaced. A real detector
thread holds an old embedding across the actual disconnect/recovery handler.
"""
import ast
from datetime import datetime, timedelta, timezone
import logging
from pathlib import Path
import threading
import types
import unittest
from unittest import mock

import numpy as np
import config
from matching import FreshFaceMatcher

# Combined acceptance uses the preserved PR100 expiry implementation rather
# than substituting a weaker freshness contract into the production run loop.
if Path(__file__).with_name('scan_freshness.py').exists():
    from scan_freshness import is_fresh_scan
else:
    is_fresh_scan = None
if Path(__file__).with_name('kiosk_policy.py').exists():
    from kiosk_policy import require_kiosk_action_type, validate_kiosk_policy
else:
    require_kiosk_action_type = validate_kiosk_policy = None

SOURCE = ast.parse(Path(__file__).with_name('main.py').read_text())
FUNCTIONS = [node for node in SOURCE.body if isinstance(node, ast.FunctionDef)
             and node.name in {'run', '_empty_recognition_result', 'largest_face'}]


class DetectorStopped(BaseException):
    pass


class FixtureFailure(BaseException):
    pass


class Frame:
    def __init__(self, label):
        self.label = label

    def copy(self):
        return self


class CameraGenerationTests(unittest.TestCase):
    def exercise_recovery(self, required, expire=False):
        timeline = (['old-ready', 'old-blink', 'old-before-post', 'old-held', 'old-expired'] if expire else
                    ['old-ready', 'old-blink', 'old-before-post', 'old-held', 'disconnect', 'blank',
                     'new-ready', 'new-blink', 'new-confirm', 'new-post', 'new-last'] if required else
                    ['old-held', 'disconnect', 'blank', 'new-ready', 'new-last'])
        clock = [100.0]
        state = {'frame': None, 'detector_frame': None, 'index': 0}
        stopped, held, release = threading.Event(), threading.Event(), threading.Event()
        processed = {label: threading.Event() for label in timeline if label != 'disconnect'}
        allowed = {label: threading.Event() for label in processed}
        writes, attempts, blinks, thread_errors, detectors = [], [], [], [], []
        health, statuses, recovery_checks = {}, [], []
        old_vector, new_vector = np.eye(2, 512)

        def wait(event, message):
            if not event.wait(3):
                raise FixtureFailure(message)

        class Camera:
            def __init__(self, **kwargs):
                pass

            def start(self):
                pass

            def capture(self):
                previous = state['frame']
                if previous:
                    allowed[previous].set()
                if previous and previous != 'old-held':
                    wait(processed[previous], f'Detector did not finish {previous}')
                if state['index'] == len(timeline):
                    raise KeyboardInterrupt
                label = timeline[state['index']]
                state['index'] += 1
                clock[0] = 100.0 + state['index']
                if label == 'old-expired':
                    clock[0] = 150.0
                    release.set()
                    wait(processed['old-held'], 'Timed-out result did not finish')
                if label == 'disconnect':
                    wait(held, 'Old embedding never reached the controlled barrier')
                    state['frame'] = None
                    raise RuntimeError('synthetic disconnected camera')
                if label in ('blank', 'new-ready'):
                    recovery_checks.append((label, len(writes)))
                state['frame'] = label
                frame = Frame(label)
                return frame, frame

            def stop(self):
                stopped.set()
                release.set()

        def sleep(seconds):
            if threading.current_thread() is not threading.main_thread():
                label = state['detector_frame']
                if label:
                    processed[label].set()
                if stopped.wait(.001):
                    raise DetectorStopped
                return
            if seconds == 1:
                release.set()
                wait(processed['old-held'], 'Old work did not finish after disconnect')
            elif state['frame'] == 'old-held':
                allowed['old-held'].set()
                wait(held, 'Embedding was not held before capture loss')
            elif state['frame']:
                allowed[state['frame']].set()
                wait(processed[state['frame']], 'Current detector frame did not complete')

        def locations(frame, **kwargs):
            wait(allowed[frame.label], f'Main did not release frame {frame.label}')
            state['detector_frame'] = frame.label
            return [] if frame.label == 'blank' else [(0, 2, 2, 0)]

        def embedding(frame, location):
            if threading.current_thread() is not threading.main_thread() and frame.label == 'old-held':
                held.set()
                wait(release, 'Camera never retired the held old work')
            return old_vector if frame.label.startswith('old-') else new_vector

        class DetectorThread:
            def __init__(self, target, **kwargs):
                def wrapped():
                    try:
                        target()
                    except DetectorStopped:
                        pass
                    except BaseException as exc:
                        thread_errors.append(exc)
                self.thread = threading.Thread(target=wrapped, daemon=True)
                detectors.append(self)

            def start(self):
                self.thread.start()

        checker = types.SimpleNamespace(reset=mock.Mock(), get_ear=lambda: .3)

        def verify(frame, location, frame_check):
            blinks.append(frame.label)
            return frame_check(frame, location)

        def record(callback, **fields):
            if required and not fields['liveness_confirmed']:
                raise AssertionError('Required recovered verification was bypassed')
            return callback(**fields)

        recognizer = types.SimpleNamespace(known_count=2, usable_count=2, load_faces=lambda: None,
            liveness_checker=checker if required else None,
            liveness_policy=types.SimpleNamespace(update=verify, record=record),
            snapshot_known_faces=lambda: ([old_vector, new_vector], [1, 2], ['Old synthetic worker', 'New synthetic worker'], {1: 'old-server', 2: 'new-server'}))
        settings = types.SimpleNamespace(**{name: getattr(config, name) for name in dir(config) if name.isupper()})
        settings.LIVENESS_REQUIRED = required
        settings.DISPLAY_TIME_SUCCESS_SEC = 0
        settings.DISPLAY_TIME_SEC = 0
        settings.CLOCK_DEBOUNCE_MINUTES = 1
        database = types.SimpleNamespace(init_db=lambda: None,
            get_worker_by_id=lambda worker: {'id': worker, 'employee_id': str(worker), 'server_id': 'old-server' if worker == 1 else 'new-server'},
            was_recently_clocked=lambda *args: False, get_last_action=lambda *args: None,
            log_recognized_attendance=lambda **fields: writes.append(fields))
        web = types.SimpleNamespace(start_server=lambda: None, get_health_snapshot=lambda: dict(health),
            update_health=lambda **fields: health.update(fields), update_status=lambda **fields: statuses.append(fields), set_frame=lambda frame: None)

        def offline():
            raise RuntimeError('Synthetic offline mode; no network worker')

        namespace = {'config': settings, 'database': database, 'web_app': web, 'Camera': Camera,
            'logger': logging.getLogger(__name__), 'os': types.SimpleNamespace(makedirs=lambda *args, **kwargs: None),
            'require_kiosk_api_key': offline, 'require_kiosk_ui_key': lambda: None,
            'recognition_model_ready': lambda: True, 'FaceRecognizer': lambda: recognizer,
            'time': types.SimpleNamespace(time=lambda: clock[0], sleep=sleep),
            'threading': types.SimpleNamespace(Lock=threading.Lock, Thread=DetectorThread),
            'cv2': types.SimpleNamespace(resize=lambda frame, *args, **kwargs: frame),
            'fr': types.SimpleNamespace(face_locations=locations), 'embed_face': embedding,
            'FreshFaceMatcher': FreshFaceMatcher, 'np': np, 'datetime': datetime, 'timedelta': timedelta, 'timezone': timezone,
            'GOLD': 'gold', 'GREEN': 'green', 'RED': 'red', 'draw_box': lambda frame, *args: frame,
            'format_worker_display_id': lambda worker, worker_id: str(worker_id),
            'cosine_sim': lambda left, right: float(np.dot(left, right)), '_now_iso': lambda: 'synthetic-time',
            '_log_recognition_attempt': lambda result, decision: attempts.append((dict(result), decision))}
        if is_fresh_scan is not None:
            namespace['is_fresh_scan'] = is_fresh_scan
        if validate_kiosk_policy is not None:
            namespace.update(validate_kiosk_policy=validate_kiosk_policy, require_kiosk_action_type=require_kiosk_action_type)
        exec(compile(ast.Module(body=FUNCTIONS, type_ignores=[]), 'actual-camera-generation-main', 'exec'), namespace)
        try:
            namespace['run'](types.SimpleNamespace(server=None, kiosk_id=None, camera='usb'))
        finally:
            stopped.set()
            release.set()
            for detector in detectors:
                detector.thread.join(3)
        self.assertEqual(thread_errors, [])
        self.assertTrue(all(not detector.thread.is_alive() for detector in detectors))
        if expire:
            self.assertEqual(writes, [])
            self.assertTrue(any(decision == 'rejected_liveness_timeout' for _, decision in attempts))
            return
        self.assertEqual(recovery_checks, [('blank', 0), ('new-ready', 0)])
        self.assertEqual([fields['worker_id'] for fields in writes], [2])
        self.assertEqual(writes[0]['liveness_confirmed'], required)
        accepted = [result for result, decision in attempts if decision == 'accepted']
        self.assertEqual([result['camera_generation'] for result in accepted], [1])
        self.assertTrue(any(status.get('state') == 'ERROR' and status.get('liveness_confirmed') is False for status in statuses))
        if required:
            self.assertTrue(any(label.startswith('new-') for label in blinks))
            self.assertGreaterEqual(checker.reset.call_count, 3)

    def test_optional_verification_cannot_reuse_inflight_old_identity_after_blank_recovery(self):
        self.exercise_recovery(False)

    def test_required_verification_restarts_after_disconnect_and_requires_new_subject_blink(self):
        self.exercise_recovery(True)

    def test_expired_post_blink_result_cannot_write_before_the_deadline_guard(self):
        self.exercise_recovery(True, expire=True)


if __name__ == '__main__':
    unittest.main()
