"""Real Git, real venvs and launcher processes; stub pip and host systemd only."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import urllib.request

KIOSK = Path(__file__).parent
REPO = KIOSK.parent
SPEC = importlib.util.spec_from_file_location("kiosk_release", KIOSK / "tools/kiosk_release.py")
RELEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELEASE)
APP = '''import http.server, json, os, sys, time
from pathlib import Path
version = VERSION
if version == "new" and os.environ.get("TEST_FAIL") == "crash":
    time.sleep(.2)
    sys.exit(9)
if version == "new" and os.environ.get("TEST_FAIL") == "slow":
    time.sleep(1)
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        healthy = not (version == "new" and os.environ.get("TEST_FAIL") == "health")
        assert Path("config_local.py").read_text() == "device secret\\n"
        assert Path("data/attendance.db").read_text() == "offline scans\\n"
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({"status": "ok" if healthy else "degraded",
                                    "camera_ok": healthy, "model_ok": healthy,
                                    "version": version}).encode())
    def log_message(self, *args): pass
http.server.HTTPServer(("127.0.0.1", int(os.environ["TEST_PORT"])), Handler).serve_forever()
'''


class UpdateScriptTests(unittest.TestCase):
    @staticmethod
    def git(directory, *arguments):
        return subprocess.run(["git", "-C", str(directory), *arguments], check=True,
                              capture_output=True, text=True).stdout.strip()

    @staticmethod
    def script(path, source):
        path.write_text(f"#!{sys.executable}\n" + source)
        path.chmod(0o755)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.upstream = self.root / "upstream"
        self.repo = self.root / "installed"
        self.upstream.mkdir()
        self.git(self.upstream, "init", "-b", "master")
        self.git(self.upstream, "config", "user.name", "Update test")
        self.git(self.upstream, "config", "user.email", "test@example.invalid")
        kiosk = self.upstream / "pi-kiosk"
        (kiosk / "tools").mkdir(parents=True)
        for name in ("update.sh", "requirements-build.lock", "requirements.lock"):
            shutil.copy(KIOSK / name, kiosk / name)
        shutil.copy(KIOSK / "tools/kiosk_release.py", kiosk / "tools/kiosk_release.py")
        shutil.copy(REPO / ".gitignore", self.upstream / ".gitignore")
        (kiosk / "main.py").write_text(APP.replace("VERSION", repr("old")))
        self.git(self.upstream, "add", ".")
        self.git(self.upstream, "commit", "-m", "old")
        self.old_head = self.git(self.upstream, "rev-parse", "HEAD")
        self.git(self.root, "clone", str(self.upstream), str(self.repo))
        self.kiosk = self.repo / "pi-kiosk"
        subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(self.kiosk / "venv")], check=True)
        (self.kiosk / "venv/old-environment").touch()
        (self.kiosk / "config_local.py").write_text("device secret\n")
        (self.kiosk / "data").mkdir()
        (self.kiosk / "data/attendance.db").write_text("offline scans\n")
        (kiosk / "main.py").write_text(APP.replace("VERSION", repr("new")))
        for name in ("requirements-build.lock", "requirements.lock"):
            (kiosk / name).write_text(f"target {name}\n")
        self.git(self.upstream, "add", ".")
        self.git(self.upstream, "commit", "-m", "new")
        self.target = self.git(self.upstream, "rev-parse", "HEAD")
        self.log = self.root / "calls.log"
        self.state = self.root / "service.json"
        self.units = self.root / "units"
        stubs = self.root / "stubs"
        stubs.mkdir()
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        self.rebooted = None
        self.env = {**os.environ, "PATH": f"{stubs}:{os.environ['PATH']}", "TEST_UID": "1000",
                    "TEST_REPO": str(self.repo), "TEST_LOG": str(self.log),
                    "TEST_STATE": str(self.state), "TEST_UNITS": str(self.units),
                    "TEST_PORT": str(port), "TEST_FAIL": "",
                    "KIOSK_HEALTH_URL": f"http://127.0.0.1:{port}/health",
                    "KIOSK_HEALTH_STABLE_SECONDS": ".6", "KIOSK_UPDATE_TIMEOUT": "3.5"}
        self.script(stubs / "id", '''import os, sys
print(os.environ["TEST_UID"] if sys.argv[1] == "-u" else "test-user")
''')
        self.script(stubs / "sudo", '''import os, sys
if os.environ.get("TEST_FAIL") == sys.argv[1]: sys.exit(13)
args = [arg.replace("/etc/systemd/system/fw-gatekeeper-kiosk.service.d", os.environ["TEST_UNITS"])
        for arg in sys.argv[1:]]
assert args[0] != "git"
os.execvp(args[0], args)
''')
        pip_stub = '''import os, pathlib, sys
if sys.argv[1:3] != ["-m", "pip"]:
    os.execv(str(pathlib.Path(__file__).with_name("real-python")), [str(pathlib.Path(__file__).with_name("real-python")), *sys.argv[1:]])
lock = sys.argv[-1]
assert pathlib.Path(lock).read_text() == f"target {lock}\\n"
with open(os.environ["TEST_LOG"], "a") as log: log.write("pip " + lock + "\\n")
pathlib.Path("venv/partial").touch()
if os.environ["TEST_FAIL"] == lock: sys.exit(9)
'''
        self.script(stubs / "python3", '''import os, pathlib, subprocess, sys
if sys.argv[1:3] == ["-m", "venv"]:
    subprocess.run([sys.executable, *sys.argv[1:], "--without-pip"], check=True)
    python = pathlib.Path("venv/bin/python")
    python.rename(python.with_name("real-python"))
    python.write_text(PIP_STUB)
    python.chmod(0o755)
    # A real absolute console-script shebang: relocation would break this.
    check = python.with_name("console-check")
    check.write_text("#!" + str(python.with_name("real-python").resolve().parent / "python") + "\\n")
    check.write_text("#!" + str(python.absolute()) + "\\nimport sys; print(sys.prefix)\\n")
    check.chmod(0o755)
else:
    os.execv(sys.executable, [sys.executable, *sys.argv[1:]])
'''.replace("PIP_STUB", repr(f"#!{sys.executable}\n" + pip_stub)))
        self.script(stubs / "systemctl", '''import json, os, pathlib, signal, subprocess, sys, time
args = sys.argv[1:]
root = pathlib.Path(os.environ["TEST_REPO"])
state_path = pathlib.Path(os.environ["TEST_STATE"])
state = json.loads(state_path.read_text())
with open(os.environ["TEST_LOG"], "a") as log: log.write("systemctl " + " ".join(args) + "\\n")
if args[0] == "show":
    print("test-user")
    sys.exit(0)
if args[0] == "is-active":
    sys.exit(0 if state.get("pid") else 3)
if args[0] == "daemon-reload":
    sys.exit(7 if os.environ["TEST_FAIL"] == "reload" else 0)
assert args[0] == "kill", args
if os.environ["TEST_FAIL"] == "kill": sys.exit(7)
os.kill(state["pid"], signal.SIGTERM)
# Real systemd waits for the old cgroup to exit before Restart=always.
for _ in range(100):
    try:
        fields = pathlib.Path(f"/proc/{state['pid']}/stat").read_text().rsplit(")", 1)[1].split()
        if fields[0] == "Z": break
    except FileNotFoundError: break
    time.sleep(.02)
with open(root / ".git/launcher.log", "a") as output:
    process = subprocess.Popen([sys.executable, str(root / ".git/kiosk-launch.py"), "launch", str(root), "--camera", "auto"],
                               start_new_session=True, stdout=output, stderr=output)
state["pid"] = process.pid
state_path.write_text(json.dumps(state))
''')
        self.original = subprocess.Popen([sys.executable, "main.py"], cwd=self.kiosk,
                                         env=self.env, start_new_session=True,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.state.write_text(json.dumps({"pid": self.original.pid}))
        self.addCleanup(self.stop_service)
        self.wait_version("old")

    def stop_service(self):
        # The supervisor and its child use separate process groups, like systemd
        # cgroups. Cleanup sends SIGTERM, giving the supervisor time to reap.
        pid = json.loads(self.state.read_text()).get("pid")
        if pid:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        if self.rebooted is not None and pid == self.rebooted.pid:
            self.rebooted.wait(timeout=5)
        if pid == self.original.pid:
            self.original.wait(timeout=5)
        else:
            self.original.poll()
        time.sleep(.1)
        running = self.repo / ".git/kiosk-running.json"
        if running.exists():
            for name in ("process", "child"):
                process = json.loads(running.read_text()).get(name)
                if process:
                    try: os.kill(process[0], signal.SIGKILL)
                    except ProcessLookupError: pass

    def snapshot(self):
        try:
            with urllib.request.urlopen(self.env["KIOSK_HEALTH_URL"], timeout=.2) as response:
                return json.load(response)
        except OSError:
            return {}

    def wait_version(self, version, timeout=5):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if self.snapshot().get("version") == version: return
            time.sleep(.05)
        log = self.repo / ".git/launcher.log"
        self.fail(f"No {version} kiosk; log: {log.read_text() if log.exists() else ''}")

    def run_update(self, failure="", extra=None, script=None):
        result = subprocess.run(["bash", str(script or self.kiosk / "update.sh"), str(self.repo)],
                                env={**self.env, "TEST_FAIL": failure, **(extra or {})},
                                capture_output=True, text=True, timeout=20)
        self.assertEqual((self.kiosk / "config_local.py").read_text(), "device secret\n")
        self.assertEqual((self.kiosk / "data/attendance.db").read_text(), "offline scans\n")
        return result

    def assert_old(self):
        self.wait_version("old")
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.old_head)
        self.assertTrue((self.kiosk / "venv/old-environment").exists())
        self.assertFalse((self.repo / ".git/kiosk-current.json").exists())

    def test_disk_reserve_aborts_before_installing(self):
        with mock.patch.object(RELEASE.shutil, "disk_usage", return_value=mock.Mock(free=1024)):
            with self.assertRaisesRegex(RuntimeError, "second venv"):
                with mock.patch.object(sys, "argv", ["helper", "space", str(self.repo), str(self.kiosk / "venv")]):
                    RELEASE.main()
            started = []
            real_popen = subprocess.Popen

            def start(*arguments, **keywords):
                child = real_popen(*arguments, **keywords)
                started.append(child)
                return child

            with mock.patch.object(RELEASE.subprocess, "Popen", side_effect=start):
                with self.assertRaisesRegex(RuntimeError, "disk reserve"):
                    RELEASE.guard(self.repo, [sys.executable, "-c", "import time; time.sleep(30)"])
            self.assertIsNotNone(started[0].returncode)
        self.assert_old()

    def test_manifest_write_failure_and_stale_boot_identity_keep_old(self):
        directory = self.root / "candidate"
        directory.mkdir()
        with mock.patch.object(RELEASE.os, "fsync", side_effect=OSError("SD I/O failure")):
            with self.assertRaises(OSError):
                RELEASE.prepare(self.repo, directory, self.target, os.getpid())
        self.assertFalse((self.repo / ".git/kiosk-pending.json").exists())
        owner = RELEASE.identity(os.getpid())
        owner[2] = "different-boot"
        RELEASE.durable_write(self.repo / ".git/kiosk-pending.json",
                              {"release": {"directory": str(directory)}, "owner": owner})
        self.assertEqual(RELEASE.selected(self.repo)["directory"], str(self.kiosk))
        # A completed atomic commit wins even if power failed before pending
        # was removed; the pending owner's identity is invalid after reboot.
        candidate = {"directory": str(directory), "revision": self.target}
        RELEASE.durable_write(self.repo / ".git/kiosk-current.json", candidate)
        self.assertEqual(RELEASE.selected(self.repo), candidate)

    def test_prepare_shares_nested_runtime_data_without_resurrecting_code(self):
        (self.kiosk / "tools/local.db").write_text("custom scans")
        directory = self.root / "candidate"
        (directory / "tools").mkdir(parents=True)
        RELEASE.prepare(self.repo, directory, self.target, os.getpid())
        self.assertEqual((directory / "tools/local.db").read_text(), "custom scans")
        self.assertFalse((directory / "main.py").exists())
        self.assertEqual((directory / "data").resolve(), self.kiosk / "data")

    def test_readmes_share_the_update_procedure(self):
        text = (REPO / "README.md").read_text()
        single, bulk = text.split("### Update kiosk software", 1)[1].split("### Update all 4 kiosks at once", 1)
        for section in (single.split("For an installation", 1)[0], bulk.split("\n### ", 1)[0]):
            commands = "".join(section.split("```")[1::2])
            self.assertIn("bash pi-kiosk/update.sh", commands)
            self.assertNotIn("git pull", commands)
            self.assertNotIn("systemctl restart", commands)

    def test_lock_installs_match_setup(self):
        def commands(path):
            return [" ".join(line.split()) for line in path.read_text().splitlines()
                    if "-m pip install" in line and not line.lstrip().startswith("#")]
        self.assertEqual(commands(KIOSK / "setup.sh"), commands(KIOSK / "update.sh"))

    def test_success_keeps_code_and_venv_at_permanent_paths(self):
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_version("new")
        record = json.loads((self.repo / ".git/kiosk-current.json").read_text())
        self.assertEqual(record["revision"], self.target)
        venv = (Path(record["directory"]) / "venv").resolve()
        result = subprocess.run([str(venv / "bin/console-check")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), str(venv))
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.old_head)
        self.assertNotIn("watchdog", self.log.read_text())
        self.assertNotIn("systemctl stop", self.log.read_text())
        self.assertNotIn("systemctl restart", self.log.read_text())

    def test_failed_build_locks_never_touch_service_or_old_venv(self):
        for lock in ("requirements-build.lock", "requirements.lock"):
            result = self.run_update(lock)
            self.assertEqual(result.returncode, 9, result.stderr)
            self.assertNotIn("systemctl kill", self.log.read_text())
            self.assert_old()

    def test_failed_cutover_and_health_restore_code_and_dependencies(self):
        for failure in ("install", "mv", "reload", "kill", "health", "crash"):
            with self.subTest(failure=failure):
                result = self.run_update(failure)
                self.assertNotEqual(result.returncode, 0)
                self.assert_old()

    def test_slow_startup_is_allowed_and_checked(self):
        result = self.run_update("slow")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_version("new")

    def test_sigkill_during_trial_automatically_restores_old_release(self):
        process = subprocess.Popen(["bash", str(self.kiosk / "update.sh")],
                                   env={**self.env, "KIOSK_HEALTH_STABLE_SECONDS": "10"},
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.wait_version("new")
            process.kill()
            process.wait(timeout=3)
            self.assert_old()
            # Simulated reboot: the persisted trial record cannot select new.
            self.stop_service()
            with (self.repo / ".git/launcher.log").open("a") as output:
                rebooted = subprocess.Popen([sys.executable, str(self.repo / ".git/kiosk-launch.py"),
                                              "launch", str(self.repo)], env=self.env,
                                             stdout=output, stderr=output, start_new_session=True)
            self.rebooted = rebooted
            self.state.write_text(json.dumps({"pid": rebooted.pid}))
            self.wait_version("old")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

    def test_hup_during_trial_restores_old_release(self):
        process = subprocess.Popen(["bash", str(self.kiosk / "update.sh")],
                                   env={**self.env, "KIOSK_HEALTH_STABLE_SECONDS": "10"},
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.wait_version("new")
            process.send_signal(signal.SIGHUP)
            self.assertEqual(process.wait(timeout=5), 129)
            self.assert_old()
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

    def test_root_local_changes_and_concurrent_updates_are_refused(self):
        result = self.run_update(extra={"TEST_UID": "0"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("not with sudo or as root", result.stderr)
        with (self.repo / ".git/kiosk-update.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_update()
        self.assertIn("Another kiosk update", result.stderr)
        (self.kiosk / "main.py").write_text("local edits\n")
        result = self.run_update()
        self.assertIn("local changes", result.stderr)
        self.assertNotIn("systemctl kill", self.log.read_text() if self.log.exists() else "")

    def test_code_only_update_reuses_venv_and_later_failure_restores_release(self):
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        old_record = json.loads((self.repo / ".git/kiosk-current.json").read_text())
        old_venv = (Path(old_record["directory"]) / "venv").resolve()
        self.log.write_text("")
        new_app = APP.replace("VERSION", repr("third"))
        (self.upstream / "pi-kiosk/main.py").write_text(new_app)
        updater = self.upstream / "pi-kiosk/update.sh"
        updater.write_text('touch "$TEST_REPO/.git/updater-used"\n' + updater.read_text())
        # An app release cannot replace the stable recovery launcher with an
        # unverified/broken implementation, including on the next reboot.
        (self.upstream / "pi-kiosk/tools/kiosk_release.py").write_text('raise RuntimeError("bad candidate launcher")\n')
        self.git(self.upstream, "add", ".")
        self.git(self.upstream, "commit", "-m", "code-only update")
        result = self.run_update("kill")
        self.assertNotEqual(result.returncode, 0)
        self.wait_version("new")
        self.assertEqual(json.loads((self.repo / ".git/kiosk-current.json").read_text()), old_record)
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_version("third")
        self.assertNotIn("pip ", self.log.read_text())
        record = json.loads((self.repo / ".git/kiosk-current.json").read_text())
        self.assertEqual((Path(record["directory"]) / "venv").resolve(), old_venv)
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.repo / ".git/updater-used").exists())

    def test_fetch_or_archive_failure_keeps_old_installation(self):
        real_git = shutil.which("git")
        for operation in ("fetch", "archive"):
            self.script(self.root / "stubs/git", f"""import os, sys
