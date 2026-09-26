"""SQLite database manager for FW Gatekeeper kiosk."""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import numpy as np

import config

logger = logging.getLogger(__name__)
_local = threading.local()
_IDENTITY_NOT_CAPTURED = object()


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


def _migrate_worker_identity(conn: sqlite3.Connection):
    """Remove legacy name uniqueness without changing any local worker ids."""
    name_is_unique = any(
        index["unique"] and [row["name"] for row in conn.execute(
            f"PRAGMA index_info('{index['name']}')"
        )] == ["name"]
        for index in conn.execute("PRAGMA index_list(workers)").fetchall()
    )
    if name_is_unique:
        # Rebuilding is necessary: SQLite cannot drop a UNIQUE table constraint.
        # Keep sqlite_sequence too; a deleted worker id must never be reused.
        sequence = conn.execute("SELECT seq FROM sqlite_sequence WHERE name = 'workers'").fetchone()
        with conn:
            conn.execute("""CREATE TABLE workers_identity_migration (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL COLLATE NOCASE, employee_id TEXT,
                encoding_blob BLOB NOT NULL,
                enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
                photo_count INTEGER NOT NULL DEFAULT 0,
                photo_paths TEXT NOT NULL DEFAULT '[]', server_id TEXT
            )""")
            conn.execute("""INSERT INTO workers_identity_migration
                SELECT id, name, employee_id, COALESCE(encoding_blob, X''), COALESCE(enrolled_at, datetime('now')),
                       photo_count, photo_paths, server_id FROM workers""")
            conn.execute("DROP TABLE workers")
            conn.execute("ALTER TABLE workers_identity_migration RENAME TO workers")
            if sequence:
                conn.execute("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'workers'", (sequence[0],))
    conn.execute("CREATE INDEX IF NOT EXISTS idx_workers_name ON workers(name COLLATE NOCASE)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_server_id ON workers(server_id) WHERE server_id IS NOT NULL AND server_id != ''")


def init_db():
    """Create and migrate required tables."""
    conn = _get_conn()
    _migrate_sync_state(conn)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS workers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL COLLATE NOCASE,
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

        CREATE TABLE IF NOT EXISTS photo_cleanup_journal (
            path TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK(kind IN ('published', 'retired'))
        );

        CREATE TABLE IF NOT EXISTS attendance_rejections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            log_id INTEGER NOT NULL,
            reason TEXT NOT NULL,
            original_log_json TEXT NOT NULL,
            rejected_at TEXT NOT NULL DEFAULT (datetime('now')),
            released_at TEXT,
            release_note TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_active_rejection
            ON attendance_rejections(log_id) WHERE released_at IS NULL;

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

    _migrate_worker_identity(conn)

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
    # Replace the trigger on startup: the event's original identity is
    # immutable, so deletion only fills missing snapshots on legacy rows. A savepoint
    # keeps DROP + CREATE atomic even when init_db is called with no pending
    # DML transaction.
    conn.execute("SAVEPOINT install_attendance_delete_trigger")
    try:
        conn.execute("DROP TRIGGER IF EXISTS attendance_keep_server_id_before_worker_delete")
        conn.execute(
            """
            CREATE TRIGGER attendance_keep_server_id_before_worker_delete
            BEFORE DELETE ON workers FOR EACH ROW
            WHEN OLD.server_id IS NOT NULL AND OLD.server_id != ''
            BEGIN
                UPDATE attendance_log SET server_worker_id = OLD.server_id
                WHERE worker_id = OLD.id AND synced = 0
                  AND (server_worker_id IS NULL OR server_worker_id = '');
            END
            """
        )
        conn.execute("RELEASE SAVEPOINT install_attendance_delete_trigger")
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT install_attendance_delete_trigger")
        conn.execute("RELEASE SAVEPOINT install_attendance_delete_trigger")
        raise

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
    _ensure_column(conn, "recognition_attempts", "source_attempt_id", "source_attempt_id TEXT")
    _ensure_column(conn, "recognition_attempts", "legacy_source_attempt_id", "legacy_source_attempt_id TEXT")
    _ensure_column(conn, "recognition_attempts", "candidate_server_worker_id", "candidate_server_worker_id TEXT")

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
        # Names are labels, not identity. Only adopt a single local-only row;
        # a different server id must always receive its own local worker id.
        matches = conn.execute(
            "SELECT id, server_id, employee_id FROM workers WHERE name = ? COLLATE NOCASE AND (server_id IS NULL OR server_id = '')",
            (normalized_name,),
        ).fetchall()
        matches = [candidate for candidate in matches if not (
            normalized_employee_id and candidate["employee_id"]
            and normalized_employee_id != candidate["employee_id"]
        )]
        if len(matches) > 1:
            raise ValueError("Several local workers share this name; select a worker id.")
        row = matches[0] if matches else None
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
    worker = get_worker_by_name(name)
    if worker is None:
        return False
    cursor = conn.execute("DELETE FROM workers WHERE id = ?", (worker["id"],))
    conn.commit()
    return cursor.rowcount > 0


