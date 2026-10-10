"""Configuration for FW Gatekeeper Pi kiosk."""

import math
import os
from pathlib import Path

# Server (optional if running fully offline)
SERVER_URL = "https://fw-gatekeeper.onrender.com"
SYNC_INTERVAL = 30  # seconds

# Kiosk identity
KIOSK_ID = "kiosk-entry-1"
KIOSK_TYPE = "entry"  # entry | exit | auto
KIOSK_NAME = "Main Entry"
KIOSK_API_KEY = os.environ.get("KIOSK_API_KEY", "")

# Camera
CAMERA_INDEX = 0
CAMERA_WIDTH = 640
CAMERA_HEIGHT = 480

# Liveness / recognition
# Blink verification before accepting a clock event. Off by default — it has
# caused scan issues on deployed boxes. Opt in per kiosk by setting
# LIVENESS_REQUIRED = True in config_local.py; the UI and health reporting
# reflect whichever mode is actually running.
LIVENESS_REQUIRED = False
LIVENESS_EAR_THRESHOLD = 0.21
LIVENESS_BLINK_FRAMES = 2
LIVENESS_TIMEOUT_SEC = 5
LIVENESS_WAIT_SEC = 8  # How long the kiosk waits for a blink after a face match
# Cosine similarity accept threshold (higher = stricter). ArcFace-family
# embeddings are usually reliable in the 0.45-0.55 band; 0.30 accepts
# look-alikes. Tune per site with the Recognition Lab, via config_local.py.
RECOGNITION_MATCH_THRESHOLD = 0.45
RECOGNITION_NEAR_MISS_MARGIN = 0.08
RECOGNITION_EMBEDDING_WINDOW = 3
RECOGNITION_UNKNOWN_STREAK = 3
RECOGNITION_MODEL_VERSION = "mobilefacenet-buffalo_s-onnx"
RECOGNITION_ATTEMPTS_ENDPOINT = "/api/recognition-attempts/bulk"

# Gatekeeper behavior
# Ignore repeat scans of the same person for this long. Keep it short: a long
# debounce blocks workers from clocking out again after a quick errand.
CLOCK_DEBOUNCE_MINUTES = 5
# Auto/both kiosks start a new shift after an unmatched clock-in ages out.
# Elapsed hours preserve overnight shifts; a local date change would not.
AUTO_CLOCK_STALE_HOURS = 16
DISPLAY_TIME_SEC = 5  # Hold failure/info results so the worker can read why
DISPLAY_TIME_SUCCESS_SEC = 2  # Successful scans clear fast to keep the line moving

# Web server (bind host comes from kiosk_ui_auth.get_kiosk_ui_host, loopback by default)
KIOSK_PORT = 5555

# Storage
DATA_DIR = "data"
_DATA_PATH = Path(DATA_DIR)
DB_PATH = str(_DATA_PATH / "attendance.db")
FACES_DIR = str(_DATA_PATH / "faces")
MODEL_DIR = str(_DATA_PATH / "models")
SHAPE_PREDICTOR_PATH = str(Path(MODEL_DIR) / "shape_predictor_68_face_landmarks.dat")

# Backward-compatible alias used by legacy modules
PHOTO_DIR = FACES_DIR

# Local per-kiosk overrides (written by setup.sh as config_local.py).
# This import lives in the tracked file so the installer never has to
# mutate config.py — keeping `git pull` upgrades clean on deployed kiosks.
try:
    from config_local import *  # noqa: F401, F403
except ImportError:
    pass

# Validate after config_local.py so per-kiosk overrides obey the same rule.
if (isinstance(AUTO_CLOCK_STALE_HOURS, bool)
        or not isinstance(AUTO_CLOCK_STALE_HOURS, (int, float))
        or not math.isfinite(AUTO_CLOCK_STALE_HOURS)
        or AUTO_CLOCK_STALE_HOURS <= 0):
    raise ValueError("AUTO_CLOCK_STALE_HOURS must be a finite positive number of hours")