if sys.argv[1] == {operation!r}: sys.exit(8)
os.execv({real_git!r}, [{real_git!r}, *sys.argv[1:]])
""")
            result = self.run_update()
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assert_old()
            self.assertNotIn("systemctl kill", self.log.read_text())

    def test_missing_trial_interpreter_falls_back_without_waiting_for_updater(self):
        candidate = self.root / "missing-interpreter"
        candidate.mkdir()
        RELEASE.prepare(self.repo, candidate, self.target, os.getpid())
        shutil.copy(KIOSK / "tools/kiosk_release.py", self.repo / ".git/kiosk-launch.py")
        self.stop_service()
        with (self.repo / ".git/launcher.log").open("a") as output:
            self.rebooted = subprocess.Popen([sys.executable, str(self.repo / ".git/kiosk-launch.py"),
                                               "launch", str(self.repo)], env=self.env,
                                              stdout=output, stderr=output, start_new_session=True)
        self.state.write_text(json.dumps({"pid": self.rebooted.pid}))
        self.wait_version("old")

    def test_bootstrap_uses_installed_clone(self):
        fetched = self.root / "bootstrap.sh"
        shutil.copy(KIOSK / "update.sh", fetched)
        result = self.run_update(script=fetched)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_version("new")


if __name__ == "__main__":
    unittest.main()