def remove_worker_by_server_id(server_id: str, *, strict_cleanup: bool = False) -> bool:
    """Remove a worker by server_id (see remove_worker for the attendance snapshot)."""
    conn = _get_conn()
    rows = conn.execute("SELECT photo_paths FROM workers WHERE server_id = ?", (server_id,)).fetchall()
    # The server-id filename remains attributable even when an older client
    # deleted the SQLite row without removing its thumbnail. Unknown legacy
    # filenames are never inferred from a worker's name and deleted here.
    photo_root = Path(config.PHOTO_DIR).resolve()
    owned = {photo_root / f"{server_id}.jpg"}
    for row in rows:
        owned.update(Path(path) for path in json.loads(row["photo_paths"] or "[]"))
    remaining_paths = conn.execute("SELECT photo_paths FROM workers WHERE server_id IS NULL OR server_id != ?", (server_id,)).fetchall()
    referenced = {
        Path(path).resolve()
        for row in remaining_paths for path in json.loads(row["photo_paths"] or "[]")
    }
    retired = [path for path in owned if path.resolve() not in referenced]
    record_photo_cleanup(retired, "retired")
    cursor = conn.execute("DELETE FROM workers WHERE server_id = ?", (server_id,))
    conn.commit()
    try:
        recover_photo_cleanup()
    except (OSError, ValueError) as exc:
        if strict_cleanup:
            raise
        logger.warning("Worker deactivated; thumbnail cleanup remains pending: %s", exc)
    return cursor.rowcount > 0


def get_synced_server_ids() -> set[str]:
    """Server identities currently cached on this kiosk."""
    conn = _get_conn()
    return {row[0] for row in conn.execute(
        "SELECT server_id FROM workers WHERE server_id IS NOT NULL AND server_id != ''"
    )}


def replaced_worker_photo_paths(server_id: str, keep_paths: list[str]) -> list[Path]:
    """Identify owned thumbnails to retire after replacement is durable."""
    conn = _get_conn()
    row = conn.execute("SELECT photo_paths FROM workers WHERE server_id = ?", (server_id,)).fetchone()
    photo_root = Path(config.PHOTO_DIR).resolve()
    keep = {Path(path).resolve() for path in keep_paths}
    owned = {photo_root / f"{server_id}.jpg"}
    if row is not None:
        owned.update(Path(path) for path in json.loads(row["photo_paths"] or "[]"))
    others = conn.execute("SELECT photo_paths FROM workers WHERE server_id IS NULL OR server_id != ?", (server_id,))
    referenced = {Path(path).resolve() for other in others for path in json.loads(other[0] or "[]")}
    retired = []
    for path in owned:
        candidate = path.resolve()
        if candidate == photo_root or not candidate.is_relative_to(photo_root):
            raise ValueError(f"Worker photo path needs manual cleanup: {path}")
        if candidate not in keep and candidate not in referenced:
            retired.append(candidate)
    return retired


def record_photo_cleanup(paths: list[Path], kind: str) -> None:
    """Persist ownership before a file operation can outlive a process."""
    if not paths:
        return
    conn = _get_conn()
    conn.executemany(
        "INSERT OR REPLACE INTO photo_cleanup_journal (path, kind) VALUES (?, ?)",
        ((str(path), kind) for path in paths),
    )
    conn.commit()


