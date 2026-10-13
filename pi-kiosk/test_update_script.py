"""Exercise updates against real local Git repos and stub only machine services/pip."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

KIOSK_DIR = Path(__file__).parent
REPO_DIR = KIOSK_DIR.parent


def pip_lines(source):
    return [
        " ".join(line.split()) for line in source.splitlines()
        if "-m pip install" in line and not line.lstrip().startswith("#")
    ]


class UpdateScriptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.upstream = self.root / "upstream"
        self.repo = self.root / "installed kiosk with spaces"
        self.upstream.mkdir()
        self.git(self.upstream, "init", "-b", "master")
        self.git(self.upstream, "config", "user.name", "Update Test")
        self.git(self.upstream, "config", "user.email", "test@example.invalid")
        kiosk = self.upstream / "pi-kiosk"
        kiosk.mkdir()
        for name in ("update.sh", "requirements-build.lock", "requirements.lock"):
            (kiosk / name).write_text((KIOSK_DIR / name).read_text())
        (self.upstream / ".gitignore").write_text((REPO_DIR / ".gitignore").read_text())
        (kiosk / "main.py").write_text("old code\n")
        self.git(self.upstream, "add", ".")
        self.git(self.upstream, "commit", "-m", "old installation")
        self.old_head = self.git(self.upstream, "rev-parse", "HEAD")
        self.git(self.root, "clone", str(self.upstream), str(self.repo))
        self.kiosk = self.repo / "pi-kiosk"
        (self.kiosk / "venv" / "bin").mkdir(parents=True)
        (self.kiosk / "venv" / "old-environment").write_text("keep me")
        (self.kiosk / "config_local.py").write_text("secret config\n")
        (self.kiosk / "data").mkdir()
        (self.kiosk / "data" / "attendance.db").write_text("offline scans\n")
        (kiosk / "main.py").write_text("new code\n")
        for name in ("requirements-build.lock", "requirements.lock"):
            (kiosk / name).write_text(f"target {name}\n")
        self.git(self.upstream, "add", ".")
        self.git(self.upstream, "commit", "-m", "new release")
        self.target = self.git(self.upstream, "rev-parse", "HEAD")
        self.log = self.root / "calls.log"
        self.state_file = self.root / "services.json"
        self.state_file.write_text(json.dumps({"fw-gatekeeper-kiosk": True,
                                              "fw-gatekeeper-watchdog.timer": True}))
        stubs = self.root / "stubs"
        stubs.mkdir()
        self.env = {**os.environ, "PATH": f"{stubs}:{os.environ['PATH']}",
                    "TEST_LOG": str(self.log), "TEST_REPO": str(self.repo),
                    "TEST_STATE": str(self.state_file), "TEST_FAIL": ""}
        self.stub(stubs / "id", '#!/bin/sh\necho "${TEST_UID:-1000}"\n')
        self.stub(stubs / "sudo", '#!/bin/sh\nexec "$@"\n')
        pip_source = f'#!{sys.executable}\n' + '''import os, pathlib, sys
root = pathlib.Path(os.environ["TEST_REPO"])
assert (root / "pi-kiosk/main.py").read_text() == os.environ.get("TEST_OLD_CODE", "old code\\n")
lock = sys.argv[-1]
assert pathlib.Path(lock).read_text() == f"target {lock}\\n"
with open(os.environ["TEST_LOG"], "a") as log:
    log.write("python " + " ".join(sys.argv[1:]) + "\\n")
# Model pip changing some packages before a subsequent failure.
pathlib.Path("venv/partially-installed").touch()
if os.environ["TEST_FAIL"] == lock:
    sys.exit(9)
'''
        self.stub(stubs / "python3", f'#!{sys.executable}\n' +
                  'import pathlib, sys\nassert sys.argv[1:] == ["-m", "venv", "venv", "--system-site-packages"]\n' +
                  'path = pathlib.Path("venv/bin/python")\npath.parent.mkdir(parents=True)\n' +
                  f'path.write_text({pip_source!r})\npath.chmod(0o755)\n')
        self.stub(stubs / "systemctl", f'#!{sys.executable}\n' + '''import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ["TEST_LOG"], "a") as log:
    log.write("systemctl " + " ".join(args) + "\\n")
path = pathlib.Path(os.environ["TEST_STATE"])
state = json.loads(path.read_text())
command = args[0]
if command == "is-active":
    if os.environ["TEST_FAIL"] == "active" and pathlib.Path(os.environ["TEST_REPO"], "pi-kiosk/venv").is_symlink():
        sys.exit(3)
    sys.exit(0 if state.get(args[-1], False) else 3)
if command == "restart" and os.environ["TEST_FAIL"] == "restart":
    sys.exit(7)
for service in args[1:]:
    state[service] = command != "stop"
path.write_text(json.dumps(state))
''')

    @staticmethod
    def stub(path, source):
        path.write_text(source)
        path.chmod(0o755)

    @staticmethod
    def git(directory, *args):
        return subprocess.run(["git", "-C", str(directory), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def run_update(self, failure="", uid="1000", script=None):
        command = ["bash", str(script or self.kiosk / "update.sh")]
        if script is not None:
            command.append(str(self.repo))
        result = subprocess.run(command, cwd=self.root,
                                env={**self.env, "TEST_FAIL": failure, "TEST_UID": uid},
                                capture_output=True, text=True, check=False)
        calls = self.log.read_text().splitlines() if self.log.exists() else []
        # Updates and rollback must preserve device credentials and offline scans.
        self.assertEqual((self.kiosk / "config_local.py").read_text(), "secret config\n")
        self.assertEqual((self.kiosk / "data/attendance.db").read_text(), "offline scans\n")
        return result, calls

    def assert_old_installation(self):
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.old_head)
        self.assertTrue((self.kiosk / "venv/old-environment").exists())
        self.assertFalse((self.kiosk / "venv/partially-installed").exists())
        self.assertFalse((self.kiosk / ".venv-before-update").exists())
        releases = list((self.kiosk / ".venv-releases").glob("release.*"))
        self.assertEqual(len(releases), 1 if (self.kiosk / "venv").is_symlink() else 0)
        state = json.loads(self.state_file.read_text())
        self.assertTrue(state["fw-gatekeeper-kiosk"])
        self.assertTrue(state["fw-gatekeeper-watchdog.timer"])

    def test_installs_match_setup_verbatim(self):
        self.assertEqual(pip_lines((KIOSK_DIR / "setup.sh").read_text()),
                         pip_lines((KIOSK_DIR / "update.sh").read_text()))

    def test_readmes_use_only_shared_update_procedure(self):
        readme = (REPO_DIR / "README.md").read_text()
        single, bulk = readme.split("### Update kiosk software", 1)[1].split("### Update all 4 kiosks at once", 1)
        for section in (single, bulk.split("\n### ", 1)[0]):
            commands = "".join(section.split("```")[1::2])
            self.assertIn("bash pi-kiosk/update.sh", commands)
            self.assertNotIn("git pull", commands)
            self.assertNotIn("systemctl restart", commands)

    def test_stages_both_locks_before_service_cutover(self):
        result, calls = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[:2], [
            "python -m pip install --require-hashes -r requirements-build.lock",
            "python -m pip install --require-hashes --no-build-isolation -r requirements.lock",
        ])
        self.assertLess(calls.index("systemctl stop fw-gatekeeper-watchdog.timer fw-gatekeeper-watchdog.service"),
                        calls.index("systemctl stop fw-gatekeeper-kiosk"))
        self.assertIn("systemctl restart fw-gatekeeper-kiosk", calls)
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.target)
        self.assertTrue((self.kiosk / "venv").is_symlink())
        self.assertTrue((self.kiosk / "venv/bin/python").exists())
        self.assertFalse((self.kiosk / ".venv-before-update").exists())
        state = json.loads(self.state_file.read_text())
        self.assertTrue(state["fw-gatekeeper-kiosk"])
        self.assertTrue(state["fw-gatekeeper-watchdog.timer"])

    def test_either_failed_install_leaves_code_venv_and_services_untouched(self):
        for lock in ("requirements-build.lock", "requirements.lock"):
            with self.subTest(lock=lock):
                result, calls = self.run_update(failure=lock)
                self.assertEqual(result.returncode, 9, result.stderr)
                self.assertFalse(any("systemctl" in call for call in calls))
                self.assert_old_installation()

    def test_failed_restart_restores_old_code_and_venv(self):
        result, calls = self.run_update(failure="restart")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertIn("systemctl start fw-gatekeeper-kiosk", calls)
        self.assert_old_installation()

    def test_inactive_new_service_rolls_back(self):
        result, _ = self.run_update(failure="active")
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assert_old_installation()

    def test_refuses_root_before_touching_installation(self):
        result, calls = self.run_update(uid="0")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not with sudo or as root", result.stderr)
        self.assertEqual(calls, [])
        self.assert_old_installation()

    def test_refuses_local_tracked_changes(self):
        (self.kiosk / "main.py").write_text("local edits\n")
        result, calls = self.run_update()
        self.assertEqual(result.returncode, 1)
        self.assertIn("local changes", result.stderr)
        self.assertEqual(calls, [])
        self.assertEqual((self.kiosk / "main.py").read_text(), "local edits\n")

    def test_refuses_concurrent_update(self):
        with (self.repo / ".git/kiosk-update.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result, calls = self.run_update()
        self.assertEqual(result.returncode, 1)
        self.assertIn("Another kiosk update", result.stderr)
        self.assertEqual(calls, [])
        self.assert_old_installation()

    def test_later_update_restores_an_existing_release_symlink(self):
        result, _ = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.old_head = self.target
        (self.kiosk / "venv/old-environment").touch()
        previous_venv = (self.kiosk / "venv").resolve()
        self.env["TEST_OLD_CODE"] = "new code\n"
        (self.upstream / "pi-kiosk/main.py").write_text("third release\n")
        self.git(self.upstream, "add", ".")
        self.git(self.upstream, "commit", "-m", "third release")
        self.target = self.git(self.upstream, "rev-parse", "HEAD")
        (self.kiosk / "venv/partially-installed").unlink()
        result, _ = self.run_update(failure="restart")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assert_old_installation()
        self.assertEqual((self.kiosk / "venv").resolve(), previous_venv)
        result, _ = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(previous_venv.exists())
        self.assertEqual(len(list((self.kiosk / ".venv-releases").glob("release.*"))), 1)

    def test_setup_can_reuse_update_release_venv(self):
        # Run the actual setup venv command with real Python, without apt/pip
        # or service changes, to catch Python refusing symlink env_dir values.
        release = self.root / "real-release"
        subprocess.run([sys.executable, "-m", "venv", str(release),
                        "--system-site-packages"], check=True)
        directory = self.root / "setup-reuse"
        directory.mkdir()
        (directory / "venv").symlink_to(release, target_is_directory=True)
        command = next(line for line in (KIOSK_DIR / "setup.sh").read_text().splitlines()
                       if line.startswith("python3 -m venv "))
        result = subprocess.run(["bash", "-c", command], cwd=directory,
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_bootstrap_script_uses_the_explicit_installed_checkout(self):
        fetched = self.root / "fetched-updater.sh"
        fetched.write_text((KIOSK_DIR / "update.sh").read_text())
        result, _ = self.run_update(script=fetched)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.target)

    def test_replacing_the_running_script_does_not_execute_new_tail(self):
        script = self.upstream / "pi-kiosk/update.sh"
        script.write_text("# new updater\n" + script.read_text() + "\nexit 99\n")
        self.git(self.upstream, "add", ".")
        self.git(self.upstream, "commit", "-m", "replace updater during cutover")
        self.target = self.git(self.upstream, "rev-parse", "HEAD")
        result, _ = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.target)

    def test_refuses_a_checkout_that_cannot_fast_forward(self):
        self.git(self.repo, "config", "user.name", "Update Test")
        self.git(self.repo, "config", "user.email", "test@example.invalid")
        (self.kiosk / "main.py").write_text("local committed code\n")
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "local branch divergence")
        local_head = self.git(self.repo, "rev-parse", "HEAD")
        result, calls = self.run_update()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("cannot fast-forward", result.stderr)
        self.assertEqual(calls, [])
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), local_head)

    def test_partial_checkout_failure_restores_files_even_before_head_advances(self):
        # Model an I/O failure while Git updates files, before updating HEAD.
        real_git = shutil.which("git")
        stubs = self.root / "stubs"
        self.stub(stubs / "git", f'#!{sys.executable}\n' + '''import os, pathlib, sys
if sys.argv[1] == "merge":
    pathlib.Path("pi-kiosk/main.py").write_text("partial checkout\\n")
    sys.exit(8)
''' + f'os.execv({real_git!r}, [{real_git!r}, *sys.argv[1:]])\n')
        result, _ = self.run_update()
        self.assertEqual(result.returncode, 8, result.stderr)
        self.assert_old_installation()
        self.assertEqual((self.kiosk / "main.py").read_text(), "old code\n")


if __name__ == "__main__":
    unittest.main()
