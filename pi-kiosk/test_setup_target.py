"""Exercise installer target checks without touching system packages."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class SetupTargetTests(unittest.TestCase):
    def run_setup(self, machine, version):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = {
                'id': '#!/bin/sh\nprintf "0\\n"\n',
                'python3': (
                    f'#!{sys.executable}\n'
                    'import platform, sys\n'
                    f'platform.machine = lambda: {machine!r}\n'
                    f'sys.version_info = {version!r}\n'
                    'exec(sys.stdin.read())\n'
                ),
                # Reaching apt proves target acceptance; stop before any effects.
                'apt-get': '#!/bin/sh\nprintf "called\\n" > "$TEST_APT_LOG"\nexit 72\n',
            }
            for name, source in commands.items():
                executable = root / name
                executable.write_text(source)
                executable.chmod(0o755)
            apt_log = root / 'apt.log'
            result = subprocess.run(
                ['bash', str(Path(__file__).with_name('setup.sh'))],
                env={**os.environ, 'PATH': f'{directory}:{os.environ["PATH"]}',
                     'KIOSK_USER': 'installer-test', 'KIOSK_API_KEY': 'test-only',
                     'KIOSK_UI_KEY': 'test-only', 'KIOSK_SUPERVISOR_PIN': 'test-only',
                     'TEST_APT_LOG': str(apt_log)},
                capture_output=True, text=True, check=False,
            )
            return result, apt_log.exists()

    def test_unsupported_target_exits_before_system_changes(self):
        for machine, version in [('x86_64', (3, 11)), ('aarch64', (3, 13)), ('armv7l', (3, 11))]:
            with self.subTest(machine=machine, version=version):
                result, apt_called = self.run_setup(machine, version)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn('Bookworm (64-bit), Python 3.11', result.stderr)
                self.assertFalse(apt_called)

    def test_source_build_subprocess_uses_locked_venv_cmake(self):
        source = Path(__file__).with_name('setup.sh').read_text()
        command = next(line for line in source.splitlines() if line.endswith('-r requirements.lock'))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            venv_bin = root / 'venv' / 'bin'
            system_bin = root / 'system-bin'
            venv_bin.mkdir(parents=True)
            system_bin.mkdir()
            for executable, body in [
                # Emulate pip's dlib build spawning cmake by name.
                (venv_bin / 'python', '#!/bin/sh\ncmake --version\n'),
                (venv_bin / 'cmake', '#!/bin/sh\nprintf "locked-cmake\\n"\n'),
                (system_bin / 'cmake', '#!/bin/sh\nprintf "system-cmake\\n"\n'),
            ]:
                executable.write_text(body)
                executable.chmod(0o755)
            result = subprocess.run(
                ['bash', '-c', command], cwd=root,
                env={**os.environ, 'PATH': f'{system_bin}:{os.environ["PATH"]}'},
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'locked-cmake')

    def test_supported_target_can_proceed_to_package_installation(self):
        result, apt_called = self.run_setup('aarch64', (3, 11))
        self.assertEqual(result.returncode, 72, result.stderr)
        self.assertTrue(apt_called)


if __name__ == '__main__':
    unittest.main()