def recover_photo_cleanup() -> None:
    """Remove only journaled, unreferenced files; unknown files stay untouched."""
    conn = _get_conn()
    photo_root = Path(config.PHOTO_DIR).resolve()
    references = {
        Path(path).resolve()
        for row in conn.execute("SELECT photo_paths FROM workers")
        for path in json.loads(row["photo_paths"] or "[]")
    }
    journal = conn.execute("SELECT path, kind FROM photo_cleanup_journal ORDER BY path").fetchall()
    first_error = None
    for entry in journal:
        path = Path(entry["path"])
        candidate = path.resolve()
        if entry["kind"] == "published" and candidate in references:
            conn.execute("DELETE FROM photo_cleanup_journal WHERE path = ?", (entry["path"],))
            conn.commit()
            continue
        if entry["kind"] == "retired" and candidate in references:
            continue
        if not path.exists() and not path.is_symlink():
            conn.execute("DELETE FROM photo_cleanup_journal WHERE path = ?", (entry["path"],))
            conn.commit()
            continue
        if candidate == photo_root or not candidate.is_relative_to(photo_root):
            first_error = first_error or ValueError(f"Worker photo path needs manual cleanup: {path}")
            continue
        try:
            candidate.unlink(missing_ok=True)
        except OSError as exc:
            first_error = first_error or exc
            continue
        conn.execute("DELETE FROM photo_cleanup_journal WHERE path = ?", (entry["path"],))
        conn.commit()
    if first_error:
        raise first_error


def count_unmanaged_local_workers() -> int:
    """Profiles without a server identity cannot be certified by roster sync."""
    conn = _get_conn()
    return int(conn.execute("SELECT COUNT(*) FROM workers WHERE server_id IS NULL OR server_id = ''").fetchone()[0])


def list_unreferenced_photo_files() -> list[str]:
    """Find files a roster receipt cannot certify or safely delete."""
    conn = _get_conn()
    photo_root = Path(config.PHOTO_DIR).resolve()
    if not photo_root.exists():
        return []
    rows = conn.execute("SELECT photo_paths FROM workers").fetchall()
    referenced = {
        Path(path).resolve()
        for row in rows for path in json.loads(row["photo_paths"] or "[]")
    }
    return sorted(str(path) for path in photo_root.rglob("*")
                  if (path.is_file() or path.is_symlink()) and
                  (not path.resolve().is_relative_to(photo_root) or path.resolve() not in referenced))


def get_worker_by_name(name: str) -> Optional[dict]:
    """Fetch worker by name (case-insensitive)."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id, name, employee_id, encoding_blob, enrolled_at, photo_count, photo_paths, server_id FROM workers WHERE name = ? COLLATE NOCASE LIMIT 2",
        (name.strip(),),
    ).fetchall()
    if len(rows) > 1:
        raise ValueError("Several workers share this name; select their employee ID from the roster.")
    if not rows:
        return None
    row = rows[0]
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


def get_unsynced_logs(limit: Optional[int] = None, after_id: int = 0) -> list[dict]:
    """Return unsynced gatekeeper logs for optional server sync."""
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT id, worker_id, worker_name, action, timestamp, liveness_confirmed, confidence, kiosk_id, note,
               server_worker_id
        FROM attendance_log
        WHERE synced = 0 AND id > ? AND NOT EXISTS (
            SELECT 1 FROM attendance_rejections r
            WHERE r.log_id = attendance_log.id AND r.released_at IS NULL
        )
        ORDER BY id ASC
        LIMIT ?
        """,
        (int(after_id), max(1, int(limit)) if limit is not None else -1),
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
    """Count all unsent logs, including quarantined evidence, for health reporting."""
    conn = _get_conn()
    row = conn.execute("""SELECT
        (SELECT COUNT(*) FROM attendance_log WHERE synced = 0) +
        (SELECT COUNT(*) FROM attendance_rejections r
         LEFT JOIN attendance_log l ON l.id = r.log_id
         WHERE r.released_at IS NULL AND l.id IS NULL)""").fetchone()
    return int(row[0]) if row else 0


def count_rejected_logs() -> int:
    """Count active attendance rejections, including orphaned evidence."""
    conn = _get_conn()
    row = conn.execute("SELECT COUNT(*) FROM attendance_rejections WHERE released_at IS NULL").fetchone()
    return int(row[0]) if row else 0


def count_retryable_logs() -> int:
    """Count unsent attendance rows that the sync worker can currently upload."""
    conn = _get_conn()
    row = conn.execute("""SELECT COUNT(*) FROM attendance_log l WHERE l.synced = 0
        AND NOT EXISTS (SELECT 1 FROM attendance_rejections r
            WHERE r.log_id = l.id AND r.released_at IS NULL)""").fetchone()
    return int(row[0]) if row else 0


def reject_attendance(log_id: int, reason: str) -> None:
    """Retain original evidence and rejection reason atomically with quarantine."""
    conn = _get_conn()
    with conn:
        row = conn.execute("SELECT * FROM attendance_log WHERE id = ? AND synced = 0", (log_id,)).fetchone()
        if row is None:
            raise ValueError(f"Unsynced attendance log {log_id} does not exist")
        conn.execute("""INSERT INTO attendance_rejections (log_id, reason, original_log_json)
            VALUES (?, ?, ?)""", (log_id, reason[:2000], json.dumps(dict(row), default=str)))


