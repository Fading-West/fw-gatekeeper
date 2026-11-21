"""Supervisor unlocks expire by elapsed time, independent of clock corrections."""
import unittest
from unittest import mock

import config
import kiosk_ui_auth as auth


class SupervisorSessionClockTests(unittest.TestCase):
    def setUp(self):
        for name, value in (("_supervisor_sessions", {}), ("_supervisor_unlocks", {}),
                            ("_cancelled_supervisor_unlocks", set())):
            patcher = mock.patch.object(auth, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name, value in (("KIOSK_UI_KEY", "synthetic-ui"), ("KIOSK_SUPERVISOR_PIN", "synthetic-pin")):
            patcher = mock.patch.object(config, name, value, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.wall = mock.patch.object(auth.time, "time", return_value=1000).start()
        self.elapsed = mock.patch.object(auth.time, "monotonic", return_value=100).start()
        self.addCleanup(mock.patch.stopall)

    def valid(self, token):
        return auth.has_valid_supervisor_credential(session_token=token)

    def test_expired_token_does_not_revive_when_clock_moves_back(self):
        token = auth.supervisor_session_token()
        self.wall.return_value = 1301
        self.elapsed.return_value = 401
        self.assertFalse(self.valid(token))
        self.wall.return_value = 1001
        self.assertFalse(self.valid(token))

    def test_backward_correction_does_not_invalidate_a_fresh_unlock(self):
        token = auth.supervisor_session_token()
        self.wall.return_value = 100
        self.elapsed.return_value = 101
        self.assertTrue(self.valid(token))
        self.elapsed.return_value = 401
        self.assertFalse(self.valid(token))

    def test_forward_correction_does_not_shorten_the_unlock(self):
        token = auth.supervisor_session_token(unlock_request_id="synthetic-unlock")
        self.wall.return_value = 10000
        self.elapsed.return_value = 101
        self.assertTrue(self.valid(token))
        self.assertEqual(auth.supervisor_session_token(unlock_request_id="synthetic-unlock"), token)
        self.elapsed.return_value = 401
        self.assertFalse(self.valid(token))
        replacement = auth.supervisor_session_token(unlock_request_id="synthetic-unlock")
        self.assertNotEqual(replacement, token)
        self.assertTrue(self.valid(replacement))
        self.assertFalse(self.valid(token))


if __name__ == "__main__":
    unittest.main()
