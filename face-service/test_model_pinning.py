import hashlib
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import io
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from model_pinning import (
    DET_MODEL_SHA256,
    DET_MODEL_URL,
    MODEL_COMMIT,
    REC_MODEL_SHA256,
    REC_MODEL_URL,
    ModelDigestMismatch,
    ensure_pinned_model,
    sha256_of_file,
    verify_model_digest,
)

SERVICE_DIR = Path(__file__).resolve().parent
KIOSK_PINNING = SERVICE_DIR.parent / "pi-kiosk" / "model_pinning.py"
COMMIT_PINNED_URL = re.compile(r"/resolve/([0-9a-f]{40})/")


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class FaceServiceModelPinningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "rec_model.onnx"
        self.payload = b"deterministic model bytes\n" * 4096
        self.path.write_bytes(self.payload)
        self.expected = hashlib.sha256(self.payload).hexdigest()

    def test_concurrent_downloads_use_separate_files(self):
        self.path.unlink()
        barrier = Barrier(2)
        def download(_url, destination):
            destination.write_bytes(self.payload)
            barrier.wait(timeout=5)
        with patch("model_pinning._download", side_effect=download):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: ensure_pinned_model("https://example.invalid/model", self.path, self.expected), range(2)))
        self.assertEqual(results, [self.path, self.path])
        self.assertEqual(self.path.read_bytes(), self.payload)
        self.assertEqual(list(self.path.parent.glob("*.part")), [])

    def test_sha256_helper_matches_hashlib(self):
        self.assertEqual(sha256_of_file(self.path), self.expected)

    def test_verification_passes_on_match(self):
        self.assertEqual(verify_model_digest(self.path, self.expected), self.expected)
        self.assertTrue(self.path.exists())

    def test_verification_deletes_file_and_raises_on_mismatch(self):
        with self.assertRaisesRegex(ModelDigestMismatch, "does not match pinned"):
            verify_model_digest(self.path, "f" * 64)
        self.assertFalse(self.path.exists())

    def test_ensure_pinned_model_refetches_corrupt_cache_and_rejects_drifted_download(self):
        self.path.write_bytes(b"corrupt")
        with patch("model_pinning.urllib.request.urlopen", return_value=_FakeResponse(self.payload)):
            with self.assertLogs("model_pinning", level="WARNING") as logs:
                ensure_pinned_model("https://example.invalid/m.onnx", self.path, self.expected)
        self.assertEqual(self.path.read_bytes(), self.payload)
        self.assertTrue(any("failed verification, re-downloading" in line for line in logs.output))

        self.path.unlink()
        with patch("model_pinning.urllib.request.urlopen", return_value=_FakeResponse(b"drifted")):
            with self.assertRaises(ModelDigestMismatch):
                ensure_pinned_model("https://example.invalid/m.onnx", self.path, self.expected)
        self.assertFalse(self.path.exists())
        self.assertFalse(self.path.with_name("rec_model.onnx.part").exists())

    def test_model_urls_are_pinned_to_a_commit_not_a_branch(self):
        for url in (DET_MODEL_URL, REC_MODEL_URL):
            match = COMMIT_PINNED_URL.search(url)
            self.assertIsNotNone(match, f"model URL must pin a 40-hex commit: {url}")
            self.assertEqual(match.group(1), MODEL_COMMIT)
            self.assertNotIn("/resolve/main/", url)
        for digest in (DET_MODEL_SHA256, REC_MODEL_SHA256):
            self.assertRegex(digest, r"^[0-9a-f]{64}$")

    def test_main_and_dockerfile_use_the_same_pins(self):
        main_source = (SERVICE_DIR / "main.py").read_text(encoding="utf-8")
        dockerfile = (SERVICE_DIR / "Dockerfile").read_text(encoding="utf-8")

        self.assertIn("from model_pinning import", main_source)
        self.assertIn("ensure_pinned_model(", main_source)
        self.assertNotIn("resolve/main", main_source)
        self.assertNotIn("urlretrieve", main_source)

        self.assertNotIn("resolve/main", dockerfile)
        self.assertIn(DET_MODEL_URL, dockerfile)
        self.assertIn(REC_MODEL_URL, dockerfile)
        self.assertIn(f"{DET_MODEL_SHA256}  /app/models/det_model.onnx", dockerfile)
        self.assertIn(f"{REC_MODEL_SHA256}  /app/models/rec_model.onnx", dockerfile)
        self.assertRegex(dockerfile, r"sha256sum -c")
        self.assertRegex(dockerfile, r"COPY\s+model_pinning\.py")

    def test_kiosk_pins_the_same_recognition_model(self):
        kiosk_source = KIOSK_PINNING.read_text(encoding="utf-8")
        self.assertIn(f'MODEL_COMMIT = "{MODEL_COMMIT}"', kiosk_source)
        self.assertIn(f'REC_MODEL_SHA256 = "{REC_MODEL_SHA256}"', kiosk_source)


if __name__ == "__main__":
    unittest.main()
