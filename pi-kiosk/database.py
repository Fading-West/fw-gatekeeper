"""SQLite database manager for FW Gatekeeper kiosk."""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import numpy as np

import config

logger = logging.getLogger(__name__)
_local = threading.local()


def _serialize_encoding(encoding: np.ndarray) -> bytes:
    return np.asarray(encoding, dtype=np.float64).tobytes()


def _deserialize_encoding(raw_value) -> np.ndarray:
    if raw_value is None:
        return np.array([], dtype=np.float64)
    if isinstance(raw_value, (bytes, bytearray, memoryview)):
        return np.frombuffer(raw_value, dtype=np.float64)
    if isinstance(raw_value, str):
        # Backward compatibility with older JSON-text schema.
        return np.array(json.loads(raw_value), dtype=np.float64)
    raise ValueError(f"Unsupported encoding format: {type(raw_value)!r}")


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, ddl: str):
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")
        logger.info("Added column %s.%s", table, column)


def _get_conn() -> sqlite3.Connection:
    """Get a thread-local SQLite connection."""
    if not hasattr(_local, "conn") or _local.conn is None:
        db_path = Path(config.DB_PATH)
        db_path.parent.mkdir(parents=True, exist_ok=True)
        _local.conn = sqlite3.connect(str(db_path), check_same_thread=False)
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA foreign_keys=OFF")
    return _local.conn


def _migrate_sync_state(conn: sqlite3.Connection):
    """Convert the legacy single-row sync_state table to a keyed table.

    The old schema stored one value in sync_state(id=1, last_sync); the only
    caller stored the worker-sync watermark there, so that value is carried
    over under the 'last_worker_sync' key to avoid a full re-backfill on
    already-deployed kiosks.
    """
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'"
    ).fetchone()
    if not row:
        return
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(sync_state)").fetchall()}
    if "last_sync" not in columns:
        return  # already keyed
    old = conn.execute("SELECT last_sync FROM sync_state WHERE id = 1").fetchone()
    old_value = old["last_sync"] if old else None
    conn.execute("DROP TABLE sync_state")
    conn.execute("CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT)")
    if old_value:
        conn.execute(
            "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_worker_sync', ?)",
            (old_value,),
        )
    logger.info("Migrated sync_state to keyed schema (last_worker_sync=%s)", old_value)


