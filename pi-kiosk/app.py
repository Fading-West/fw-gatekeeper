"""Flask web UI for the FW Gatekeeper Pi kiosk."""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from functools import wraps

import cv2
from flask import Flask, Response, jsonify, make_response, render_template, request

import config
import database
from kiosk_ui_auth import (
    KIOSK_UI_KEY_HEADER,
    KIOSK_UI_SESSION_COOKIE,
    KIOSK_SUPERVISOR_SESSION_COOKIE,
    SUPERVISOR_SESSION_TTL_SECONDS,
    SupervisorAttemptLimiter,
    get_kiosk_ui_host,
    has_valid_kiosk_ui_credential,
    has_valid_supervisor_credential,
    kiosk_ui_session_token,
    require_kiosk_ui_key,
    supervisor_session_token,
)

logger = logging.getLogger(__name__)
app = Flask(__name__)

_frame_lock = threading.Lock()
_current_frame = None

_status_lock = threading.Lock()
_status = {
    "state": "IDLE",
    "message": "Step toward camera",
    "worker_name": None,
    "worker_id": None,
    "action": None,
    "confidence": 0.0,
    "liveness_confirmed": False,
    "ear": 0.0,
    "face_detected": False,
    "face_count": 0,
    "known_workers": 0,
    "timestamp": None,
}

_health_lock = threading.Lock()
_health = {
    "camera_ok": False,
    "model_ok": False,
    "liveness_available": False,
    "known_workers": 0,
    "queued_logs": 0,
    "retryable_logs": 0,
    "rejected_logs": 0,
    "queued_attempts": 0,
    "degraded_reason": None,
    "last_scan_at": None,
    "sync_online": None,  # None = sync disabled/unknown, True/False once known
    "last_sync_at": None,
}

_server_thread = None
_supervisor_attempt_limiter = SupervisorAttemptLimiter()


def set_frame(frame):
    """Set the latest frame used by MJPEG feed."""
    global _current_frame
    with _frame_lock:
        _current_frame = frame.copy() if frame is not None else None


def update_status(**kwargs):
    """Update shared status fields."""
    with _status_lock:
        _status.update(kwargs)
        _status["timestamp"] = datetime.now().isoformat(timespec="seconds")


def update_health(**kwargs):
    """Update kiosk health fields (camera/model/sync/queue state)."""
    with _health_lock:
        _health.update(kwargs)


def get_health_snapshot() -> dict:
    with _health_lock:
        return dict(_health)


def get_status_snapshot() -> dict:
    """Get current status plus metadata used by the frontend."""
    with _status_lock:
        data = dict(_status)

    data["health"] = get_health_snapshot()
    data["liveness_required"] = bool(config.LIVENESS_REQUIRED)
    workers = database.list_workers()
    data["kiosk_id"] = config.KIOSK_ID
    data["kiosk_name"] = config.KIOSK_NAME
    data["kiosk_type"] = config.KIOSK_TYPE
    data["server_time"] = datetime.now().isoformat(timespec="seconds")
    data["admin"] = {
        "worker_count": len(workers),
        "total_photos": sum(worker["photo_count"] for worker in workers),
        "workers": workers,
    }
    return data


def _mjpeg_stream():
    while True:
        with _frame_lock:
            frame = _current_frame
        if frame is not None:
            ok, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
            if ok:
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n" + buffer.tobytes() + b"\r\n"
                )
        time.sleep(0.05)


def _manual_action_for_worker(worker_id: int) -> str:
    if config.KIOSK_TYPE == "entry":
        return "clock_in"
    if config.KIOSK_TYPE == "exit":
        return "clock_out"
    last = database.get_last_action(worker_id)
    return "clock_out" if last == "clock_in" else "clock_in"


def _is_loopback_request() -> bool:
    return request.remote_addr in {"127.0.0.1", "::1"}


def kiosk_ui_auth_required(view):
    """Protect write, camera, attendance, and worker-data routes."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        try:
            require_kiosk_ui_key()
        except RuntimeError:
            return jsonify({"error": "Kiosk UI authentication is not configured"}), 503

        if not has_valid_kiosk_ui_credential(
            provided_key=request.headers.get(KIOSK_UI_KEY_HEADER),
            session_token=request.cookies.get(KIOSK_UI_SESSION_COOKIE),
        ):
            return jsonify({"error": "Unauthorized"}), 401
        return view(*args, **kwargs)

    return wrapped


def supervisor_auth_required(view):
    """Require an explicitly unlocked, short-lived supervisor session."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not has_valid_supervisor_credential(
            session_token=request.cookies.get(KIOSK_SUPERVISOR_SESSION_COOKIE),
        ):
            return jsonify({"error": "Supervisor authentication required"}), 401
        return view(*args, **kwargs)
    return wrapped


@app.route("/")
def index():
    response = make_response(
        render_template("index.html", kiosk_name=config.KIOSK_NAME, kiosk_type=config.KIOSK_TYPE)
    )
    if _is_loopback_request():
        try:
            response.set_cookie(
                KIOSK_UI_SESSION_COOKIE,
                kiosk_ui_session_token(),
                httponly=True,
                samesite="Strict",
                secure=False,
            )
        except RuntimeError:
            pass
    return response


