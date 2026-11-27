"""Offline repair of a corrupt digest-specific kiosk model cache."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import embeddings


class LegacyModelRecoveryTests(unittest.TestCase):
    def test_corrupt_active_cache_uses_verified_legacy_model_on_first_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = root / "mobilefacenet.onnx"
            payload = b"synthetic model bytes"
            legacy.write_bytes(payload)
            digest = hashlib.sha256(payload).hexdigest()
            active = root / f"mobilefacenet-{digest}.onnx"
            active.write_bytes(b"corrupt active cache")

            from urllib.request import urlopen

            def offline_open(url, *args, **kwargs):
                if url != legacy.resolve().as_uri():
                    raise OSError("Kiosk is offline")
                return urlopen(url, *args, **kwargs)

            with (
                patch.object(embeddings, "REC_MODEL_PATH", active),
                patch.object(embeddings, "LEGACY_REC_MODEL_PATH", legacy),
                patch.object(embeddings, "REC_MODEL_SHA256", digest),
                patch("model_pinning.urllib.request.urlopen", side_effect=offline_open) as fetch,
            ):
                self.assertTrue(embeddings.ensure_rec_model())
                fetch.assert_called_once()
            self.assertEqual(active.read_bytes(), payload)
            self.assertEqual(legacy.read_bytes(), payload)


if __name__ == "__main__":
    unittest.main()
