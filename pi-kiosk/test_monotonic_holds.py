#!/usr/bin/env python3
"""A backward wall-clock step (NTP/timesyncd, manual date change) must not
freeze scanning: in-memory holds and blink deadlines run on the monotonic clock.

Drives the real main.run() loop with real SQLite and matching code. Hardware,
models and web-server startup are stubbed; main.time is replaced by a scaled
clock whose wall time can be stepped. Run this file in its own process, as
scripts/run-python-tests.mjs does, to isolate the hardware import stubs.
"""

import logging
import os
import sys
import tempfile
import threading
import time as real_time
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Camera/model-only modules; everything else below is production code.
_fr = types.ModuleType("face_recognition")
_fr.face_locations = lambda img, model="hog": [(20, 40, 40, 20)]
sys.modules["face_recognition"] = _fr
sys.modules["dlib"] = types.ModuleType("dlib")
_scipy = types.ModuleType("scipy")
_spatial = types.ModuleType("scipy.spatial")
_distance = types.ModuleType("scipy.spatial.distance")
_distance.euclidean = lambda a, b: float(np.linalg.norm(np.asarray(a) - np.asarray(b)))
sys.modules.update({"scipy": _scipy, "scipy.spatial": _spatial, "scipy.spatial.distance": _distance})

import config  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import recognition  # noqa: E402

logging.disable(logging.CRITICAL)

SPEED = 20.0          # fake seconds per real second
STEP_BACK = 3600.0    # the Pi clock was an hour fast; timesyncd corrects it
GIVE_UP_AFTER = 40.0  # fake seconds to wait for the post-step clock event
RECORD_WITHIN = 20.0  # fake seconds; generous bound for a hold and detection


class FakeClock:
    """Scaled clock: wall time can be stepped, monotonic time never goes back."""

    def __init__(self):
        self._start = real_time.monotonic()
        self.wall_offset = 0.0
        self.stopped = threading.Event()

    def _elapsed(self):
        return (real_time.monotonic() - self._start) * SPEED

    def time(self):
        return 1_800_000_000.0 + self.wall_offset + self._elapsed()

    def monotonic(self):
        return 5_000.0 + self._elapsed()

    def sleep(self, seconds):
        # main.run() leaves its daemon detector running on shutdown. Stop the
        # test's detector before restoring patches or deleting its database.
        if self.stopped.is_set():
            raise SystemExit
        real_time.sleep(max(0.0, seconds) / SPEED)


class FakeBlinkChecker:
    """Checks frame identity and steps the clock on the third blink frame."""

    on_blink = None
    completes = True

    def __init__(self):
        self.failed = False
        self.frames = 0

    def reset(self):
        self.frames = 0

    def get_ear(self):
        return 0.3

    def update(self, frame, face_location, frame_check=None):
        if frame_check is not None and not frame_check(frame, face_location):
            self.frames = 0
            return False
        self.frames += 1
        if self.frames < 3:
            return False
        # The step lands between blink completion and the post-blink
        # recognition result that must re-confirm the same worker.
        FakeBlinkChecker.on_blink()
        return self.completes


