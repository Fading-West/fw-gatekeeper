"""Server synchronization for FW Gatekeeper Kiosk."""

import hashlib
import json
import logging
import os
import threading
import time
from datetime import datetime
from typing import Optional

import numpy as np
import requests

import config
import database
from sync_auth import require_kiosk_api_key

logger = logging.getLogger(__name__)


def _auth_headers() -> dict[str, str]:
    return {"x-kiosk-key": require_kiosk_api_key()}


def check_server() -> bool:
    """Check if the central server is reachable."""
    try:
        r = requests.get(f"{config.SERVER_URL}/api/health", timeout=5)
        return r.status_code == 200
    except Exception:
        return False


def _build_idempotency_key(log: dict, server_id: str) -> str:
    timestamp = str(log.get("timestamp") or "")
    action = str(log.get("event_type") or log.get("action") or "")
    kiosk_id = str(log.get("kiosk_id") or config.KIOSK_ID or "")
    raw_key = f"{server_id}|{timestamp}|{action}|{kiosk_id}"
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def _build_attempt_idempotency_key(attempt: dict) -> str:
    raw_key = "|".join(
        [
            "recognition_attempt",
            str(attempt.get("kiosk_id") or config.KIOSK_ID or ""),
            str(attempt.get("id") or ""),
            str(attempt.get("timestamp") or ""),
            str(attempt.get("decision") or ""),
        ]
    )
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


# Orphaned attendance rows (no server worker mapping) are reported once per
# distinct set, not once per row per 30-second cycle.
_last_orphan_signature: Optional[tuple] = None


def _resolve_log_server_id(log: dict, server_id_cache: dict[int, Optional[str]]) -> Optional[str]:
    """Prefer the server id snapshotted on the row; fall back to the live worker row."""
    snapshot = log.get("server_worker_id")
    if snapshot:
        return str(snapshot)
    local_worker_id = int(log["worker_id"])
    if local_worker_id not in server_id_cache:
        server_id_cache[local_worker_id] = database.get_server_id(local_worker_id)
    return server_id_cache[local_worker_id]


def _report_orphaned_logs(orphans: list[dict], total: int) -> None:
    global _last_orphan_signature
    signature = tuple(int(o["id"]) for o in orphans)
    if signature == _last_orphan_signature:
        logger.debug("Attendance sync: %d of %d queued logs still have no server worker mapping", len(orphans), total)
        return
    _last_orphan_signature = signature
    by_worker: dict[str, int] = {}
    for o in orphans:
        key = f"local_worker_id={o['worker_id']} name={o.get('worker_name')}"
        by_worker[key] = by_worker.get(key, 0) + 1
    logger.warning(
        "Attendance sync: %d of %d queued logs have no server worker mapping and will stay queued "
        "until server_worker_id is set or the rows are removed (%s); log ids=%s",
        len(orphans),
        total,
        "; ".join(f"{k} x{n}" for k, n in by_worker.items()),
        list(signature),
    )


def sync_attendance() -> bool:
    """POST unsynced gatekeeper logs to server. Returns True on success."""
    global _last_orphan_signature
    logs = database.get_unsynced_logs()
    if not logs:
        _last_orphan_signature = None
        return True

    payload_logs = []
    synced_log_ids = []
    orphans: list[dict] = []
    server_id_cache: dict[int, Optional[str]] = {}

    for log in logs:
        server_id = _resolve_log_server_id(log, server_id_cache)
        if not server_id:
            orphans.append(log)
            continue

        payload_logs.append(
            {
                "worker_id": server_id,
                "worker_name": log.get("worker_name"),
                "event_type": log.get("event_type") or log.get("action"),
                "action": log.get("action"),
                "timestamp": log.get("timestamp"),
                "idempotency_key": _build_idempotency_key(log, server_id),
                "liveness_confirmed": log.get("liveness_confirmed"),
                "confidence": log.get("confidence"),
                "kiosk_id": log.get("kiosk_id") or config.KIOSK_ID,
                "note": log.get("note"),
            }
        )
        synced_log_ids.append(int(log["id"]))

    missing_mappings = len(orphans)
    if orphans:
        _report_orphaned_logs(orphans, len(logs))
    else:
        _last_orphan_signature = None

    if not payload_logs:
        return False

    try:
        r = requests.post(
            f"{config.SERVER_URL}/api/attendance/bulk",
            json={"kiosk_id": config.KIOSK_ID, "logs": payload_logs},
            headers=_auth_headers(),
            timeout=15,
        )
        if r.status_code == 200:
            database.mark_synced(synced_log_ids)
            logger.info(
                "Synced %d gatekeeper logs to server%s",
                len(synced_log_ids),
                f"; {missing_mappings} still waiting for worker mappings" if missing_mappings else "",
            )
            return missing_mappings == 0
        else:
            logger.error(
                "Attendance sync failed with status=%d body=%s",
                r.status_code,
                r.text[:1000],
            )
            return False
    except requests.RequestException:
        logger.exception("Attendance sync request failed")
        return False


