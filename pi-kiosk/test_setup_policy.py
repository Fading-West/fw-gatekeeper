"""Synthetic configuration updates; never invokes the real installer."""
import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("update_local_config", Path(__file__).parent / "tools/update_local_config.py")
config_update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config_update)


class SetupPolicyTests(unittest.TestCase):
    def values(self):
        return {name: "synthetic 'quoted' \\\n unicode é" for name in config_update.MANAGED_NAMES} | {"KIOSK_TYPE": "entry"}

    def test_upgrade_preserves_operator_policy_and_round_trips_managed_values(self):
        old = 'LIVENESS_REQUIRED = True\nRECOGNITION_MATCH_THRESHOLD = 0.65\nDB_PATH = "custom.db"\nCAMERA_INDEX = 2\nKIOSK_NAME = "old"\n'
        source = config_update.updated_source(old, self.values())
        namespace = {}
        exec(compile(source, "synthetic_config", "exec"), {}, namespace)
        self.assertTrue(namespace["LIVENESS_REQUIRED"])
        self.assertEqual(namespace["RECOGNITION_MATCH_THRESHOLD"], .65)
        self.assertEqual(namespace["DB_PATH"], "custom.db")
        self.assertEqual(namespace["CAMERA_INDEX"], 2)
        for name, value in self.values().items():
            self.assertEqual(namespace[name], value)

    def test_never_executes_existing_configuration_during_update(self):
        source = config_update.updated_source('raise RuntimeError("must not execute")\nLIVENESS_REQUIRED = True\n', self.values())
        self.assertIn('raise RuntimeError', source)

    def test_managed_assignments_keep_their_order_before_dependent_policy(self):
        old = 'KIOSK_NAME = "old"\nMODEL_DIR = KIOSK_NAME + "/models"\nKIOSK_NAME = "old again"\nDB_PATH = KIOSK_NAME + "/attendance.db"\n'
        source = config_update.updated_source(old, self.values())
        namespace = {}
        exec(compile(source, "synthetic_config", "exec"), {}, namespace)
        self.assertEqual(namespace['MODEL_DIR'], self.values()['KIOSK_NAME'] + '/models')
        self.assertEqual(namespace['DB_PATH'], self.values()['KIOSK_NAME'] + '/attendance.db')

    def test_atomic_failure_retains_old_file_and_only_removes_own_temporary_file(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "config_local.py"
            original = 'LIVENESS_REQUIRED = True\n'
            path.write_text(original)
            other = Path(root) / "operator-evidence.txt"
            other.write_text("protected")
            with mock.patch.object(config_update.os, "replace", side_effect=OSError("interrupted")):
                with self.assertRaises(OSError):
                    config_update.update_config(path, self.values())
            self.assertEqual(path.read_text(), original)
            self.assertEqual(other.read_text(), "protected")
            self.assertEqual(sorted(p.name for p in Path(root).iterdir()), ["config_local.py", "operator-evidence.txt"])
            config_update.update_config(path, self.values())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertIn('LIVENESS_REQUIRED = True', path.read_text())

    def test_invalid_input_and_nonstandalone_assignments_preserve_configuration(self):
        for old in ['KIOSK_NAME = "unterminated', 'KIOSK_NAME = "old"; LIVENESS_REQUIRED = True', 'KIOSK_NAME = LIVENESS_REQUIRED = True']:
            with self.subTest(old=old), tempfile.TemporaryDirectory() as root:
                path = Path(root) / "config_local.py"
                path.write_text(old)
                with self.assertRaises(ValueError):
                    config_update.update_config(path, self.values())
                self.assertEqual(path.read_text(), old)
        values = self.values() | {"KIOSK_UI_KEY": ""}
        with self.assertRaises(ValueError):
            config_update.updated_source('', values)


if __name__ == "__main__":
    unittest.main()
