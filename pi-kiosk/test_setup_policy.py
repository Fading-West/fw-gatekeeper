"""Synthetic configuration updates; never invokes the real installer."""
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("update_local_config", Path(__file__).parent / "tools/update_local_config.py")
config_update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config_update)


class SetupPolicyTests(unittest.TestCase):
    def values(self):
        return {name: "synthetic 'quoted' \\\n unicode é" for name in config_update.MANAGED_NAMES} | {"KIOSK_TYPE": "entry"}

    def run_updater(self, directory, values=None):
        return subprocess.run(
            [sys.executable, str(Path(config_update.__file__).resolve())],
            cwd=directory, env=os.environ | (self.values() if values is None else values),
            capture_output=True, text=True, timeout=10,
        )

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

    def test_cli_rejects_unsupported_managed_bindings_without_changing_files(self):
        mutations = [
            'if True:\n    KIOSK_TYPE = "exit"\n',
            'if True:\n    KIOSK_TYPE: str = "exit"\n',
            'KIOSK_API_KEY += "-suffix"\n',
            'del KIOSK_TYPE\n',
            'for KIOSK_ID in ["other"]:\n    pass\n',
            'with open("unused") as KIOSK_API_KEY:\n    pass\n',
            'if (KIOSK_TYPE := "exit"):\n    pass\n',
            'import os as KIOSK_API_KEY\n',
            'from os import name as KIOSK_TYPE\n',
            'from os import *\n',
            'def KIOSK_TYPE():\n    return "exit"\n',
            'def policy(KIOSK_TYPE):\n    return KIOSK_TYPE\n',
            'class KIOSK_TYPE:\n    pass\n',
            'try:\n    pass\nexcept Exception as KIOSK_API_KEY:\n    pass\n',
            'match "exit":\n    case KIOSK_TYPE:\n        pass\n',
            'match []:\n    case [*KIOSK_ID]:\n        pass\n',
            'match {}:\n    case {**KIOSK_API_KEY}:\n        pass\n',
            'KIOSK_TYPE, CAMERA_INDEX = "exit", 2\n',
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as root:
                path = Path(root) / "config_local.py"
                original = ('KIOSK_TYPE = "entry"\n'
                            'KIOSK_API_KEY = "synthetic-secret-must-stay-private"\n'
                            'LIVENESS_REQUIRED = True\n' + mutation).encode()
                path.write_bytes(original)
                evidence = Path(root) / "operator-evidence.txt"
                evidence.write_text("protected")
                result = self.run_updater(root)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertNotIn("synthetic-secret-must-stay-private", result.stderr)
                self.assertEqual(path.read_bytes(), original)
                self.assertEqual(evidence.read_text(), "protected")
                self.assertEqual(sorted(p.name for p in Path(root).iterdir()),
                                 ["config_local.py", "operator-evidence.txt"])

    def test_cli_preserves_unrelated_code_and_compiled_settings_match_new_inputs(self):
        old = ('"""Operator policy docstring."""\nfrom pathlib import Path\n'
               + ''.join(f'{name} = "old"\n' for name in config_update.MANAGED_NAMES)
               + 'if KIOSK_TYPE == "exit":\n    LIVENESS_REQUIRED = True\n'
                 'else:\n    LIVENESS_REQUIRED = False\n'
                 'MODEL_DIR = Path(KIOSK_NAME) / "models"\n')
        values = self.values() | {"KIOSK_TYPE": "exit"}
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "config_local.py"
            path.write_text(old)
            result = self.run_updater(root, values)
            self.assertEqual(result.returncode, 0, result.stderr)
            source = path.read_text()
            namespace = {}
            exec(compile(source, "synthetic_config", "exec"), namespace)
            for name, value in values.items():
                self.assertEqual(namespace[name], value)
            self.assertEqual(namespace["__doc__"], "Operator policy docstring.")
            self.assertTrue(namespace["LIVENESS_REQUIRED"])
            self.assertEqual(namespace["MODEL_DIR"], Path(values["KIOSK_NAME"]) / "models")
            self.assertIn('from pathlib import Path\n', source)
            self.assertIn('if KIOSK_TYPE == "exit":\n    LIVENESS_REQUIRED = True\n', source)


if __name__ == "__main__":
    unittest.main()
