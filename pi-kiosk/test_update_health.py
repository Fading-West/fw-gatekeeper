"""Exercise the real scan loop's update health without camera/native models."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

import numpy as np
import app
import config


class UpdateHealthTests(unittest.TestCase):
    def test_health_identifies_the_process_and_starts_without_scan_progress(self):
        with mock.patch.dict(app._health, last_camera_frame=None, last_detection=None,
                             last_model_inference=None):
            snapshot = app.app.test_client().get('/health').get_json()
        self.assertEqual(snapshot['pid'], os.getpid())
        self.assertIsNone(snapshot['last_camera_frame'])
        self.assertIsNone(snapshot['last_detection'])
        self.assertIsNone(snapshot['last_model_inference'])

    def scan_without_faces(self, embedding, initially_ready=True, trial=True, pending=True):
        # Only the native detector/roster are substituted. The actual main loop,
        # Flask health state, and detection thread execute against synthetic frames.
        detector = mock.Mock(face_locations=mock.Mock(return_value=[]))
        roster = SimpleNamespace(known_count=1, usable_count=1, liveness_checker=None,
                                 load_faces=lambda: None)
        spec = importlib.util.spec_from_file_location('update_health_main', Path(__file__).with_name('main.py'))
        main = importlib.util.module_from_spec(spec)
        with mock.patch.dict(sys.modules, face_recognition=detector,
                             recognition=SimpleNamespace(FaceRecognizer=lambda: roster)):
            spec.loader.exec_module(main)
        completed = threading.Event()
        detector.face_locations.side_effect = lambda *_args, **_kwargs: (completed.set(), [])[1]
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        trial_state = Path(temporary.name) / 'pending.json'
        if pending:
            trial_state.touch()
        threads = []
        real_thread = threading.Thread
        real_sleep = time.sleep
        frame = np.zeros((64, 64, 3), dtype=np.uint8)
        captures = 0

        def start_thread(*args, **kwargs):
            thread = real_thread(*args, **kwargs)
            threads.append(thread)
            return thread

        def sleep(seconds):
            if threading.current_thread().name == 'face-detect' and completed.is_set():
                raise SystemExit(0)
            real_sleep(seconds)

        def infer(*args):
            completed.set()
            if isinstance(embedding, Exception):
                raise embedding
            return embedding

        def capture():
            nonlocal captures
            captures += 1
            if captures > 1:
                if not completed.wait(5):
                    raise AssertionError('No idle-door model probe')
                # Let the reporter complete before stopping the main loop.
                real_sleep(.05)
                raise KeyboardInterrupt
            return frame, frame

        camera = mock.Mock(capture=mock.Mock(side_effect=capture))
        with mock.patch.dict(app._health, last_camera_frame=None, last_detection=None,
                             last_model_inference=None), \
                mock.patch.dict(os.environ, KIOSK_UPDATE_TRIAL=str(trial_state) if trial else ''), \
                mock.patch.object(main, 'Camera', return_value=camera), \
                mock.patch.object(main, 'recognition_model_ready', return_value=initially_ready), \
                mock.patch.object(main, 'embed_face', side_effect=infer) as inference, \
                mock.patch.object(main, '_log_recognition_attempt') as attempt, \
                mock.patch.object(main.database, 'log_recognized_attendance') as attendance, \
                mock.patch.object(main, 'require_kiosk_api_key', side_effect=RuntimeError('offline test')), \
                mock.patch.object(main, 'require_kiosk_ui_key'), \
                mock.patch.multiple(main.os, makedirs=mock.DEFAULT, chmod=mock.DEFAULT), \
                mock.patch.object(main, 'ModelRecovery', return_value=SimpleNamespace(ready=True, start=lambda: None, stop=lambda: None)), \
                mock.patch.multiple(main.database, init_db=mock.DEFAULT, start_history_migration=mock.DEFAULT, stop_history_migration=mock.DEFAULT), \
                mock.patch.object(app, 'start_server'), \
                mock.patch.object(app, 'set_frame'), \
                mock.patch.object(main.threading, 'Thread', side_effect=start_thread), \
                mock.patch.object(main.time, 'sleep', side_effect=sleep), \
                mock.patch.object(config, 'LIVENESS_REQUIRED', False):
            try:
                main.run(SimpleNamespace(server=None, kiosk_id=None, camera='auto'))
                snapshot = app.app.test_client().get('/health').get_json()
            finally:
                completed.set()
                for thread in threads:
                    thread.join(timeout=5)
                    self.assertFalse(thread.is_alive())
            attempt.assert_not_called()
            attendance.assert_not_called()
            if not trial or not pending:
                inference.assert_not_called()
        self.assertIsNotNone(snapshot['last_camera_frame'])
        self.assertIsNotNone(snapshot['last_detection'])
        return snapshot

    def test_idle_door_proves_inference_and_recovers_startup_model_fault(self):
        snapshot = self.scan_without_faces(np.ones(512), initially_ready=False)
        self.assertEqual(snapshot['status'], 'ok')
        self.assertTrue(snapshot['model_ok'])
        self.assertIsNotNone(snapshot['last_model_inference'])

    def test_normal_idle_kiosk_and_completed_trial_do_not_probe(self):
        for trial, pending in ((False, True), (True, False)):
            with self.subTest(trial=trial, pending=pending):
                snapshot = self.scan_without_faces(np.ones(512), trial=trial, pending=pending)
                self.assertEqual(snapshot['status'], 'ok')
                self.assertIsNone(snapshot['last_model_inference'])

    def test_loaded_model_with_broken_or_invalid_inference_stays_degraded(self):
        for embedding in (RuntimeError('ONNX run failed'), np.full(512, np.nan), np.zeros(512), np.ones(128)):
            with self.subTest(embedding=type(embedding).__name__):
                snapshot = self.scan_without_faces(embedding)
                self.assertEqual(snapshot['status'], 'degraded')
                self.assertFalse(snapshot['model_ok'])
                self.assertIsNone(snapshot['last_model_inference'])


if __name__ == '__main__':
    unittest.main()
