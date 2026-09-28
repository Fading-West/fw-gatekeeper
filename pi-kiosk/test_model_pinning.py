#!/usr/bin/env python3
"""Behavioral coverage for the commit-pinned, digest-verified recognition model."""

import hashlib
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import io
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

KIOSK_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(KIOSK_DIR))

from model_pinning import (  # noqa: E402
    MODEL_COMMIT,
    REC_MODEL_SHA256,
    REC_MODEL_URL,
    ModelDigestMismatch,
    ensure_pinned_model,
    sha256_of_file,
    verify_model_digest,
)

COMMIT_PINNED_URL = re.compile(r"/resolve/([0-9a-f]{40})/")


class _FakeResponse(io.BytesIO):
    """Minimal stand-in for urllib's response: a readable context manager."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class ModelPinningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "model.onnx"
        self.payload = b"not really an onnx graph, but deterministic bytes\n" * 2048
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

    def test_verification_passes_on_match_and_keeps_file(self):
        self.assertEqual(verify_model_digest(self.path, self.expected), self.expected)
        self.assertEqual(verify_model_digest(self.path, self.expected.upper()), self.expected)
        self.assertTrue(self.path.exists())

    def test_verification_deletes_file_and_raises_on_mismatch(self):
        with self.assertRaisesRegex(ModelDigestMismatch, "does not match pinned"):
            verify_model_digest(self.path, "0" * 64)
        self.assertFalse(self.path.exists(), "a mismatching model must not be left on disk")

    def test_ensure_pinned_model_reverifies_cached_file_and_refetches_when_corrupt(self):
        self.path.write_bytes(b"corrupt")

        with patch("model_pinning.urllib.request.urlopen", return_value=_FakeResponse(self.payload)) as fetch:
            with self.assertLogs("model_pinning", level="WARNING") as logs:
                result = ensure_pinned_model("https://example.invalid/model.onnx", self.path, self.expected)

        fetch.assert_called_once()
        self.assertTrue(any("failed verification, re-downloading" in line for line in logs.output))
        self.assertEqual(result, self.path)
        self.assertEqual(self.path.read_bytes(), self.payload)
        self.assertFalse(self.path.with_name("model.onnx.part").exists())

    def test_ensure_pinned_model_does_not_download_when_cached_file_is_valid(self):
        with patch("model_pinning.urllib.request.urlopen") as fetch:
            ensure_pinned_model("https://example.invalid/model.onnx", self.path, self.expected)
        fetch.assert_not_called()

    def test_ensure_pinned_model_discards_download_that_fails_verification(self):
        self.path.unlink()

        with patch("model_pinning.urllib.request.urlopen", return_value=_FakeResponse(b"drifted upstream")):
            with self.assertRaises(ModelDigestMismatch):
                ensure_pinned_model("https://example.invalid/model.onnx", self.path, self.expected)

        self.assertFalse(self.path.exists())
        self.assertFalse(self.path.with_name("model.onnx.part").exists())

    def test_rec_model_url_is_pinned_to_a_commit_not_a_branch(self):
        match = COMMIT_PINNED_URL.search(REC_MODEL_URL)
        self.assertIsNotNone(match, f"REC_MODEL_URL must pin a 40-hex commit: {REC_MODEL_URL}")
        self.assertEqual(match.group(1), MODEL_COMMIT)
        self.assertNotIn("/resolve/main/", REC_MODEL_URL)
        self.assertRegex(REC_MODEL_SHA256, r"^[0-9a-f]{64}$")

    def test_embeddings_module_uses_the_pinned_constants(self):
        source = (KIOSK_DIR / "embeddings.py").read_text(encoding="utf-8")
        self.assertIn("from model_pinning import", source)
        self.assertIn("ensure_pinned_model(", source)
        self.assertNotIn("resolve/main", source)
        self.assertNotIn("urlretrieve", source)


if __name__ == "__main__":
    unittest.main()
