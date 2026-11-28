"""Exercise the installed updater's no-op path without staging or systemd."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class CurrentRevisionUpdateTests(unittest.TestCase):
    def run_update(self, *, committed, newer):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            git = root / ".git"
            git.mkdir()
            kiosk = root / "pi-kiosk"
            (kiosk / "venv").mkdir(parents=True)
            active = root / "active"
            (active / "venv").mkdir(parents=True)
            revision = "b" * 40
            current = git / "kiosk-current.json"
            record = f'{{"directory": "{active}", "revision": "{revision}"}}'
            if committed:
                current.write_text(record)
            (git / "kiosk-arguments.json").touch()
            (git / "kiosk-launch.py").write_text(
                "import json, sys\n"
                "from pathlib import Path\n"
                "command, repo, *rest = sys.argv[1:]\n"
                "record = Path(repo) / '.git/kiosk-current.json'\n"
                "current = json.loads(record.read_text()) if record.exists() else "
                "dict(directory=str(Path(repo) / 'pi-kiosk'))\n"
                "if command == 'current': print(current['directory'])\n"
                "elif command == 'revision': print(current.get('revision', rest[0]))\n"
                "elif command not in ('retire', 'cancel'): sys.exit(f'unexpected launcher command: {command}')\n"
            )
            bin_dir = root / "bin"
            bin_dir.mkdir()
            # The source checkout is intentionally older than the deployed SHA.
            # Only the current release, not checkout HEAD, determines the no-op.
            source_revision = "a" * 40 if committed else revision
            target = "c" * 40 if newer else revision
            for name, script in {
                "git": (
                    'case "$*" in\n'
                    '  "status --porcelain --untracked-files=no"|"fetch origin master"|merge-base*) exit 0 ;;\n'
                    '  "rev-parse HEAD") printf "%s\\n" "$TEST_SOURCE" ;;\n'
                    '  "rev-parse FETCH_HEAD") printf "%s\\n" "$TEST_REVISION" ;;\n'
                    '  *) exit 90 ;;\n'
                    'esac\n'
                ),
                "id": 'if [ "$1" = -u ]; then echo 1000; else echo kiosk-test; fi\n',
                "systemctl": 'case "$1" in show) echo kiosk-test ;; is-active) exit 0 ;; *) exit 91 ;; esac\n',
                "mktemp": 'echo "Reached candidate staging" >&2\nexit 92\n',
                "sudo": 'echo "Attempted to change the kiosk service" >&2\nexit 93\n',
            }.items():
                path = bin_dir / name
                path.write_text("#!/bin/sh\n" + script)
                path.chmod(0o755)
            result = subprocess.run(
                ["bash", str(Path(__file__).with_name("update.sh")), str(root)],
                env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "TEST_REVISION": target,
                     "TEST_SOURCE": source_revision},
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(current.read_text() if current.exists() else None, record if committed else None)
            self.assertFalse((git / "kiosk-pending.json").exists())
            return result

    def test_current_release_does_not_stage_or_restart(self):
        result = self.run_update(committed=True, newer=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Kiosk is already running", result.stdout)

    def test_unmigrated_or_older_release_still_reaches_staging(self):
        for committed, newer in ((False, False), (True, True)):
            with self.subTest(committed=committed, newer=newer):
                result = self.run_update(committed=committed, newer=newer)
                self.assertEqual(result.returncode, 92, result.stdout + result.stderr)
                self.assertIn("Reached candidate staging", result.stderr)


if __name__ == "__main__":
    unittest.main()
