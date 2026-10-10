"""Keep the kiosk update procedure identical to setup.sh's locked install."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

KIOSK_DIR = Path(__file__).parent
REPO_DIR = KIOSK_DIR.parent


def pip_lines(source):
    return [line for line in source.splitlines() if "-m pip install" in line and not line.lstrip().startswith("#")]


class UpdateScriptTests(unittest.TestCase):
    def test_installs_match_setup_verbatim(self):
        setup = pip_lines((KIOSK_DIR / "setup.sh").read_text(encoding="utf-8"))
        update = pip_lines((KIOSK_DIR / "update.sh").read_text(encoding="utf-8"))
        self.assertEqual(len(setup), 2)
        self.assertEqual(update, setup)

    def test_both_readme_update_procedures_use_the_script(self):
        readme = (REPO_DIR / "README.md").read_text(encoding="utf-8")
        single = readme.split("### Update kiosk software", 1)[1].split("### Update all 4 kiosks at once", 1)
        bulk = single[1].split("\n### ", 1)[0]
        for section in (single[0], bulk):
            self.assertIn("sudo git pull origin master", section)
            self.assertIn("bash pi-kiosk/update.sh", section)
            self.assertNotIn("systemctl restart", section)

    def run_update(self, fail_build_lock=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            kiosk = root / "pi-kiosk"
            (kiosk / "venv" / "bin").mkdir(parents=True)
            stubs = root / "stubs"
            stubs.mkdir()
            shutil.copy(KIOSK_DIR / "update.sh", kiosk / "update.sh")
            log = root / "calls.log"
            python = kiosk / "venv" / "bin" / "python"
            python.write_text(
                '#!/bin/sh\nprintf "python %s\\n" "$*" >> "$TEST_LOG"\n'
                + ('case "$*" in *requirements-build.lock*) exit 9;; esac\n' if fail_build_lock else "")
            )
            sudo = stubs / "sudo"
            sudo.write_text('#!/bin/sh\nprintf "sudo %s\\n" "$*" >> "$TEST_LOG"\n')
            for stub in (python, sudo):
                stub.chmod(0o755)
            result = subprocess.run(
                ["bash", str(kiosk / "update.sh")], cwd=root,
                env={**os.environ, "PATH": f"{stubs}:{os.environ['PATH']}", "TEST_LOG": str(log)},
                capture_output=True, text=True, check=False,
            )
            return result, log.read_text().splitlines() if log.exists() else []

    def test_installs_both_locks_before_restarting(self):
        result, calls = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [
            "python -m pip install --require-hashes -r requirements-build.lock",
            "python -m pip install --require-hashes --no-build-isolation -r requirements.lock",
            "sudo systemctl restart fw-gatekeeper-kiosk",
        ])

    def test_failed_install_does_not_restart(self):
        result, calls = self.run_update(fail_build_lock=True)
        self.assertEqual(result.returncode, 9)
        self.assertEqual(calls, ["python -m pip install --require-hashes -r requirements-build.lock"])


if __name__ == "__main__":
    unittest.main()