def init_db():
    """Create and migrate required tables."""
    conn = _get_conn()
    _migrate_sync_state(conn)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS workers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            employee_id TEXT,
            encoding_blob BLOB NOT NULL,
            enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
            photo_count INTEGER NOT NULL DEFAULT 0,
            photo_paths TEXT NOT NULL DEFAULT '[]',
            server_id TEXT
        );

        CREATE TABLE IF NOT EXISTS attendance_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            worker_id INTEGER NOT NULL,
            worker_name TEXT NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('clock_in', 'clock_out')),
            timestamp TEXT NOT NULL DEFAULT (datetime('now')),
            liveness_confirmed INTEGER NOT NULL DEFAULT 0,
            confidence REAL NOT NULL DEFAULT 0.0,
            kiosk_id TEXT NOT NULL DEFAULT '',
            synced INTEGER NOT NULL DEFAULT 0,
            note TEXT
        );

        CREATE TABLE IF NOT EXISTS recognition_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now')),
            kiosk_id TEXT NOT NULL DEFAULT '',
            face_detected INTEGER NOT NULL DEFAULT 0,
            candidate_worker_id INTEGER,
            candidate_worker_name TEXT,
            best_score REAL,
            second_best_score REAL,
            score_margin REAL,
            decision TEXT NOT NULL,
            threshold REAL,
            liveness_confirmed INTEGER NOT NULL DEFAULT 0,
            model_version TEXT,
            synced INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS sync_state (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_attendance_worker_time ON attendance_log(worker_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_recognition_attempts_sync ON recognition_attempts(synced, id);
        CREATE INDEX IF NOT EXISTS idx_recognition_attempts_time ON recognition_attempts(timestamp);
        """
    )

    # Migration support for previous schema versions.
    _ensure_column(conn, "workers", "encoding_blob", "encoding_blob BLOB")
    _ensure_column(conn, "workers", "employee_id", "employee_id TEXT")
    _ensure_column(conn, "workers", "enrolled_at", "enrolled_at TEXT DEFAULT (datetime('now'))")
    _ensure_column(conn, "workers", "photo_count", "photo_count INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "workers", "photo_paths", "photo_paths TEXT NOT NULL DEFAULT '[]'")
    _ensure_column(conn, "workers", "server_id", "server_id TEXT")

    _ensure_column(
        conn,
        "attendance_log",
        "action",
        "action TEXT CHECK(action IN ('clock_in', 'clock_out')) DEFAULT 'clock_in'",
    )
    _ensure_column(conn, "attendance_log", "liveness_confirmed", "liveness_confirmed INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "attendance_log", "confidence", "confidence REAL NOT NULL DEFAULT 0.0")
    _ensure_column(conn, "attendance_log", "kiosk_id", "kiosk_id TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "attendance_log", "synced", "synced INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "attendance_log", "note", "note TEXT")
    _ensure_column(conn, "attendance_log", "server_worker_id", "server_worker_id TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_attendance_sync ON attendance_log(synced, id)")
    # Enforced in the schema, not by convention: any DELETE FROM workers
    # (sync deactivation, enroll.py, hand-run sqlite3) first freezes the
    # server id onto that worker's queued attendance rows.
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS attendance_keep_server_id_before_worker_delete
        BEFORE DELETE ON workers FOR EACH ROW
        WHEN OLD.server_id IS NOT NULL AND OLD.server_id != ''
        BEGIN
            UPDATE attendance_log SET server_worker_id = OLD.server_id
            WHERE worker_id = OLD.id AND synced = 0
              AND (server_worker_id IS NULL OR server_worker_id = '');
        END
        """
    )

    _ensure_column(conn, "recognition_attempts", "timestamp", "timestamp TEXT NOT NULL DEFAULT (datetime('now'))")
    _ensure_column(conn, "recognition_attempts", "kiosk_id", "kiosk_id TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "recognition_attempts", "face_detected", "face_detected INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "recognition_attempts", "candidate_worker_id", "candidate_worker_id INTEGER")
    _ensure_column(conn, "recognition_attempts", "candidate_worker_name", "candidate_worker_name TEXT")
    _ensure_column(conn, "recognition_attempts", "best_score", "best_score REAL")
    _ensure_column(conn, "recognition_attempts", "second_best_score", "second_best_score REAL")
    _ensure_column(conn, "recognition_attempts", "score_margin", "score_margin REAL")
    _ensure_column(conn, "recognition_attempts", "decision", "decision TEXT NOT NULL DEFAULT 'unknown'")
    _ensure_column(conn, "recognition_attempts", "threshold", "threshold REAL")
    _ensure_column(conn, "recognition_attempts", "liveness_confirmed", "liveness_confirmed INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "recognition_attempts", "model_version", "model_version TEXT")
    _ensure_column(conn, "recognition_attempts", "synced", "synced INTEGER NOT NULL DEFAULT 0")

    worker_columns = {row["name"] for row in conn.execute("PRAGMA table_info(workers)").fetchall()}
    if "face_encoding" in worker_columns:
        rows = conn.execute(
            "SELECT id, face_encoding, encoding_blob FROM workers WHERE encoding_blob IS NULL OR length(encoding_blob) = 0"
        ).fetchall()
        for row in rows:
            old_value = row["face_encoding"]
            if old_value is None:
                continue
            try:
                converted = _serialize_encoding(np.array(json.loads(old_value), dtype=np.float64))
            except (json.JSONDecodeError, ValueError, TypeError):
                continue
            conn.execute("UPDATE workers SET encoding_blob = ? WHERE id = ?", (converted, row["id"]))

    # Copy old attendance event_type to action if needed.
    attendance_columns = {row["name"] for row in conn.execute("PRAGMA table_info(attendance_log)").fetchall()}
    if "event_type" in attendance_columns:
        conn.execute("UPDATE attendance_log SET action = event_type WHERE action IS NULL OR action = ''")

    # Rows written before server_worker_id existed still resolve through the
    # workers table today; freeze that mapping now so a later deactivation
    # cannot strand them.
    backfilled = _backfill_attendance_server_ids(conn)
    if backfilled:
        logger.info("Backfilled server_worker_id on %d attendance rows", backfilled)

    conn.commit()
    logger.info("Database initialized at %s", config.DB_PATH)


def _backfill_attendance_server_ids(conn: sqlite3.Connection) -> int:
    """Copy workers.server_id onto queued attendance rows that have no snapshot yet.

    Only unsynced rows matter: synced rows never need the mapping again, so
    this stays cheap no matter how much history the kiosk holds. Returns the
    number of rows updated.
    """
    cursor = conn.execute(
        """
        UPDATE attendance_log
        SET server_worker_id = (
            SELECT workers.server_id FROM workers WHERE workers.id = attendance_log.worker_id
        )
        WHERE synced = 0
          AND (server_worker_id IS NULL OR server_worker_id = '')
          AND EXISTS (
            SELECT 1 FROM workers
            WHERE workers.id = attendance_log.worker_id
              AND workers.server_id IS NOT NULL AND workers.server_id != ''
          )
        """
    )
    return cursor.rowcount


def add_worker(
    name: str,
    encoding: np.ndarray,
    photo_paths: Optional[list[str]] = None,
    enrolled_at: Optional[str] = None,
    server_id: Optional[str] = None,
    employee_id: Optional[str] = None,
) -> int:
    """Insert or update a worker and return worker id."""
    conn = _get_conn()
    encoding = np.asarray(encoding, dtype=np.float64)
    normalized_name = name.strip()
    if not normalized_name:
        raise ValueError("Worker name is required.")
    if encoding.ndim != 1 or encoding.size not in {128, 512}:
        raise ValueError("Worker encoding must be a 128-dim or 512-dim vector.")

    photo_paths = photo_paths or []
    payload_blob = _serialize_encoding(encoding)
    photo_paths_json = json.dumps(photo_paths)
    enrolled_at = enrolled_at or datetime.now().isoformat(timespec="seconds")
    normalized_employee_id = employee_id.strip() if isinstance(employee_id, str) else ""

    row = None
    if server_id is not None:
        row = conn.execute("SELECT id, server_id FROM workers WHERE server_id = ?", (server_id,)).fetchone()
    if row is None:
        row = conn.execute("SELECT id, server_id FROM workers WHERE lower(name) = lower(?)", (normalized_name,)).fetchone()
    stored_server_id = server_id
    if row:
        worker_id = int(row["id"])
        stored_server_id = server_id if server_id is not None else row["server_id"]
        conn.execute(
            """
            UPDATE workers
            SET name = ?, employee_id = ?, encoding_blob = ?, enrolled_at = ?, photo_count = ?, photo_paths = ?, server_id = ?
            WHERE id = ?
            """,
            (
                normalized_name,
                normalized_employee_id,
                payload_blob,
                enrolled_at,
                len(photo_paths),
                photo_paths_json,
                stored_server_id,
                worker_id,
            ),
        )
    else:
        cursor = conn.execute(
            """
            INSERT INTO workers (name, employee_id, encoding_blob, enrolled_at, photo_count, photo_paths, server_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (normalized_name, normalized_employee_id, payload_blob, enrolled_at, len(photo_paths), photo_paths_json, server_id),
        )
        worker_id = int(cursor.lastrowid)

    conn.commit()
    logger.info("Saved worker: %s (id=%d, server_id=%s)", normalized_name, worker_id, stored_server_id)
    return worker_id


def remove_worker(name: str) -> bool:
    """Remove a worker by case-insensitive name.

    The attendance_keep_server_id_before_worker_delete trigger snapshots the
    worker's server id onto queued attendance rows before the row goes."""
    conn = _get_conn()
    cursor = conn.execute("DELETE FROM workers WHERE lower(name) = lower(?)", (name.strip(),))
    conn.commit()
    return cursor.rowcount > 0


def remove_worker_by_server_id(server_id: str) -> bool:
    """Remove a worker by server_id (see remove_worker for the attendance snapshot)."""
    conn = _get_conn()
    cursor = conn.execute("DELETE FROM workers WHERE server_id = ?", (server_id,))
    conn.commit()
    return cursor.rowcount > 0


def get_worker_by_name(name: str) -> Optional[dict]:
    """Fetch worker by name (case-insensitive)."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT id, name, employee_id, encoding_blob, enrolled_at, photo_count, photo_paths, server_id FROM workers WHERE lower(name)=lower(?)",
        (name.strip(),),
    ).fetchone()
    if not row:
        return None
    encoding = _deserialize_encoding(row["encoding_blob"])
    return {
        "id": int(row["id"]),
        "name": row["name"],
        "employee_id": row["employee_id"] or "",
        "encoding_blob": encoding,
        "face_encoding": encoding,  # backward-compatible alias
        "enrolled_at": row["enrolled_at"],
        "photo_count": int(row["photo_count"] or 0),
        "photo_paths": json.loads(row["photo_paths"] or "[]"),
        "server_id": row["server_id"],
    }

def get_worker_by_id(worker_id: int) -> Optional[dict]:
    """Fetch worker by local SQLite id."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT id, name, employee_id, encoding_blob, enrolled_at, photo_count, photo_paths, server_id FROM workers WHERE id = ?",
        (int(worker_id),),
    ).fetchone()
    if not row:
        return None
    encoding = _deserialize_encoding(row["encoding_blob"])
    return {
        "id": int(row["id"]),
        "name": row["name"],
        "employee_id": row["employee_id"] or "",
        "encoding_blob": encoding,
        "face_encoding": encoding,
        "enrolled_at": row["enrolled_at"],
        "photo_count": int(row["photo_count"] or 0),
        "photo_paths": json.loads(row["photo_paths"] or "[]"),
        "server_id": row["server_id"],
    }


def get_all_workers() -> list[dict]:
    """Return all workers with decoded encodings."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id, name, employee_id, encoding_blob, enrolled_at, photo_count, photo_paths, server_id FROM workers ORDER BY name ASC"
    ).fetchall()
    workers = []
    for row in rows:
        encoding = _deserialize_encoding(row["encoding_blob"])
        workers.append(
            {
                "id": int(row["id"]),
                "name": row["name"],
                "employee_id": row["employee_id"] or "",
                "encoding_blob": encoding,
                "face_encoding": encoding,  # backward-compatible alias
                "enrolled_at": row["enrolled_at"],
                "photo_count": int(row["photo_count"] or 0),
                "photo_paths": json.loads(row["photo_paths"] or "[]"),
                "server_id": row["server_id"],
            }
        )
    return workers


def list_workers() -> list[dict]:
    """Worker list with enrollment metadata only."""
    workers = get_all_workers()
    return [
        {
            "id": worker["id"],
            "name": worker["name"],
            "employee_id": worker["employee_id"],
            "enrolled_at": worker["enrolled_at"],
            "photo_count": worker["photo_count"],
            "photo_paths": worker["photo_paths"],
            "server_id": worker["server_id"],
        }
        for worker in workers
    ]


def get_server_id(local_id: int) -> Optional[str]:
    """Return the Convex worker id for a local SQLite worker id."""
    conn = _get_conn()
    row = conn.execute("SELECT server_id FROM workers WHERE id = ?", (int(local_id),)).fetchone()
    if not row:
        return None
    return row["server_id"]

def has_workers_missing_employee_id() -> bool:
    """Return True when existing synced workers still need the new employee_id field backfilled."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT id FROM workers WHERE server_id IS NOT NULL AND employee_id IS NULL LIMIT 1"
    ).fetchone()
    return row is not None


def get_worker_roster() -> tuple[list[np.ndarray], list[int], list[str], dict[int, Optional[str]]]:
    """Return encodings, ids, names, and a local-id -> server-id map from one read."""
    workers = get_all_workers()
    encodings = [worker["encoding_blob"] for worker in workers]
    ids = [worker["id"] for worker in workers]
    names = [worker["name"] for worker in workers]
    server_ids = {worker["id"]: (worker["server_id"] or None) for worker in workers}
    return encodings, ids, names, server_ids


def get_worker_encodings() -> tuple[list[np.ndarray], list[int], list[str]]:
    """Return tuples of encodings, ids, and names."""
    encodings, ids, names, _ = get_worker_roster()
    return encodings, ids, names


def _normalize_action(action: str) -> str:
    value = action.strip().lower()
    if value not in {"clock_in", "clock_out"}:
        raise ValueError("action must be 'clock_in' or 'clock_out'")
    return value


def log_attendance(
    worker_id: int,
    worker_name: str,
    action: str,
    liveness_confirmed: bool = False,
    confidence: float = 0.0,
    timestamp: Optional[str] = None,
    note: Optional[str] = None,
    server_worker_id: Optional[str] = None,
) -> int:
    """Create a gatekeeper log entry and return log id.

    The worker's Convex id is snapshotted onto the row at write time so the
    event can still be synced if the local worker row is later removed.
    Callers that already hold the id (recognizer roster, manual clock) pass
    it in; otherwise it is looked up from the workers table.
    """
    conn = _get_conn()
    normalized_action = _normalize_action(action)
    timestamp = timestamp or datetime.now().isoformat(timespec="seconds")
    server_worker_id = server_worker_id or get_server_id(worker_id) or None
    cursor = conn.execute(
        """
        INSERT INTO attendance_log
            (worker_id, worker_name, action, timestamp, liveness_confirmed, confidence, kiosk_id, synced, note,
             server_worker_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        """,
        (
            int(worker_id),
            worker_name,
            normalized_action,
            timestamp,
            1 if liveness_confirmed else 0,
            float(confidence),
            config.KIOSK_ID,
            note,
            server_worker_id,
        ),
    )
    conn.commit()
    log_id = int(cursor.lastrowid)
    logger.info(
        "Gatekeeper logged: worker=%s action=%s confidence=%.3f live=%s",
        worker_name,
        normalized_action,
        confidence,
        liveness_confirmed,
    )
    return log_id


def was_recently_clocked(worker_id: int, minutes: int) -> bool:
    """Return True if worker has any recent clock event within N minutes."""
    conn = _get_conn()
    threshold = (datetime.now() - timedelta(minutes=minutes)).isoformat(timespec="seconds")
    row = conn.execute(
        """
        SELECT id FROM attendance_log
        WHERE worker_id = ? AND timestamp >= ?
        ORDER BY timestamp DESC LIMIT 1
        """,
        (worker_id, threshold),
    ).fetchone()
    return row is not None


def get_last_action(worker_id: int) -> Optional[str]:
    """Return last clock action for a worker."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT action FROM attendance_log WHERE worker_id = ? ORDER BY timestamp DESC LIMIT 1",
        (worker_id,),
    ).fetchone()
    return row["action"] if row else None


def get_today_logs(limit: int = 50) -> list[dict]:
    """Return today's gatekeeper activity."""
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT id, worker_id, worker_name, action, timestamp, liveness_confirmed, confidence, note
        FROM attendance_log
        WHERE date(timestamp) = date('now', 'localtime')
        ORDER BY timestamp DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    logs: list[dict] = []
    for row in rows:
        item = dict(row)
        item["liveness_confirmed"] = bool(item["liveness_confirmed"])
        item["event_type"] = item["action"]  # backward-compatible alias
        logs.append(item)
    return logs


def get_unsynced_logs() -> list[dict]:
    """Return unsynced gatekeeper logs for optional server sync."""
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT id, worker_id, worker_name, action, timestamp, liveness_confirmed, confidence, kiosk_id, note,
               server_worker_id
        FROM attendance_log
        WHERE synced = 0
        ORDER BY id ASC
        """
    ).fetchall()
    logs = []
    for row in rows:
        item = dict(row)
        item["event_type"] = item["action"]  # compatibility with older sync payloads
        logs.append(item)
    return logs


def mark_synced(log_ids: list[int]):
    """Mark selected gatekeeper logs as synced."""
    if not log_ids:
        return
    conn = _get_conn()
    placeholders = ",".join("?" for _ in log_ids)
    conn.execute(f"UPDATE attendance_log SET synced = 1 WHERE id IN ({placeholders})", log_ids)
    conn.commit()


def count_unsynced_logs() -> int:
    """Count gatekeeper logs still waiting to sync (for health reporting)."""
    conn = _get_conn()
    row = conn.execute("SELECT COUNT(*) FROM attendance_log WHERE synced = 0").fetchone()
    return int(row[0]) if row else 0


def count_unsynced_recognition_attempts() -> int:
    """Count recognition telemetry rows still waiting to sync."""
    conn = _get_conn()
    row = conn.execute("SELECT COUNT(*) FROM recognition_attempts WHERE synced = 0").fetchone()
    return int(row[0]) if row else 0


def _optional_float(value) -> Optional[float]:
    if value is None:
        return None
    return float(value)


def log_recognition_attempt(
    *,
    decision: str,
    timestamp: Optional[str] = None,
    kiosk_id: Optional[str] = None,
    face_detected: bool = False,
    candidate_worker_id: Optional[int] = None,
    candidate_worker_name: Optional[str] = None,
    best_score: Optional[float] = None,
    second_best_score: Optional[float] = None,
    score_margin: Optional[float] = None,
    threshold: Optional[float] = None,
    liveness_confirmed: bool = False,
    model_version: Optional[str] = None,
) -> int:
    """Store a non-image recognition telemetry attempt for calibration sync."""
    conn = _get_conn()
    timestamp = timestamp or datetime.now().isoformat(timespec="seconds")
    cursor = conn.execute(
        """
        INSERT INTO recognition_attempts
            (
                timestamp, kiosk_id, face_detected, candidate_worker_id, candidate_worker_name,
                best_score, second_best_score, score_margin, decision, threshold,
                liveness_confirmed, model_version, synced
            )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        """,
        (
            timestamp,
            kiosk_id or config.KIOSK_ID,
            1 if face_detected else 0,
            int(candidate_worker_id) if candidate_worker_id is not None else None,
            candidate_worker_name,
            _optional_float(best_score),
            _optional_float(second_best_score),
            _optional_float(score_margin),
            decision,
            _optional_float(threshold),
            1 if liveness_confirmed else 0,
            model_version,
        ),
    )
    conn.commit()
    attempt_id = int(cursor.lastrowid)
    logger.info(
        "Recognition attempt logged: decision=%s candidate=%s score=%s threshold=%s",
        decision,
        candidate_worker_name or "unknown",
        f"{best_score:.3f}" if best_score is not None else "n/a",
        f"{threshold:.3f}" if threshold is not None else "n/a",
    )
    return attempt_id


def get_unsynced_recognition_attempts(limit: int = 100) -> list[dict]:
    """Return unsynced recognition telemetry rows without any face image data."""
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT
            id, timestamp, kiosk_id, face_detected, candidate_worker_id, candidate_worker_name,
            best_score, second_best_score, score_margin, decision, threshold,
            liveness_confirmed, model_version
        FROM recognition_attempts
        WHERE synced = 0
        ORDER BY id ASC
        LIMIT ?
        """,
        (int(limit),),
    ).fetchall()
    attempts: list[dict] = []
    for row in rows:
        item = dict(row)
        item["face_detected"] = bool(item["face_detected"])
        item["liveness_confirmed"] = bool(item["liveness_confirmed"])
        attempts.append(item)
    return attempts


def mark_recognition_attempts_synced(attempt_ids: list[int]):
    """Mark selected recognition telemetry attempts as synced."""
    if not attempt_ids:
        return
    conn = _get_conn()
    placeholders = ",".join("?" for _ in attempt_ids)
    conn.execute(f"UPDATE recognition_attempts SET synced = 1 WHERE id IN ({placeholders})", attempt_ids)
    conn.commit()


def get_sync_state(key: str) -> Optional[str]:
    """Get a stored sync-state value by key (e.g. 'last_worker_sync')."""
    conn = _get_conn()
    row = conn.execute("SELECT value FROM sync_state WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_sync_state(key: str, value: str):
    """Set a sync-state value by key."""
    conn = _get_conn()
    conn.execute("INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)", (key, value))
    conn.commit()
