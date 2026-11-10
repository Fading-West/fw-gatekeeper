"""Process-local observation of failed attendance writes.

The attendance transaction owner in database.py publishes exactly one outcome
per transaction: a SQLite failure (connection, BEGIN, reads, insert, receipt
insertion or commit) marks the fault after rollback; a committed transaction
that inserted a new punch clears it. Receipt replays and non-storage failures
(validation, identity, policy) publish nothing.

Completion and publication happen under one lock, so the observation follows
the order in which transactions finished rather than thread scheduling.

This is in-memory only: restarting the kiosk process removes the observation
even if storage is still failing (see README "Attendance write faults").
"""
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Optional

REASON = "attendance_write_failed"

_lock = threading.Lock()
_failed_at: Optional[str] = None
_error_type: Optional[str] = None


@contextmanager
def completing():
    """Hold while finishing a transaction and publishing its outcome."""
    with _lock:
        yield


def mark_failed_locked(error: BaseException) -> None:
    """Record a failed attendance write; caller holds ``completing()``."""
    global _failed_at, _error_type
    _failed_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    _error_type = type(error).__name__


def mark_committed_locked() -> None:
    """A new punch committed; caller holds ``completing()``."""
    global _failed_at, _error_type
    _failed_at = None
    _error_type = None


def mark_failed(error: BaseException) -> None:
    with completing():
        mark_failed_locked(error)


def snapshot() -> dict:
    with _lock:
        return {"failed": _failed_at is not None, "failed_at": _failed_at, "error_type": _error_type}


def reset_for_tests() -> None:
    with completing():
        mark_committed_locked()
