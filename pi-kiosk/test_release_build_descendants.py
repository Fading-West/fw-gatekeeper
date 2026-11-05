"""Real process-group cleanup when a dependency build leader exits first."""
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "kiosk_release", Path(__file__).parent / "tools/kiosk_release.py",
)
RELEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELEASE)

WORKER = """
import os, signal, sys, time
from pathlib import Path
root = Path(sys.argv[1])
def stop(*_):
    (root / 'stopped').touch()
    sys.exit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN if sys.argv[2] == 'ignore' else stop)
(root / 'ready').write_text(str(os.getpid()))
while True:
    time.sleep(.02)
"""
BUILD = """
import subprocess, sys, time
from pathlib import Path
root = Path(sys.argv[1])
subprocess.Popen([sys.executable, '-c', sys.argv[2], str(root), sys.argv[4]])
deadline = time.monotonic() + 5
while not (root / 'ready').exists():
    if time.monotonic() > deadline:
        sys.exit(99)
    time.sleep(.01)
sys.exit(int(sys.argv[3]))
"""


class ReleaseBuildDescendantTests(unittest.TestCase):
    def test_guard_stops_build_descendants_after_leader_exits(self):
        for exit_code, behavior in ((0, "stop"), (9, "stop"), (0, "ignore"), (9, "ignore")):
            with self.subTest(exit_code=exit_code, behavior=behavior), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                started = []
                real_popen = subprocess.Popen

                def start(*args, **kwargs):
                    process = real_popen(*args, **kwargs)
                    started.append(process)
                    return process

                # Keep the real build and process group, recording its leader
                # only so a failing regression can clean up its own descendant.
                try:
                    with mock.patch.object(RELEASE.subprocess, "Popen", side_effect=start):
                        command = [sys.executable, "-c", BUILD, str(root), WORKER, str(exit_code), behavior]
                        if exit_code:
                            with self.assertRaises(SystemExit) as result:
                                RELEASE.guard(root, command)
                            self.assertEqual(result.exception.code, exit_code)
                        else:
                            RELEASE.guard(root, command)
                    self.assertEqual(started[0].returncode, exit_code)
                    self.assertTrue((root / "ready").exists())
                    worker_pid = int((root / "ready").read_text())
                    deadline = time.monotonic() + 2
                    while RELEASE.identity(worker_pid) is not None and time.monotonic() < deadline:
                        time.sleep(.01)
                    self.assertIsNone(RELEASE.identity(worker_pid),
                                      "dependency worker survived guard's cleanup after its leader exited")
                finally:
                    if started:
                        try:
                            os.killpg(started[0].pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass

    def test_stopping_an_already_empty_process_group_is_safe(self):
        child = subprocess.Popen([sys.executable, "-c", "pass"], start_new_session=True)
        child.wait(timeout=5)
        RELEASE.stop_child(child)
        RELEASE.stop_child(child)


if __name__ == "__main__":
    unittest.main()