def list_attendance_rejections() -> list[dict]:
    conn = _get_conn()
    return [dict(row) for row in conn.execute("""SELECT r.*, l.synced, l.server_worker_id, l.timestamp
        FROM attendance_rejections r LEFT JOIN attendance_log l ON l.id = r.log_id
        WHERE r.released_at IS NULL ORDER BY r.id""")]


def retry_attendance_rejection(rejection_id: int, note: str) -> None:
    """Release a rejected event for another upload while preserving its audit record."""
    if not note.strip():
        raise ValueError("A reason for retry is required")
    conn = _get_conn()
    with conn:
        rejection = conn.execute("""SELECT r.log_id, l.id AS existing_log_id
            FROM attendance_rejections r LEFT JOIN attendance_log l ON l.id = r.log_id
            WHERE r.id = ? AND r.released_at IS NULL""", (rejection_id,)).fetchone()
        if rejection is None:
            raise ValueError(f"Active rejection {rejection_id} does not exist")
        if rejection["existing_log_id"] is None:
            raise ValueError(f"Attendance log {rejection['log_id']} is missing; restore the original evidence before retry")
        result = conn.execute("""UPDATE attendance_rejections
            SET released_at = datetime('now'), release_note = ?
            WHERE id = ? AND released_at IS NULL""", (note.strip(), rejection_id))
        if result.rowcount != 1:
            raise ValueError(f"Active rejection {rejection_id} does not exist")


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
    candidate_server_worker_id: Optional[str] | object = _IDENTITY_NOT_CAPTURED,
    best_score: Optional[float] = None,
    second_best_score: Optional[float] = None,
    score_margin: Optional[float] = None,
    threshold: Optional[float] = None,
    liveness_confirmed: bool = False,
    model_version: Optional[str] = None,
) -> int:
    """Store telemetry using the recognition snapshot when supplied.

    Explicit None means the matched roster entry had no server identity. Only
    legacy callers that omit the snapshot may resolve the current local mapping.
    """
    if candidate_server_worker_id is _IDENTITY_NOT_CAPTURED:
        candidate_server_worker_id = (
            get_server_id(candidate_worker_id) if candidate_worker_id is not None else None
        )
    conn = _get_conn()
    timestamp = timestamp or datetime.now().isoformat(timespec="seconds")
    cursor = conn.execute(
        """
        INSERT INTO recognition_attempts
            (
                timestamp, kiosk_id, face_detected, candidate_worker_id, candidate_worker_name,
                best_score, second_best_score, score_margin, decision, threshold,
                liveness_confirmed, model_version, source_attempt_id, candidate_server_worker_id, synced
            )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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
            str(uuid.uuid4()),
            candidate_server_worker_id,
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
            liveness_confirmed, model_version, source_attempt_id, legacy_source_attempt_id, candidate_server_worker_id
        FROM recognition_attempts
        WHERE synced = 0
        ORDER BY id ASC
        LIMIT ?
        """,
        (int(limit),),
    ).fetchall()
    # Legacy queued attempts may have reached the server before an acknowledgement
    # was lost. Keep their old identity as a migration alias, but persist a UUID
    # before any upload so retries and local database recreation cannot reuse IDs.
    with conn:
        for row in rows:
            if not row["source_attempt_id"]:
                conn.execute(
                    "UPDATE recognition_attempts SET source_attempt_id = ?, legacy_source_attempt_id = ?, "
                    "kiosk_id = ?, candidate_server_worker_id = ? "
                    "WHERE id = ? AND (source_attempt_id IS NULL OR source_attempt_id = '')",
                    (str(uuid.uuid4()), f"{row['kiosk_id'] or config.KIOSK_ID}:{row['id']}",
                     row["kiosk_id"] or config.KIOSK_ID,
                     get_server_id(row["candidate_worker_id"]) if row["candidate_worker_id"] is not None else None,
                     row["id"]),
                )
    attempts: list[dict] = []
    for row in rows:
        item = dict(row)
        if not item["source_attempt_id"]:
            identity = conn.execute(
                "SELECT source_attempt_id, legacy_source_attempt_id, kiosk_id, candidate_server_worker_id "
                "FROM recognition_attempts WHERE id = ?",
                (item["id"],),
            ).fetchone()
            item.update(dict(identity))
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


def delete_sync_state(key: str):
    conn = _get_conn()
    conn.execute("DELETE FROM sync_state WHERE key = ?", (key,))
    conn.commit()
