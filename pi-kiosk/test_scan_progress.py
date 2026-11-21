"""Read-time scan progress, shared endpoint/wire health, and config overrides."""
from pathlib import Path
import runpy
import sys
from types import ModuleType
import unittest
from unittest import mock

import app
import config
import sync


class ScanProgressTests(unittest.TestCase):
    def snapshot(self, **overrides):
        return dict(camera_ok=True, model_ok=True, scan_loop_started_at=100,
                    last_camera_frame=None, last_detection_cycle=None,
                    degraded_reason=None, **overrides)

    def derive(self, snapshot, now=131):
        before = dict(snapshot)
        result = app.derive_scan_progress(snapshot, now, 15, 30)
        self.assertEqual(snapshot, before, 'derivation must not mutate its input')
        return result

    def test_startup_existing_faults_and_exact_boundaries(self):
        for fields, now in [({'scan_loop_started_at': None}, 999),
                            ({'camera_ok': False}, 999), ({}, 115),
                            ({'last_camera_frame': 130}, 130),
                            ({'last_camera_frame': 131}, 130),
                            ({'last_camera_frame': 131, 'model_ok': False}, 131)]:
            source = self.snapshot()
            source.update(fields)
            with self.subTest(fields=fields, now=now):
                self.assertEqual(self.derive(source, now), source)

    def test_capture_takes_priority_and_recovers_without_overwriting_flags(self):
        source = self.snapshot()
        stalled = self.derive(source)
        self.assertEqual((stalled['camera_ok'], stalled['model_ok'], stalled['degraded_reason']),
                         (False, True, 'camera_stalled'))
        source.update(last_camera_frame=131, last_detection_cycle=131)
        self.assertEqual(self.derive(source), source)
        source.update(model_ok=False, last_camera_frame=100)
        self.assertEqual(self.derive(source)['degraded_reason'], 'camera_stalled')

    def test_recognition_progress_is_cycle_not_face_or_inference_progress(self):
        source = self.snapshot()
        source['last_camera_frame'] = 131
        stalled = self.derive(source)
        self.assertEqual((stalled['camera_ok'], stalled['model_ok'], stalled['degraded_reason']),
                         (True, False, 'recognition_stalled'))
        source['last_detection_cycle'] = 131
        self.assertEqual(self.derive(source), source)

    def test_reasons_are_preserved_and_deduplicated(self):
        source = self.snapshot()
        source['degraded_reason'] = 'kiosk_policy_error,no_workers_synced,clock_unsynchronized,camera_stalled'
        self.assertEqual(self.derive(source)['degraded_reason'], source['degraded_reason'])

    def test_shared_health_status_and_wire_derive_and_recover(self):
        with mock.patch.dict(app._health, self.snapshot()), \
                mock.patch.object(app, 'get_clock_synchronized', return_value=False), \
                mock.patch.object(app.time, 'monotonic', return_value=131), \
                mock.patch.object(app.database, 'list_workers', return_value=[]):
            health = app.app.test_client().get('/health').get_json()
            self.assertEqual(health['status'], 'degraded')
            self.assertEqual(health['degraded_reason'], 'clock_unsynchronized,camera_stalled')
            self.assertFalse(app.get_status_snapshot()['health']['camera_ok'])
            self.assertEqual(sync._health_params(health)['camera_ok'], '0')
            self.assertTrue(app._health['camera_ok'])
            self.assertIsNone(app._health['degraded_reason'])
            app.update_health(last_camera_frame=131, last_detection_cycle=131)
            self.assertTrue(app.get_health_snapshot()['camera_ok'])
            self.assertEqual(app.get_health_snapshot()['degraded_reason'], 'clock_unsynchronized')
            self.assertEqual(app.get_status_snapshot()['display_time_success_sec'], config.DISPLAY_TIME_SUCCESS_SEC)
            app.update_health(last_detection_cycle=100)
            recognition = app.get_health_snapshot()
            self.assertEqual(recognition['degraded_reason'], 'clock_unsynchronized,recognition_stalled')
            self.assertEqual(sync._health_params(recognition)['model_ok'], '0')

    def test_threshold_overrides_validate_after_config_local_and_warn(self):
        for field, default in [('CAMERA_STALL_SECONDS', 15), ('RECOGNITION_STALL_SECONDS', 30)]:
            for value in [float('nan'), float('inf'), -1, 0, True, False, '15', None, 10 ** 1000, 1.5, 40]:
                local = ModuleType('config_local')
                setattr(local, field, value)
                valid = value in (1.5, 40)
                with self.subTest(field=field, value=value), \
                        mock.patch.dict(sys.modules, config_local=local), \
                        mock.patch('logging.Logger.warning') as warning:
                    result = runpy.run_path(str(Path(__file__).with_name('config.py')))
                    self.assertEqual(result[field], value if valid else default)
                    self.assertEqual(warning.call_count, 0 if valid else 1)


if __name__ == '__main__':
    unittest.main()
