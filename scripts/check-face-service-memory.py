"""Measure face-service peak memory over HTTP with maximum-size /encode requests.

Runs uvicorn in a child process and reads its kernel high-water RSS (VmHWM), so
request bodies, JSON parsing, validation, decoding, HOG and inference all count.
Sends one maximum request, then three at once. CI runs this inside the built
image under a 512 MiB container limit:

    python scripts/check-face-service-memory.py --model /app/models/rec_model.onnx
"""
import argparse
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MAX_PHOTO_CHARACTERS = 4_000_000
MAX_PHOTOS = 6
KEY = "memory-check-" + "k" * 32


def near_maximum_photo() -> str:
    """A 2000x2000 face JPEG with sensor-like noise, close to the 4,000,000-character limit."""
    face = cv2.resize(cv2.imread(str(ROOT / "face-service/fixtures/synthetic-1.jpg")), (2000, 2000))
    noise = np.random.default_rng(165).integers(-45, 46, face.shape, dtype=np.int16)
    frame = np.clip(face.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    for quality in range(95, 50, -1):
        ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        photo = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
        if ok and len(photo) <= MAX_PHOTO_CHARACTERS:
            return photo
    raise RuntimeError("could not build a photo within the size limit")


def kib(pid: int, field: str) -> int:
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith(field + ":"):
            return int(line.split()[1])
    raise RuntimeError(field)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="digest-verified rec_model.onnx")
    parser.add_argument("--limit-mib", type=float, default=450)
    args = parser.parse_args()

    photo = near_maximum_photo()
    body = json.dumps({"photos": [photo] * MAX_PHOTOS}).encode()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    env = dict(os.environ, FACE_SERVICE_KEY=KEY, FACE_MODEL_DIR=str(Path(args.model).resolve().parent))
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=ROOT / "face-service", env=env,
    )
    base = f"http://127.0.0.1:{port}"

    def post() -> tuple[int, float]:
        started = time.perf_counter()
        req = urllib.request.Request(f"{base}/encode", data=body, headers={
            "content-type": "application/json", "x-face-service-key": KEY})
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                resp.read()
                status = resp.status
        except urllib.error.HTTPError as exc:
            status = exc.code
        except OSError:
            status = 0  # connection reset/refused: reported as a failure below
        return status, round(time.perf_counter() - started, 2)

    try:
        for _ in range(600):
            try:
                with urllib.request.urlopen(f"{base}/health", timeout=5) as resp:
                    if json.load(resp).get("model_ready"):
                        break
            except OSError:
                pass
            if server.poll() is not None:
                raise RuntimeError("face service exited during startup")
            time.sleep(0.2)
        else:
            raise RuntimeError("face service model did not load")
        print(f"Photo characters: {len(photo):,}; request body bytes: {len(body):,}")
        print(f"After model load: {kib(server.pid, 'VmHWM') / 1024:.1f} MiB")

        single = post()
        single_peak = kib(server.pid, "VmHWM") / 1024
        print(f"One request (status, seconds): {single}; peak {single_peak:.1f} MiB")

        results: list[tuple[int, float]] = []
        threads = [threading.Thread(target=lambda: results.append(post())) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        peak = kib(server.pid, "VmHWM") / 1024
        print(f"Three concurrent requests (status, seconds): {sorted(results)}; peak {peak:.1f} MiB")
    finally:
        server.terminate()
        server.wait(timeout=30)

    statuses = [status for status, _ in results]
    failures = []
    if single[0] != 200:
        failures.append(f"single request returned {single[0]}")
    if not set(statuses) <= {200, 503} or 200 not in statuses:
        failures.append(f"concurrent statuses {statuses}")
    if peak >= args.limit_mib:
        failures.append(f"peak {peak:.1f} MiB >= {args.limit_mib} MiB")
    for failure in failures:
        print("FAIL:", failure)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