def sync_recognition_attempts() -> bool:
    """POST unsynced recognition calibration attempts to server."""
    attempts = database.get_unsynced_recognition_attempts()
    if not attempts:
        return True

    payload_attempts = []
    synced_attempt_ids = []
    server_id_cache: dict[int, Optional[str]] = {}

    for attempt in attempts:
        local_worker_id = attempt.get("candidate_worker_id")
        candidate_server_id = None
        if local_worker_id is not None:
            local_worker_id = int(local_worker_id)
            if local_worker_id not in server_id_cache:
                server_id_cache[local_worker_id] = database.get_server_id(local_worker_id)
            candidate_server_id = server_id_cache[local_worker_id]

        payload_attempts.append(
            {
                "localAttemptId": attempt.get("id"),
                "sourceAttemptId": f"{attempt.get('kiosk_id') or config.KIOSK_ID}:{attempt.get('id')}",
                "timestamp": attempt.get("timestamp"),
                "kioskId": attempt.get("kiosk_id") or config.KIOSK_ID,
                "faceDetected": attempt.get("face_detected"),
                "candidateWorkerId": candidate_server_id,
                "candidateLocalWorkerId": local_worker_id,
                "candidateWorkerName": attempt.get("candidate_worker_name"),
                "bestScore": attempt.get("best_score"),
                "secondBestScore": attempt.get("second_best_score"),
                "scoreMargin": attempt.get("score_margin"),
                "score": attempt.get("best_score"),
                "secondScore": attempt.get("second_best_score"),
                "margin": attempt.get("score_margin"),
                "decision": attempt.get("decision"),
                "threshold": attempt.get("threshold"),
                "livenessConfirmed": attempt.get("liveness_confirmed"),
                "livenessPassed": attempt.get("liveness_confirmed"),
                "modelVersion": attempt.get("model_version"),
                "idempotencyKey": _build_attempt_idempotency_key(attempt),
            }
        )
        synced_attempt_ids.append(int(attempt["id"]))

    try:
        r = requests.post(
            f"{config.SERVER_URL}{config.RECOGNITION_ATTEMPTS_ENDPOINT}",
            json={"kiosk_id": config.KIOSK_ID, "attempts": payload_attempts},
            headers=_auth_headers(),
            timeout=15,
        )
        if 200 <= r.status_code < 300:
            database.mark_recognition_attempts_synced(synced_attempt_ids)
            logger.info("Synced %d recognition attempts to server", len(synced_attempt_ids))
            return True

        logger.warning(
            "Recognition attempt sync failed with status=%d body=%s",
            r.status_code,
            r.text[:1000],
        )
        return False
    except requests.RequestException:
        logger.exception("Recognition attempt sync request failed")
        return False


def _health_params(health: Optional[dict]) -> dict:
    """Flatten kiosk health into sync query params the server stores per kiosk."""
    if not health:
        return {}
    params = {}
    for key in ("camera_ok", "model_ok", "liveness_available"):
        if health.get(key) is not None:
            params[key] = "1" if health[key] else "0"
    for key in ("known_workers", "queued_logs", "queued_attempts"):
        if health.get(key) is not None:
            params[key] = str(int(health[key]))
    for key in ("degraded_reason", "last_scan_at"):
        if health.get(key):
            params[key] = str(health[key])
    return params


