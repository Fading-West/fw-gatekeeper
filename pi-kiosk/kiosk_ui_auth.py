"""Authentication helpers for the kiosk's localhost-only web UI."""

import hashlib
import hmac
import os
import secrets
import threading
import time
from typing import Callable, Optional

import config


KIOSK_UI_KEY_HEADER = "X-Kiosk-UI-Key"
KIOSK_UI_SESSION_COOKIE = "fw-kiosk-ui"
KIOSK_SUPERVISOR_SESSION_COOKIE = "fw-kiosk-supervisor"
_SESSION_CONTEXT = b"fw-gatekeeper-kiosk-ui-session-v1"
_SUPERVISOR_CONTEXT = b"fw-gateway-kiosk-supervisor-session-v1"
SUPERVISOR_SESSION_TTL_SECONDS = 5 * 60
SUPERVISOR_MAX_FAILED_ATTEMPTS = 5
SUPERVISOR_FAILURE_WINDOW_SECONDS = 60
SUPERVISOR_LOCKOUT_SECONDS = 5 * 60
_supervisor_sessions: dict[str, int] = {}
_supervisor_unlocks: dict[str, str] = {}
# Retain cancelled operations until restart: an arbitrarily delayed request
# must never mint a new credential after its lock has been acknowledged.
_cancelled_supervisor_unlocks: set[str] = set()
_supervisor_boot_nonce = secrets.token_hex(16)
_supervisor_session_lock = threading.Lock()


def get_supervisor_boot_nonce() -> str:
    """Public process generation; it is not an authorization credential."""
    return _supervisor_boot_nonce


