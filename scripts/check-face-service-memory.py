"""Measure face-service peak memory over HTTP with maximum-size /encode requests.

Runs uvicorn in a child process and reads its kernel high-water RSS (VmHWM), so
request bodies, JSON parsing, validation, decoding, HOG and inference all count.
Sends one maximum request, then three at once. CI runs this inside the built
image under a 512 MiB container limit:

    python scripts/check-face-service-memory.py --model /app/models/rec_model.onnx
"""
import argparse
import base64
import http.client
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
        [sys.executable, "-m", "uvicorn", "main:app", "--workers", "1", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=ROOT / "face-service", env=env,
        # Match Render's one worker and avoid fast CI cores draining requests
        # before the intended concurrency has reached the service.
        preexec_fn=lambda: os.sched_setaffinity(0, {min(os.sched_getaffinity(0))}),
    )
    base = f"http://127.0.0.1:{port}"

    def post(payload=None, key=KEY, path="/encode") -> tuple[int, float]:
        started = time.perf_counter()
        if payload is None:
            payload = body
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=600)
        try:
            try:
                connection.request("POST", path, body=payload, headers={
                    "content-type": "application/json", "x-face-service-key": key})
            except (BrokenPipeError, ConnectionResetError):
                # Immediate rejection may stop an upload before it finishes.
                # Read the already-sent HTTP response rather than losing its
                # status in a client-side write error.
                pass
            resp = connection.getresponse()
            resp.read()
            status = resp.status
        except OSError:
            status = 0  # connection reset/refused: reported as a failure below
        finally:
            connection.close()
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
        vector = np.random.default_rng(165).normal(size=512)
        vector = (vector / np.linalg.norm(vector)).tolist()
        # Exactly the maximum production roster, with real JSON float lengths
        # and a near-maximum noisy 4 MP photo. This exceeds the old 8 MiB cap.
        def matching_body(encoding, matching_photo):
            return json.dumps({"photo": matching_photo, "encodings": [
                {"worker_id": str(i).zfill(32), "encoding": encoding} for i in range(1001)]}).encode()
        full_match = matching_body(vector, photo)
        # Legal whitespace fills the byte limit independently of object count.
        padded = full_match + b" " * (24_065_536 - len(full_match))
        matching = post(padded, path="/match")
        del padded
        match_results = []
        threads = [threading.Thread(target=lambda: match_results.append(post(full_match, path="/match"))) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        # Fill the budget with parsed roster objects beside enrollment image work.
        four_photos = json.dumps({"photos": [photo] * 4}).encode()
        mixed_match_results = []
        threads = [threading.Thread(target=lambda: mixed_match_results.append(post(full_match, path="/match"))),
                   threading.Thread(target=lambda: mixed_match_results.append(post(four_photos)))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        del full_match, four_photos
        compact = matching_body([0.1]*512, photo)
        compact_results = []
        threads = [threading.Thread(target=lambda: compact_results.append(post(compact, path="/match"))) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        del compact
        match_oversized = post(iter([b" " * 65536] * 368), path="/match")
        # Compact hostile arrays must be rejected before object allocation.
        malicious = b'{"photo":"","encodings":[{"worker_id":"w","encoding":[' + b'0.1,'*6_000_000 + b'1]}]}'
        malformed = post(malicious, path="/match")
        del malicious
        print(f"Matching body bytes: {len(matching_body(vector, photo)):,}; padded at byte limit: {matching}")
        print(f"Three full rosters: {sorted(match_results)}; compact rosters: {sorted(compact_results)}")
        print(f"Match + four-photo enrollment: {sorted(mixed_match_results)}; oversized: {match_oversized}; malformed: {malformed}")
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
    if (matching[0] != 200 or sorted(status for status, _ in match_results) != [200, 200, 503]
            or sorted(status for status, _ in compact_results) != [200, 200, 503]
            or [status for status, _ in mixed_match_results] != [200, 200]
            or match_oversized[0] != 413 or malformed[0] != 422):
        failures.append(f"matching statuses {matching}/{match_results}/{match_oversized}")
    if peak >= args.limit_mib:
        failures.append(f"peak {peak:.1f} MiB >= {args.limit_mib} MiB")
    for failure in failures:
        print("FAIL:", failure)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