def sync_workers(health: Optional[dict] = None) -> bool:
    """Download new/updated workers from server. Returns True on success."""
    if database.has_workers_missing_employee_id():
        # Existing kiosk databases created before employee_id support need one full
        # backfill so the scan-success screen can show the portal employee ID.
        last_sync = "2000-01-01T00:00:00"
    else:
        last_sync = database.get_sync_state("last_worker_sync") or "2000-01-01T00:00:00"

    try:
        r = requests.get(
            f"{config.SERVER_URL}/api/sync",
            params={"kiosk_id": config.KIOSK_ID, "since": last_sync, **_health_params(health)},
            headers=_auth_headers(),
            timeout=15,
        )
        if r.status_code != 200:
            logger.warning("Server returned %d during worker sync", r.status_code)
            return False

        data = r.json()
        workers = data.get("workers", [])

        for w in workers:
            server_id = w.get("id")
            name = w.get("name")
            employee_id = w.get("employee_id")
            encoding_data = w.get("face_encoding")
            photo_url = w.get("photo_url")
            enrolled_at = w.get("enrolled_at")
            is_active = bool(w.get("active"))

            if server_id and not is_active:
                if database.remove_worker_by_server_id(str(server_id)):
                    logger.info("Removed deactivated worker: %s (server_id=%s)", name or "unknown", server_id)
                continue

            if not server_id or not name or encoding_data is None:
                logger.warning("Skipping worker sync row with missing required fields: %s", w)
                continue

            encoding = np.array(encoding_data, dtype=np.float64)

            # Download photo if provided
            photo_path = None
            if photo_url:
                photo_path = _download_photo(name, photo_url)

            database.add_worker(
                name=name,
                encoding=encoding,
                photo_paths=[photo_path] if photo_path else [],
                enrolled_at=enrolled_at,
                server_id=str(server_id),
                employee_id=employee_id,
            )
            logger.info("Synced worker: %s (server_id=%s)", name, server_id)

        database.set_sync_state("last_worker_sync", data.get("synced_at") or datetime.now().isoformat())
        logger.info("Worker sync complete: %d workers", len(workers))
        return True

    except requests.RequestException as e:
        logger.warning("Worker sync failed: %s", e)
        return False
    except (json.JSONDecodeError, KeyError, ValueError) as e:
        logger.error("Invalid sync response: %s", e)
        return False


def _download_photo(name: str, url: str) -> Optional[str]:
    """Download a worker photo and save locally."""
    try:
        os.makedirs(config.PHOTO_DIR, exist_ok=True)
        safe_name = "".join(c if c.isalnum() or c in " -_" else "" for c in name).strip().replace(" ", "_")
        path = os.path.join(config.PHOTO_DIR, f"{safe_name}.jpg")
        r = requests.get(url, timeout=10)
        if r.status_code == 200:
            with open(path, "wb") as f:
                f.write(r.content)
            return path
    except Exception as e:
        logger.warning("Failed to download photo for %s: %s", name, e)
    return None


class SyncWorker:
    """Background thread that periodically syncs with the server."""

    def __init__(self, recognizer=None, health_provider=None, health_reporter=None):
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._recognizer = recognizer
        # health_provider() returns the kiosk's current health dict to send to
        # the server; health_reporter(**fields) pushes sync/queue state back to
        # the kiosk UI. Both are optional so this module stays UI-agnostic.
        self._health_provider = health_provider
        self._health_reporter = health_reporter
        self.server_online = False

    def start(self):
        """Start the sync background thread."""
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True, name="sync-worker")
        self._thread.start()
        logger.info("Sync worker started (interval=%ds)", config.SYNC_INTERVAL)

    def stop(self):
        """Stop the sync background thread."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)
        logger.info("Sync worker stopped")

    def _report(self, **fields):
        if self._health_reporter:
            try:
                self._health_reporter(**fields)
            except Exception as e:
                logger.debug("Health reporter failed: %s", e)

    def _run(self):
        """Main sync loop."""
        while self._running:
            try:
                queued_logs = database.count_unsynced_logs()
                queued_attempts = database.count_unsynced_recognition_attempts()
                self._report(queued_logs=queued_logs, queued_attempts=queued_attempts)

                self.server_online = check_server()
                self._report(sync_online=self.server_online)
                if self.server_online:
                    health = None
                    if self._health_provider:
                        try:
                            health = {
                                **self._health_provider(),
                                "queued_logs": queued_logs,
                                "queued_attempts": queued_attempts,
                            }
                        except Exception as e:
                            logger.debug("Health provider failed: %s", e)
                    workers_synced = sync_workers(health=health)
                    if workers_synced:
                        if self._recognizer:
                            self._recognizer.reload_faces()
                        self._report(last_sync_at=datetime.now().isoformat(timespec="seconds"))
                    sync_attendance()
                    sync_recognition_attempts()
                    self._report(
                        queued_logs=database.count_unsynced_logs(),
                        queued_attempts=database.count_unsynced_recognition_attempts(),
                    )
                else:
                    logger.debug("Server offline, skipping sync")
            except Exception as e:
                logger.error("Sync error: %s", e)

            # Sleep in small increments so we can stop quickly
            for _ in range(config.SYNC_INTERVAL):
                if not self._running:
                    break
                time.sleep(1)
