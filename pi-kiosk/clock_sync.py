"""Best-effort OS clock synchronization status; never an attendance gate."""

from pathlib import Path
import subprocess
import threading
import time
from typing import Optional

SYSTEMD_RUNTIME = Path("/run/systemd/system")
SYNC_MARKER = Path("/run/systemd/timesync/synchronized")
CACHE_SECONDS = 30.0
PROBE_TIMEOUT_SECONDS = 0.5

_lock = threading.Lock()
_cached_status: Optional[bool] = None
_checked_at: Optional[float] = None


def _probe() -> Optional[bool]:
    # Do not infer clock trouble from a dev/CI host's kernel or missing tools.
    if not SYSTEMD_RUNTIME.is_dir():
        return None
    try:
        result = subprocess.run(
            ["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
            capture_output=True, text=True, check=False,
            timeout=PROBE_TIMEOUT_SECONDS,
        )
        if result.returncode == 0:
            value = result.stdout.strip().lower()
            if value in {"yes", "true"}:
                return True
            if value in {"no", "false"}:
                return False
    except Exception:
        # Missing executable, inaccessible D-Bus, timeout, etc.: try timesyncd.
        pass
    # Presence is positive evidence of a sync this boot. Absence alone cannot
    # establish failure (another NTP implementation may be in use).
    return True if SYNC_MARKER.is_file() else None


def get_clock_synchronized() -> Optional[bool]:
    """True/False when known, None otherwise. Cache against monotonic time.

    A wall-clock correction must not freeze the cache. Serialize probes from
    UI and heartbeat threads so polling never spawns multiple subprocesses.
    All unavailable/failed probes remain unknown, including on non-systemd
    development hosts. The worst-case subprocess wait is half a second.
    """
    global _cached_status, _checked_at
    try:
        with _lock:
            now = time.monotonic()
            if _checked_at is None or now - _checked_at >= CACHE_SECONDS:
                try:
                    _cached_status = _probe()
                except Exception:
                    _cached_status = None
                _checked_at = time.monotonic()
            return _cached_status
    except Exception:
        return None
