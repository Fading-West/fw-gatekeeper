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

    def post(payload=None, key=KEY, path="/encode") -> tuple[int, float]:
        started = time.perf_counter()
        if payload is None:
            payload = body
        req = urllib.request.Request(f"{base}{path}", data=payload, headers={
            "content-type": "application/json", "x-face-service-key": key})
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
        # Fill most of the remaining 32 MiB reservation beside a maximum
        # request, rather than testing only rejected large requests.
        smaller_body = json.dumps({"photos": [photo] * 2}).encode()
        mixed_results = []
        large = threading.Thread(target=lambda: mixed_results.append(post()))
        large.start()
        time.sleep(0.2)
        small = threading.Thread(target=lambda: mixed_results.append(post(smaller_body)))
        small.start()
        large.join()
        small.join()
        print(f"Maximum + two-photo requests: {sorted(mixed_results)}")
        # An iterable is sent with chunked framing and no Content-Length.
        # Both paths must drain without buffering or parsing a 32 MiB+ body.
        oversized = post(iter([b" " * 65536] * 513))
        unauthorized = post(iter([b" " * 65536] * 513), key="wrong-key")
        print(f"Oversized chunked request: {oversized}; unauthenticated: {unauthorized}")
        # The HTTP driver shares CI's container limit with the server. Release
        # enrollment payloads before constructing roster requests.
        body = smaller_body = b""
        photo = ""
        # Roster floats expand into Python objects and matching arrays. Use a
        # compressed 4 MP photo to leave most of the body for valid 512-d rows.
        frame = cv2.resize(cv2.imread(str(ROOT / "face-service/fixtures/synthetic-1.jpg")), (2000, 2000))
        ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ok:
            raise RuntimeError("could not build matching photo")
        prefix = json.dumps({"photo": base64.b64encode(jpeg).decode()})[:-1] + ',"encodings":['
        del frame, jpeg
        row = json.dumps({"worker_id": "worker", "encoding": [0.1] * 512}, separators=(",", ":"))
        def matching_body(limit):
            count = (limit - len(prefix) - 1024) // (len(row) + 1)
            return (prefix + ",".join([row] * count) + "]}").encode()
        matching = post(matching_body(8 * 1024 * 1024), path="/match")
        half_match = matching_body(4 * 1024 * 1024)
        match_results = []
        threads = [threading.Thread(target=lambda: match_results.append(post(half_match, path="/match"))) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        match_oversized = post(iter([b" " * 65536] * 129), path="/match")
        print(f"Near-limit matching: {matching}; concurrent half-size rosters: {sorted(match_results)}; oversized: {match_oversized}")
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
    if [status for status, _ in mixed_results] != [200, 200]:
        failures.append(f"mixed concurrent statuses {mixed_results}")
    if oversized[0] != 413 or unauthorized[0] != 401:
        failures.append(f"streaming rejection statuses {oversized[0]}/{unauthorized[0]}")
    if matching[0] != 200 or any(status != 200 for status, _ in match_results) or match_oversized[0] != 413:
        failures.append(f"matching statuses {matching}/{match_results}/{match_oversized}")
    if peak >= args.limit_mib:
        failures.append(f"peak {peak:.1f} MiB >= {args.limit_mib} MiB")
    for failure in failures:
        print("FAIL:", failure)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
