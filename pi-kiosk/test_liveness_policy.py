"""Required liveness must guard attendance through model failure and recovery."""
import unittest
from unittest import mock
from liveness_policy import LivenessPolicy, LivenessVerificationRequired


class RequiredLivenessTests(unittest.TestCase):
    def test_optional_default_does_not_load_predictor_and_allows_unverified_clock(self):
        loader = mock.Mock()
        policy = LivenessPolicy(False, loader)
        self.assertIsNone(policy.refresh())
        recorder = mock.Mock(return_value=17)
        self.assertEqual(policy.record(recorder, worker_id=1), 17)
        recorder.assert_called_once_with(worker_id=1, liveness_confirmed=False)
        loader.assert_not_called()

    def test_missing_and_corrupt_predictor_block_even_stale_confirmed_write(self):
        for failure in (FileNotFoundError('missing predictor'), RuntimeError('corrupt predictor')):
            with self.subTest(failure=failure):
                policy = LivenessPolicy(True, mock.Mock(side_effect=failure))
                self.assertIsNone(policy.refresh())
                recorder = mock.Mock()
                for confirmed in (False, True):
                    with self.assertRaises(LivenessVerificationRequired):
                        policy.record(recorder, worker_id=1, liveness_confirmed=confirmed)
                recorder.assert_not_called()

    def test_missing_model_retries_on_schedule_and_requires_new_blink_after_recovery(self):
        now = [0.]
        checker = mock.Mock()
        loader = mock.Mock(side_effect=[FileNotFoundError('missing predictor'), checker])
        policy = LivenessPolicy(True, loader, clock=lambda: now[0])
        policy.refresh()
        now[0] = 29.
        self.assertIsNone(policy.refresh())
        self.assertEqual(loader.call_count, 1)
        now[0] = 30.
        self.assertIs(policy.refresh(), checker)
        recorder = mock.Mock(return_value=23)
        with self.assertRaises(LivenessVerificationRequired):
            policy.record(recorder)
        self.assertEqual(policy.record(recorder, liveness_confirmed=True), 23)
        recorder.assert_called_once_with(liveness_confirmed=True)

    def test_runtime_failure_invalidates_checker_and_prevents_record_until_reloaded(self):
        now = [0.]
        broken = mock.Mock(update=mock.Mock(side_effect=RuntimeError('predictor failed')))
        recovered = mock.Mock(update=mock.Mock(return_value=True))
        loader = mock.Mock(side_effect=[broken, recovered])
        policy = LivenessPolicy(True, loader, clock=lambda: now[0])
        self.assertIs(policy.refresh(), broken)
        self.assertFalse(policy.update('frame', 'box', frame_check=lambda *_: True))
        self.assertIsNone(policy.checker)
        recorder = mock.Mock()
        with self.assertRaises(LivenessVerificationRequired):
            policy.record(recorder, liveness_confirmed=True)
        recorder.assert_not_called()
        now[0] = 30.
        self.assertIs(policy.refresh(), recovered)
        self.assertTrue(policy.update('new-frame', 'new-box', frame_check=lambda *_: True))
        policy.record(recorder, liveness_confirmed=True)
        recorder.assert_called_once()

    def test_predictor_reports_internal_failure_without_raising(self):
        checker = mock.Mock(update=mock.Mock(return_value=False), failed=True)
        policy = LivenessPolicy(True, lambda: checker)
        policy.refresh()
        self.assertFalse(policy.update('frame', 'box', frame_check=lambda *_: True))
        self.assertIsNone(policy.checker)
        with self.assertRaises(LivenessVerificationRequired):
            policy.record(mock.Mock(), liveness_confirmed=True)

    def test_main_write_path_uses_gate_and_displays_actionable_unavailable_state(self):
        from pathlib import Path
        source = Path(__file__).with_name('main.py').read_text()
        self.assertIn('recognizer.liveness_policy.record(\n                database.log_attendance,', source)
        self.assertIn('if config.LIVENESS_REQUIRED and liveness is None:', source)
        self.assertIn('Blink verification unavailable - please ask your supervisor', source)
        self.assertIn('active_liveness = recognizer.liveness_checker', source)
        self.assertIn('return "liveness_required_unavailable"', source)
        self.assertIn('startup_degraded = "liveness_required_unavailable"', source)
        template = Path(__file__).with_name('templates').joinpath('index.html').read_text()
        self.assertIn('Blink verification unavailable - automatic scans paused', template)
        self.assertNotIn('scans recorded unverified', template)


if __name__ == '__main__':
    unittest.main()