@app.route("/feed")
@kiosk_ui_auth_required
def feed():
    return Response(_mjpeg_stream(), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.route("/video_feed")
@kiosk_ui_auth_required
def video_feed_alias():
    return feed()


@app.route("/health")
def health():
    """Truthful kiosk health: degraded whenever a scan-blocking subsystem is down."""
    snapshot = get_health_snapshot()
    degraded = not snapshot["camera_ok"] or not snapshot["model_ok"] or bool(snapshot["degraded_reason"])
    return jsonify({"status": "degraded" if degraded else "ok", **snapshot})


@app.route("/status")
@kiosk_ui_auth_required
def status():
    snapshot = get_status_snapshot()
    if not has_valid_supervisor_credential(session_token=request.cookies.get(KIOSK_SUPERVISOR_SESSION_COOKIE)):
        snapshot.pop("admin", None)
    return jsonify(snapshot)


@app.route("/log")
@kiosk_ui_auth_required
def today_log():
    return jsonify(database.get_today_logs(limit=100))


@app.route("/today")
@kiosk_ui_auth_required
def today_log_alias():
    return today_log()


@app.route("/manual-clock", methods=["POST"])
@app.route("/manual_clock", methods=["POST"])
@kiosk_ui_auth_required
@supervisor_auth_required
def manual_clock():
    payload = request.get_json(silent=True) or {}
    try:
        if "worker_id" in payload:
            worker_id = payload["worker_id"]
            if isinstance(worker_id, bool) or not isinstance(worker_id, int) or worker_id <= 0:
                return jsonify({"success": False, "error": "Valid worker ID is required"}), 400
            worker = database.get_worker_by_id(worker_id)
        else:
            name = str(payload.get("name", "")).strip()
            if not name:
                return jsonify({"success": False, "error": "Name is required"}), 400
            worker = database.get_worker_by_name(name)
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 409
    if worker is None:
        return jsonify({"success": False, "error": "Worker not found"}), 404

    action = payload.get("action")
    if action not in {"clock_in", "clock_out"}:
        action = _manual_action_for_worker(worker["id"])

    log_id = database.log_attendance(
        worker_id=worker["id"],
        worker_name=worker["name"],
        action=action,
        liveness_confirmed=False,
        confidence=1.0,
        note="manual_clock",
        server_worker_id=worker.get("server_id"),
    )
    action_label = "Clocked in" if action == "clock_in" else "Clocked out"
    update_status(
        state="CLOCKED_IN",
        message=f"{action_label}: {worker['name']} ID: {worker['employee_id'] or worker['id']}",
        worker_name=worker["name"],
        worker_id=worker["employee_id"] or str(worker["id"]),
        action=action,
        liveness_confirmed=False,
        confidence=1.0,
    )
    return jsonify({"success": True, "log_id": log_id, "worker_name": worker["name"], "action": action})


@app.route("/supervisor/unlock", methods=["POST"])
@kiosk_ui_auth_required
def supervisor_unlock():
    if _supervisor_attempt_limiter.is_locked():
        return jsonify({
            "success": False,
            "error": "Too many failed attempts. Try again later.",
            "retry_after_seconds": _supervisor_attempt_limiter.retry_after_seconds(),
        }), 429
    payload = request.get_json(silent=True) or {}
    if not has_valid_supervisor_credential(provided_pin=str(payload.get("pin", ""))):
        locked = _supervisor_attempt_limiter.record_failure()
        if locked:
            return jsonify({
                "success": False,
                "error": "Too many failed attempts. Try again later.",
                "retry_after_seconds": _supervisor_attempt_limiter.retry_after_seconds(),
            }), 429
        return jsonify({"success": False, "error": "Invalid supervisor passcode"}), 401
    _supervisor_attempt_limiter.record_success()
    response = jsonify({"success": True})
    response.set_cookie(
        KIOSK_SUPERVISOR_SESSION_COOKIE,
        supervisor_session_token(),
        max_age=SUPERVISOR_SESSION_TTL_SECONDS,
        httponly=True,
        samesite="Strict",
        secure=False,
    )
    return response


@app.route("/supervisor/lock", methods=["POST"])
@kiosk_ui_auth_required
def supervisor_lock():
    response = jsonify({"success": True})
    response.delete_cookie(KIOSK_SUPERVISOR_SESSION_COOKIE, samesite="Strict")
    return response


def start_server():
    """Run Flask app in a background daemon thread."""
    global _server_thread
    if _server_thread and _server_thread.is_alive():
        return _server_thread

    def _serve():
        app.run(
            host=get_kiosk_ui_host(),
            port=config.KIOSK_PORT,
            debug=False,
            use_reloader=False,
            threaded=True,
        )

    _server_thread = threading.Thread(target=_serve, daemon=True, name="kiosk-web")
    _server_thread.start()
    logger.info("Web UI started at http://%s:%d", get_kiosk_ui_host(), config.KIOSK_PORT)
    return _server_thread
