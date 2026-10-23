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
    # Compare commands, not indentation or spacing, so harmless reformatting passes.
    return [
        " ".join(line.split()) for line in source.splitlines()
        if "-m pip install" in line and not line.lstrip().startswith("#")
    ]


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
            # Only the commands matter; the prose may mention what not to do.
            commands = "".join(section.split("```")[1::2])
            # Pull as the owning kiosk user; a root pull leaves root-owned files.
            self.assertNotIn("sudo git pull", commands)
            self.assertIn("bash pi-kiosk/update.sh", commands)
            self.assertNotIn("systemctl restart", commands)

    def run_update(self, fail_lock=None, uid="1000", user="pi", kiosk_user=None,
                   fail_pull=False, replace_script=False):
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
                + (f'case "$*" in *{fail_lock}*) exit 9;; esac\n' if fail_lock else "")
            )
            sudo = stubs / "sudo"
            sudo.write_text('#!/bin/sh\nprintf "sudo %s\\n" "$*" >> "$TEST_LOG"\n')
            identity = stubs / "id"
            identity.write_text(
                f'#!/bin/sh\ncase "$1" in -u) echo {uid};; -un) echo {user};; esac\n'
            )
            git = stubs / "git"
            git.write_text(
                '#!/bin/sh\nprintf "git %s\n" "$*" >> "$TEST_LOG"\n'
                + ('exit 8\n' if fail_pull else "")
                + ('printf "invalid replacement script\n" > pi-kiosk/update.sh\n'
                   if replace_script else "")
            )
            for stub in (python, sudo, identity, git):
                stub.chmod(0o755)
            env = {**os.environ, "PATH": f"{stubs}:{os.environ['PATH']}", "TEST_LOG": str(log)}
            env.pop("KIOSK_USER", None)
            if kiosk_user is not None:
                env["KIOSK_USER"] = kiosk_user
            result = subprocess.run(
                ["bash", str(kiosk / "update.sh")], cwd=root,
                env=env,
                capture_output=True, text=True, check=False,
            )
            return result, log.read_text().splitlines() if log.exists() else []

    def test_installs_both_locks_before_restarting(self):
        result, calls = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [
            "git pull origin master",
            "python -m pip install --require-hashes -r requirements-build.lock",
            "python -m pip install --require-hashes --no-build-isolation -r requirements.lock",
            "sudo systemctl restart fw-gatekeeper-kiosk",
        ])

    def test_failed_install_does_not_restart(self):
        for lock in ("requirements-build.lock", "requirements.lock"):
            with self.subTest(lock=lock):
                result, calls = self.run_update(fail_lock=lock)
                self.assertEqual(result.returncode, 9)
                self.assertEqual(calls[0], "git pull origin master")
                self.assertIn(lock, calls[-1])
                self.assertFalse(any(call.startswith("sudo ") for call in calls))

    def test_failed_pull_does_not_install_or_restart(self):
        result, calls = self.run_update(fail_pull=True)
        self.assertEqual(result.returncode, 8)
        self.assertEqual(calls, ["git pull origin master"])

    def test_accepts_custom_kiosk_user(self):
        for kiosk_user in (None, "scanner"):
            with self.subTest(kiosk_user=kiosk_user):
                result, calls = self.run_update(user="scanner", kiosk_user=kiosk_user)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls[-1], "sudo systemctl restart fw-gatekeeper-kiosk")

    def test_refuses_a_different_explicit_kiosk_user(self):
        result, calls = self.run_update(kiosk_user="scanner")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Run update.sh as KIOSK_USER (scanner)", result.stderr)
        self.assertEqual(calls, [])

    def test_pull_can_replace_the_running_script(self):
        result, calls = self.run_update(replace_script=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[-1], "sudo systemctl restart fw-gatekeeper-kiosk")

    def test_refuses_root_before_touching_venv(self):
        result, calls = self.run_update(uid="0")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not with sudo or as root", result.stderr)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