class SupervisorAttemptLimiter:
    """Bound supervisor passcode attempts across the kiosk-local UI."""

    def __init__(
        self,
        max_attempts: int = SUPERVISOR_MAX_FAILED_ATTEMPTS,
        window_seconds: int = SUPERVISOR_FAILURE_WINDOW_SECONDS,
        lockout_seconds: int = SUPERVISOR_LOCKOUT_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds
        self.lockout_seconds = lockout_seconds
        self.clock = clock
        self._failed_at: list[float] = []
        self._locked_until = 0.0
        self._lock = threading.Lock()

    def _prune(self, now: float) -> None:
        cutoff = now - self.window_seconds
        self._failed_at = [failed_at for failed_at in self._failed_at if failed_at > cutoff]

    def retry_after_seconds(self) -> int:
        with self._lock:
            return max(0, int(self._locked_until - self.clock() + 0.999))

    def is_locked(self) -> bool:
        with self._lock:
            return self._locked_until > self.clock()

    def record_failure(self) -> bool:
        with self._lock:
            now = self.clock()
            if self._locked_until > now:
                return True
            self._prune(now)
            self._failed_at.append(now)
            if len(self._failed_at) >= self.max_attempts:
                self._locked_until = now + self.lockout_seconds
                self._failed_at.clear()
                return True
            return False

    def record_success(self) -> None:
        with self._lock:
            self._failed_at.clear()
            self._locked_until = 0.0


def _config_or_env(config_name: str, env_name: str, default: str = "") -> str:
    configured = getattr(config, config_name, None)
    if configured is not None:
        return str(configured).strip()
    return os.environ.get(env_name, default).strip()


def require_kiosk_ui_key() -> str:
    key = _config_or_env("KIOSK_UI_KEY", "KIOSK_UI_KEY")
    if not key:
        raise RuntimeError(
            "KIOSK_UI_KEY is required for protected kiosk web routes. "
            "Configure it locally and restart the kiosk service."
        )
    return key


def require_supervisor_pin() -> str:
    pin = _config_or_env("KIOSK_SUPERVISOR_PIN", "KIOSK_SUPERVISOR_PIN")
    if not pin:
        raise RuntimeError("KIOSK_SUPERVISOR_PIN is required for manual attendance controls.")
    return pin


def get_kiosk_ui_host() -> str:
    return _config_or_env("KIOSK_UI_HOST", "KIOSK_UI_HOST", "127.0.0.1") or "127.0.0.1"


def get_enroll_preview_host() -> str:
    return _config_or_env(
        "KIOSK_ENROLL_PREVIEW_HOST",
        "KIOSK_ENROLL_PREVIEW_HOST",
        "127.0.0.1",
    ) or "127.0.0.1"


def kiosk_ui_session_token(key: Optional[str] = None) -> str:
    configured_key = (key or require_kiosk_ui_key()).strip()
    return hmac.new(configured_key.encode("utf-8"), _SESSION_CONTEXT, hashlib.sha256).hexdigest()


def supervisor_session_token(pin: Optional[str] = None, issued_at: Optional[int] = None,
                             unlock_request_id: Optional[str] = None) -> str:
    configured_pin = (pin or require_supervisor_pin()).strip()
    ui_key = require_kiosk_ui_key()
    issued = int(time.time() if issued_at is None else issued_at)
    signing_key = f"{ui_key}:{configured_pin}".encode("utf-8")
    nonce = secrets.token_hex(16)
    message = f"{issued}.{nonce}"
    signature = hmac.new(signing_key, _SUPERVISOR_CONTEXT + message.encode("ascii"), hashlib.sha256).hexdigest()
    token = f"{message}.{signature}"
    with _supervisor_session_lock:
        now = int(time.time())
        expired = [value for value, timestamp in _supervisor_sessions.items()
                   if now - timestamp > SUPERVISOR_SESSION_TTL_SECONDS]
        for value in expired:
            del _supervisor_sessions[value]
        for operation, value in list(_supervisor_unlocks.items()):
            if value not in _supervisor_sessions:
                del _supervisor_unlocks[operation]
        if unlock_request_id:
            if unlock_request_id in _cancelled_supervisor_unlocks:
                raise ValueError("Supervisor unlock was cancelled")
            existing = _supervisor_unlocks.get(unlock_request_id)
            if existing:
                return existing
            _supervisor_unlocks[unlock_request_id] = token
        _supervisor_sessions[token] = issued
    return token


def revoke_supervisor_session(session_token: Optional[str], unlock_request_id: Optional[str] = None) -> None:
    """Lock this session on the server; separate unlocked sessions keep working.

    Sessions are deliberately process-local: a service restart requires a new
    unlock and cannot revive a token revoked before the restart.
    """
    with _supervisor_session_lock:
        _supervisor_sessions.pop(session_token or "", None)
        if unlock_request_id:
            _cancelled_supervisor_unlocks.add(unlock_request_id)
            token = _supervisor_unlocks.pop(unlock_request_id, None)
            _supervisor_sessions.pop(token or "", None)


def has_valid_supervisor_credential(provided_pin: Optional[str] = None, session_token: Optional[str] = None) -> bool:
    try:
        configured_pin = require_supervisor_pin()
    except RuntimeError:
        return False
    candidate_pin = (provided_pin or "").strip()
    if candidate_pin and hmac.compare_digest(candidate_pin, configured_pin):
        return True
    candidate_session = (session_token or "").strip()
    if not candidate_session:
        return False
    with _supervisor_session_lock:
        if candidate_session not in _supervisor_sessions:
            return False
    try:
        issued_raw, nonce, provided_signature = candidate_session.split(".")
        issued_at = int(issued_raw)
    except (TypeError, ValueError):
        return False
    age_seconds = int(time.time()) - issued_at
    if age_seconds < -30 or age_seconds > SUPERVISOR_SESSION_TTL_SECONDS:
        return False
    try:
        signing_key = f"{require_kiosk_ui_key()}:{configured_pin}".encode("utf-8")
    except RuntimeError:
        return False
    message = f"{issued_raw}.{nonce}".encode("ascii")
    expected_signature = hmac.new(signing_key, _SUPERVISOR_CONTEXT + message, hashlib.sha256).hexdigest()
    with _supervisor_session_lock:
        return candidate_session in _supervisor_sessions and hmac.compare_digest(provided_signature, expected_signature)


def has_valid_kiosk_ui_credential(
    provided_key: Optional[str] = None,
    session_token: Optional[str] = None,
) -> bool:
    try:
        configured_key = require_kiosk_ui_key()
    except RuntimeError:
        return False

    candidate_key = (provided_key or "").strip()
    if candidate_key and hmac.compare_digest(candidate_key, configured_key):
        return True

    candidate_session = (session_token or "").strip()
    return bool(
        candidate_session
        and hmac.compare_digest(candidate_session, kiosk_ui_session_token(configured_key))
    )
