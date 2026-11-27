"""Field diagnostic for blink detection (liveness).

Standalone browser-based check of the camera, dlib HOG face detection, and the
blink-liveness pipeline used when LIVENESS_REQUIRED is enabled. Run it on a
kiosk (with the kiosk service stopped, so the camera is free) to verify the
shape predictor model and EAR thresholds before turning liveness on.

Run:  python3 tools/liveness_check.py   (from the pi-kiosk directory)
Open: http://127.0.0.1:5599 (loopback only)
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from typing import Optional

import cv2
import face_recognition
from flask import Flask, Response, jsonify

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402
from liveness import LivenessChecker  # noqa: E402

# Loopback-only diagnostic port; must not collide with the kiosk UI (:5555),
# the enrollment preview (:5556), or anything else the kiosk runs.
LIVENESS_CHECK_PORT = 5599

app = Flask(__name__)

_frame_lock = threading.Lock()
_frame = None

_status_lock = threading.Lock()
_status = {
    "message": "Starting camera",
    "camera_ok": False,
    "face_detected": False,
    "liveness": False,
    "ear": 0.0,
}

_running = True


def _set_frame(frame):
    global _frame
    with _frame_lock:
        _frame = frame.copy() if frame is not None else None


def _set_status(**kwargs):
    with _status_lock:
        _status.update(kwargs)


def _largest_face(locations: list[tuple[int, int, int, int]]) -> tuple[int, int, int, int]:
    return max(locations, key=lambda loc: (loc[2] - loc[0]) * (loc[1] - loc[3]))


def _detect_face(frame) -> Optional[tuple[int, int, int, int]]:
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    small_rgb = cv2.resize(rgb, (0, 0), fx=0.5, fy=0.5)
    small_locations = face_recognition.face_locations(small_rgb, model="hog")
    if not small_locations:
        return None
    top, right, bottom, left = _largest_face(small_locations)
    return int(top * 2), int(right * 2), int(bottom * 2), int(left * 2)


def _camera_loop():
    global _running

    try:
        liveness = LivenessChecker()
    except FileNotFoundError as exc:
        _set_status(message=str(exc), face_detected=False, liveness=False, ear=0.0)
        _running = False
        return

    cap = cv2.VideoCapture(config.CAMERA_INDEX)
    if not cap.isOpened():
        _set_status(message="Unable to open camera", face_detected=False, liveness=False, ear=0.0)
        _running = False
        return

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.CAMERA_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.CAMERA_HEIGHT)

    while _running:
        ret, frame = cap.read()
        if not ret:
            liveness.reset()
            _set_frame(None)
            _set_status(message="Camera frame unavailable", camera_ok=False,
                        face_detected=False, liveness=False, ear=0.0)
            time.sleep(0.05)
            continue

        display = frame.copy()
        face_location = _detect_face(frame)
        face_detected = face_location is not None
        live = False

        if face_detected:
            top, right, bottom, left = face_location
            live = liveness.update(frame, face_location)
            color = (0, 180, 255) if live else (0, 120, 255)
            cv2.rectangle(display, (left, top), (right, bottom), color, 2)
            message = "Live blink confirmed" if live else "Blink to verify"
        else:
            liveness.reset()
            message = "Step toward camera"

        cv2.rectangle(display, (0, 0), (display.shape[1], 88), (10, 10, 10), -1)
        cv2.putText(display, "Quick Liveness Test", (10, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.68, (184, 134, 11), 2)
        cv2.putText(display, f"EAR: {liveness.get_ear():.2f} | Live: {'Yes' if live else 'No'}", (10, 52), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (235, 235, 235), 2)
        cv2.putText(display, message, (10, 76), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (235, 235, 235), 2)

        _set_frame(display)
        _set_status(message=message, camera_ok=True, face_detected=face_detected,
                    liveness=live, ear=liveness.get_ear())
        time.sleep(0.03)

    cap.release()


def _stream():
    while _running:
        with _frame_lock:
            frame = _frame
        if frame is not None:
            ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
            if ok:
                yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg.tobytes() + b"\r\n"
        time.sleep(0.05)


@app.route("/")
def index():
    return """
    <!DOCTYPE html>
    <html><head><title>FW Quick Test</title>
    <style>
    body{margin:0;padding:16px;background:#0f1114;color:#eee;font-family:Segoe UI,sans-serif;display:flex;flex-direction:column;align-items:center;}
    h1{color:#b8860b;margin-bottom:12px;}
    img{border:2px solid #b8860b;border-radius:12px;max-width:95vw;background:#000;}
    #status{margin-top:12px;font-size:1rem;color:#ddd;}
    </style></head>
    <body>
      <h1>FW Gatekeeper Quick Test</h1>
      <img id="camera-feed" src="/feed" width="960" alt="camera feed" hidden>
      <div id="status">Loading...</div>
      <script>
      async function poll(){
        try{
          const r = await fetch('/status', {cache:'no-store'});
          const s = await r.json();
          document.getElementById('camera-feed').hidden = !s.camera_ok;
          document.getElementById('status').textContent =
            `Face ${s.face_detected ? 'detected' : 'not detected'} | EAR ${Number(s.ear).toFixed(2)} | Liveness ${s.liveness ? 'confirmed' : 'pending'} | ${s.message}`;
        }catch(_e){}
      }
      setInterval(poll, 400);
      poll();
      </script>
    </body></html>
    """


@app.route("/feed")
def feed():
    return Response(_stream(), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.route("/status")
def status():
    with _status_lock:
        return jsonify(dict(_status))


def main():
    worker = threading.Thread(target=_camera_loop, daemon=True)
    worker.start()
    time.sleep(0.8)
    print(f"Open http://127.0.0.1:{LIVENESS_CHECK_PORT} in your browser")
    try:
        app.run(host="127.0.0.1", port=LIVENESS_CHECK_PORT, debug=False, use_reloader=False, threaded=True)
    finally:
        global _running
        _running = False


if __name__ == "__main__":
    main()