def run_kiosk(*, step_back, blink, complete_blink=True):
    """Measure elapsed monotonic seconds until a clock-in or blink timeout."""
    clock = FakeClock()
    rng = np.random.default_rng(0)
    encodings = {p: (lambda v: v / np.linalg.norm(v))(rng.normal(size=512)) for p in (1, 2)}
    ids = {}
    state = {"person": 1, "captures": 0, "stepped_at": None,
             "recorded_after": None, "timed_out_after": None}
    started_at = clock.monotonic()
    update_status = main.web_app.update_status

    def observe_status(**fields):
        update_status(**fields)
        if (state["stepped_at"] is not None and fields.get("state") == "NOT_RECOGNIZED"
                and fields.get("message") in {"Blink not detected - please try again", "Verification interrupted - please try again"}):
            state["timed_out_after"] = clock.monotonic() - state["stepped_at"]

    def step_clock():
        if state["stepped_at"] is None:
            clock.wall_offset -= step_back
            state["stepped_at"] = clock.monotonic()

    def watched_worker():
        # Hold scenario: A clocks in, the clock steps back, B walks up.
        # Blink scenario: the clock steps back mid-verification of A.
        return 1 if blink else 2

    class FakeCamera:
        def __init__(self, mode="auto"):
            pass

        def start(self):
            pass

        def stop(self):
            pass

        def capture(self):
            state["captures"] += 1
            if (not blink and state["person"] == 1 and state["captures"] > 5
                    and database.get_last_action(ids[1]) == "clock_in"):
                step_clock()
                state["person"] = 2
            if (state["stepped_at"] is not None and state["recorded_after"] is None
                    and database.get_last_action(ids[watched_worker()]) == "clock_in"):
                state["recorded_after"] = clock.monotonic() - state["stepped_at"]
            if state["recorded_after"] is not None or state["timed_out_after"] is not None:
                raise KeyboardInterrupt
            if state["stepped_at"] is not None and clock.monotonic() - state["stepped_at"] > GIVE_UP_AFTER:
                raise KeyboardInterrupt
            if clock.monotonic() - started_at > GIVE_UP_AFTER * 2:
                raise KeyboardInterrupt
            frame = np.zeros((80, 80, 3), np.uint8)
            frame[0, 0, 0] = state["person"]
            return frame, frame.copy()

    def fake_embed(frame, face_loc):
        return encodings[int(frame[0, 0, 0])].copy()

    FakeBlinkChecker.on_blink = staticmethod(step_clock)
    FakeBlinkChecker.completes = complete_blink

    with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as tmp, \
            mock.patch.object(config, "DB_PATH", str(Path(tmp) / "kiosk.db")), \
            mock.patch.object(config, "DATA_DIR", tmp), \
            mock.patch.object(config, "FACES_DIR", str(Path(tmp) / "faces")), \
            mock.patch.object(config, "PHOTO_DIR", str(Path(tmp) / "faces")), \
            mock.patch.object(config, "MODEL_DIR", str(Path(tmp) / "models")), \
            mock.patch.object(config, "KIOSK_API_KEY", ""), \
            mock.patch.object(config, "KIOSK_TYPE", "entry"), \
            mock.patch.object(config, "LIVENESS_REQUIRED", blink), \
            mock.patch.object(recognition, "LivenessChecker", FakeBlinkChecker), \
            mock.patch.object(main, "time", clock), \
            mock.patch.object(main, "Camera", FakeCamera), \
            mock.patch.object(main, "embed_face", fake_embed), \
            mock.patch.object(main, "recognition_model_ready", lambda: True), \
            mock.patch.object(main.web_app, "update_status", observe_status), \
            mock.patch.object(main.web_app, "start_server", lambda: None), \
            mock.patch.object(main.web_app, "check_server", lambda: None):
        database._local.conn = None
        try:
            database.init_db()
            ids[1] = database.add_worker("Worker A", encodings[1], server_id="a" * 32)
            ids[2] = database.add_worker("Worker B", encodings[2], server_id="b" * 32)
            main.run(types.SimpleNamespace(server=None, kiosk_id=None, camera="usb"))
        finally:
            clock.stopped.set()
            for thread in threading.enumerate():
                if thread.name == "face-detect":
                    thread.join(timeout=2)
                    if thread.is_alive():
                        raise AssertionError("test detector did not stop")
            conn = getattr(database._local, "conn", None)
            if conn is not None:
                conn.close()
            database._local.conn = None
    return state


class MonotonicHoldTests(unittest.TestCase):
    def assert_recorded_promptly(self, scenario, what):
        self.assertIsNotNone(scenario["stepped_at"], "scenario never reached the clock step")
        self.assertIsNotNone(
            scenario["recorded_after"],
            f"{what} was never recorded within {GIVE_UP_AFTER:.0f}s after a "
            f"{STEP_BACK:.0f}s backward wall-clock step (in-memory deadline compared "
            "against time.time())",
        )
        self.assertLess(scenario["recorded_after"], RECORD_WITHIN)

    def test_control_next_worker_recorded_after_hold_without_clock_step(self):
        self.assert_recorded_promptly(run_kiosk(step_back=0.0, blink=False), "the next worker")

    def test_backward_clock_step_does_not_extend_display_hold(self):
        self.assert_recorded_promptly(run_kiosk(step_back=STEP_BACK, blink=False), "the next worker")

    def test_control_blink_verified_worker_recorded_without_clock_step(self):
        self.assert_recorded_promptly(run_kiosk(step_back=0.0, blink=True), "the blink-verified worker")

    def test_backward_clock_step_mid_blink_does_not_strand_verification(self):
        self.assert_recorded_promptly(run_kiosk(step_back=STEP_BACK, blink=True), "the blink-verified worker")

    def test_backward_clock_step_does_not_extend_uncompleted_blink_deadline(self):
        scenario = run_kiosk(step_back=STEP_BACK, blink=True, complete_blink=False)
        self.assertIsNotNone(scenario["stepped_at"], "scenario never reached the clock step")
        self.assertIsNone(scenario["recorded_after"], "an uncompleted blink must not record attendance")
        self.assertIsNotNone(scenario["timed_out_after"], "blink verification never timed out")
        self.assertLess(scenario["timed_out_after"], config.LIVENESS_WAIT_SEC + 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
