"""Enrollment CLI for FW Gatekeeper kiosk.

Usage:
  py enroll.py add "Worker Name"
  py enroll.py list
  py enroll.py remove "Worker Name"
"""

from __future__ import annotations

import argparse
import logging
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import cv2
import face_recognition
import numpy as np
from flask import Flask, Response, jsonify

import config
import database
from embeddings import embed_face, model_ready, normalize_embedding
from liveness import LivenessChecker
from kiosk_ui_auth import get_enroll_preview_host

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("enroll")

SAMPLES_REQUIRED = 3
PREVIEW_PORT = 5556

_preview_lock = threading.Lock()
_preview_frame = None
_preview_status = {
    "message": "Waiting for camera",
    "captures": 0,
    "required": SAMPLES_REQUIRED,
    "ear": 0.0,
    "liveness": False,
}
_preview_server_thread = None
_preview_app = Flask(__name__)


@_preview_app.route("/")
def preview_index():
    return """
    <!DOCTYPE html>
    <html><head><title>Enrollment Preview</title>
    <style>
    body{margin:0;background:#111;color:#f2f2f2;font-family:Segoe UI,sans-serif;display:flex;flex-direction:column;align-items:center;padding:16px;}
    h1{color:#b8860b;font-size:1.4rem;margin:8px 0 12px;}
    img{border:2px solid #b8860b;border-radius:12px;max-width:96vw;width:760px;height:auto;background:#000;}
    .status{margin-top:12px;font-size:1rem;color:#ddd;}
    </style>
    </head><body>
      <h1>FW Enrollment Preview</h1>
      <img src="/feed" alt="preview">
      <div class="status" id="status">Loading...</div>
      <script>
      async function poll(){
        try{
          const r=await fetch('/status',{cache:'no-store'});
          const s=await r.json();
          document.getElementById('status').textContent =
            `Capture ${s.captures}/${s.required} | EAR ${Number(s.ear).toFixed(2)} | Live ${s.liveness ? 'Yes' : 'No'} | ${s.message}`;
        }catch(_e){}
      }
      setInterval(poll, 400);
      poll();
      </script>
    </body></html>
    """


@_preview_app.route("/feed")
def preview_feed():
    return Response(_preview_mjpeg(), mimetype="multipart/x-mixed-replace; boundary=frame")


@_preview_app.route("/status")
def preview_status():
    with _preview_lock:
        return jsonify(dict(_preview_status))


def _preview_mjpeg():
    while True:
        with _preview_lock:
            frame = _preview_frame
        if frame is not None:
            ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
            if ok:
                yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg.tobytes() + b"\r\n"
        time.sleep(0.05)


def _start_preview_server():
    global _preview_server_thread
    if _preview_server_thread and _preview_server_thread.is_alive():
        return

    def _serve():
        _preview_app.run(
            host=get_enroll_preview_host(),
            port=PREVIEW_PORT,
            debug=False,
            use_reloader=False,
            threaded=True,
        )

    _preview_server_thread = threading.Thread(target=_serve, daemon=True, name="enroll-preview")
    _preview_server_thread.start()


def _set_preview(frame, message: str, captures: int, ear: float, liveness: bool):
    with _preview_lock:
        global _preview_frame
        _preview_frame = frame.copy() if frame is not None else None
        _preview_status.update(
            {
                "message": message,
                "captures": captures,
                "required": SAMPLES_REQUIRED,
                "ear": float(ear),
                "liveness": bool(liveness),
            }
        )


def _safe_name(name: str) -> str:
    cleaned = "".join(ch for ch in name.strip() if ch.isalnum() or ch in "-_ ")
    return "_".join(cleaned.split())


def _largest_face(locations: list[tuple[int, int, int, int]]) -> tuple[int, int, int, int]:
    return max(locations, key=lambda loc: (loc[2] - loc[0]) * (loc[1] - loc[3]))


def _detect_primary_face(frame) -> Optional[tuple[int, int, int, int]]:
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    small_rgb = cv2.resize(rgb, (0, 0), fx=0.5, fy=0.5)
    small_locations = face_recognition.face_locations(small_rgb, model="hog")
    if not small_locations:
        return None
    top, right, bottom, left = _largest_face(small_locations)
    return int(top * 2), int(right * 2), int(bottom * 2), int(left * 2)


def add_worker(name: str):
    database.init_db()
    Path(config.FACES_DIR).mkdir(parents=True, exist_ok=True)

    worker_name = name.strip()
    if not worker_name:
        raise ValueError("Worker name is required.")

    try:
        liveness = LivenessChecker()
    except FileNotFoundError as exc:
        print(str(exc))
        return 1

    # Local enrollments must use the same 512-dim MobileFaceNet model the
    # scan loop matches with; a dlib encoding would be rejected at the door.
    if not model_ready():
        print("Recognition model unavailable (download failed or corrupt). Connect to the network once and retry.")
        return 1

    cap = cv2.VideoCapture(config.CAMERA_INDEX)
    if not cap.isOpened():
        print(f"Unable to open camera index {config.CAMERA_INDEX}")
        return 1

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.CAMERA_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.CAMERA_HEIGHT)

    _start_preview_server()
    print(f"Enrollment preview running at http://localhost:{PREVIEW_PORT}")
    print("Look at the camera and blink naturally. 3 live captures are required.")

    folder = Path(config.FACES_DIR) / _safe_name(worker_name)
    folder.mkdir(parents=True, exist_ok=True)

    encodings: list[np.ndarray] = []
    photo_paths: list[str] = []
    last_capture = 0.0

    try:
        while len(encodings) < SAMPLES_REQUIRED:
            ret, frame = cap.read()
            if not ret:
                liveness.reset()
                time.sleep(0.05)
                continue

            display = frame.copy()
            face_location = _detect_primary_face(frame)

            message = "Step into frame"
            live = liveness.update(frame, face_location)

            if face_location is not None:
                top, right, bottom, left = face_location
                cv2.rectangle(display, (left, top), (right, bottom), (0, 180, 255), 2)
                message = "Blink to verify"

                if live and (time.monotonic() - last_capture) > 1.0:
                    try:
                        encoding = embed_face(frame, face_location)
                    except Exception as exc:
                        print(f"Encoding failed: {exc}")
                        encoding = None
                    if encoding is not None:
                        capture_index = len(encodings) + 1
                        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                        photo_path = folder / f"capture_{capture_index}_{timestamp}.jpg"
                        cv2.imwrite(str(photo_path), frame)
                        encodings.append(encoding)
                        photo_paths.append(str(photo_path))
                        message = f"Captured sample {capture_index}/{SAMPLES_REQUIRED}"
                        liveness.reset()
                        live = False
                        last_capture = time.monotonic()
                    else:
                        message = "Face encoding failed, keep looking at camera"

            cv2.rectangle(display, (0, 0), (display.shape[1], 90), (10, 10, 10), -1)
            cv2.putText(
                display,
                f"Enrollment: {worker_name}",
                (10, 26),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.65,
                (184, 134, 11),
                2,
            )
            cv2.putText(
                display,
                f"Capture {len(encodings)}/{SAMPLES_REQUIRED} | EAR {liveness.get_ear():.2f}",
                (10, 52),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.58,
                (240, 240, 240),
                2,
            )
            cv2.putText(
                display,
                message,
                (10, 77),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.58,
                (240, 240, 240),
                2,
            )

            _set_preview(display, message, len(encodings), liveness.get_ear(), live)
            time.sleep(0.03)

    except KeyboardInterrupt:
        print("Enrollment cancelled.")
        return 1
    finally:
        cap.release()

    if len(encodings) < SAMPLES_REQUIRED:
        print("Enrollment failed before all required captures were collected.")
        return 1

    average_encoding = normalize_embedding(np.mean(np.vstack(encodings), axis=0))
    worker_id = database.add_worker(
        name=worker_name,
        encoding=average_encoding,
        photo_paths=photo_paths,
        enrolled_at=datetime.now().isoformat(timespec="seconds"),
    )

    print(f"Enrolled '{worker_name}' (id={worker_id})")
    print(f"Saved {len(photo_paths)} photos under: {folder}")
    return 0


def list_workers():
    database.init_db()
    workers = database.list_workers()
    if not workers:
        print("No workers enrolled.")
        return 0

    print("Enrolled workers:")
    for worker in workers:
        print(
            f"- #{worker['id']:03d} | {worker['name']} | "
            f"photos={worker['photo_count']} | enrolled_at={worker['enrolled_at']}"
        )
    return 0


def remove_worker(name: str):
    database.init_db()
    worker = database.get_worker_by_name(name)
    if worker is None:
        print(f"Worker not found: {name}")
        return 1

    for photo_path in worker.get("photo_paths", []):
        path = Path(photo_path)
        if path.exists():
            path.unlink()

    folder = Path(config.FACES_DIR) / _safe_name(worker["name"])
    if folder.exists() and folder.is_dir():
        shutil.rmtree(folder, ignore_errors=True)

    if database.remove_worker(worker["name"]):
        print(f"Removed worker: {worker['name']}")
        return 0

    print(f"Failed to remove worker: {worker['name']}")
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="FW Gatekeeper enrollment tool")
    subparsers = parser.add_subparsers(dest="command", required=True)

    add_parser = subparsers.add_parser("add", help="Enroll a worker")
    add_parser.add_argument("name", type=str, help="Worker full name")

    subparsers.add_parser("list", help="List enrolled workers")

    remove_parser = subparsers.add_parser("remove", help="Remove a worker")
    remove_parser.add_argument("name", type=str, help="Worker full name")

    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "add":
        return add_worker(args.name)
    if args.command == "list":
        return list_workers()
    if args.command == "remove":
        return remove_worker(args.name)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
