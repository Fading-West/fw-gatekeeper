"""Run the installer's model-download block with synthetic wget responses."""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


SETUP = Path(__file__).with_name("setup.sh").read_text()
MODEL_BLOCK = SETUP.split('ENABLE_LIVENESS="${ENABLE_LIVENESS:-0}"', 1)[1].split("mkdir -p data/faces", 1)[0]
PINNED_DIGEST = re.search(r'MODEL_SHA256="([0-9a-f]{64})"', MODEL_BLOCK).group(1)
PAYLOAD = b"synthetic complete landmark model\n" * 128


class SetupLivenessModelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.models = self.root / "data/models"
        self.models.mkdir(parents=True)
        self.model = self.models / "shape_predictor_68_face_landmarks.dat"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.payload = self.root / "payload.dat"
        self.payload.write_bytes(PAYLOAD)
        self.log = self.root / "wget.log"
        wget = self.bin / "wget"
        wget.write_text(
            f"#!{sys.executable}\n"
            "import os, pathlib, signal, sys\n"
            "args = sys.argv[1:]\n"
            "destination = pathlib.Path(args[args.index('-O') + 1])\n"
            "model = pathlib.Path(os.environ['TEST_MODEL'])\n"
            # A download must never write the live file, even when replacing it.
            "assert destination != model and destination.parent == model.parent\n"
            "actual = model.read_bytes().hex() if model.exists() else 'missing'\n"
            "assert actual == os.environ['TEST_ORIGINAL']\n"
            "with open(os.environ['TEST_LOG'], 'a') as log:\n"
            "    log.write(repr(args) + '\\n')\n"
            "payload = pathlib.Path(os.environ['TEST_PAYLOAD']).read_bytes()\n"
            "mode = os.environ['TEST_MODE']\n"
            "destination.write_bytes(payload if mode == 'complete' else payload[:10])\n"
            "if mode == 'signal':\n"
            "    os.kill(os.getppid(), signal.SIGTERM)\n"
            "sys.exit(4 if mode == 'failure' else 0)\n"
        )
        wget.chmod(0o755)

    def run_download(self, mode="complete", enabled="1"):
        # Keep the real sha256sum and the installer logic; only replace the pin
        # with our synthetic model's digest so these tests need no network.
        block = MODEL_BLOCK.replace(PINNED_DIGEST, hashlib.sha256(PAYLOAD).hexdigest())
        return subprocess.run(
            ["bash", "-c", "set -eo pipefail\n" + block], cwd=self.root,
            env=os.environ | {
                "PATH": f"{self.bin}:{os.environ['PATH']}", "ENABLE_LIVENESS": enabled,
                "TEST_MODEL": str(self.model.relative_to(self.root)),
                "TEST_ORIGINAL": self.model.read_bytes().hex() if self.model.exists() else "missing",
                "TEST_LOG": str(self.log), "TEST_PAYLOAD": str(self.payload), "TEST_MODE": mode,
            }, capture_output=True, text=True, timeout=10,
        )

    def assert_no_temporary_files(self):
        self.assertEqual(list(self.models.glob("*.part")), [])

    def test_missing_model_is_downloaded_and_verified(self):
        result = self.run_download()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.model.read_bytes(), PAYLOAD)
        self.assertIn("downloaded and verified", result.stdout)
        self.assert_no_temporary_files()

    def test_truncated_existing_model_is_replaced_and_valid_rerun_skips_download(self):
        self.model.write_bytes(PAYLOAD[:10])
        result = self.run_download()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.model.read_bytes(), PAYLOAD)
        calls = self.log.read_text()
        result = self.run_download()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("already exists and is verified", result.stdout)
        self.assertEqual(self.log.read_text(), calls)
        self.assert_no_temporary_files()

    def test_failed_or_truncated_download_never_replaces_live_file_and_can_retry(self):
        for mode in ["failure", "truncated", "signal"]:
            for cached in [False, True]:
                with self.subTest(mode=mode, cached=cached):
                    self.model.unlink(missing_ok=True)
                    if cached:
                        self.model.write_bytes(PAYLOAD[:5])
                    result = self.run_download(mode)
                    self.assertNotEqual(result.returncode, 0, result.stdout)
                    self.assertNotIn("downloaded and verified", result.stdout)
                    if cached:
                        self.assertEqual(self.model.read_bytes(), PAYLOAD[:5])
                    else:
                        self.assertFalse(self.model.exists())
                    self.assert_no_temporary_files()
                    result = self.run_download()
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(self.model.read_bytes(), PAYLOAD)
                    self.assert_no_temporary_files()

    def test_disabled_liveness_does_not_download_or_change_existing_model(self):
        self.model.write_bytes(PAYLOAD[:10])
        result = self.run_download(enabled="0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.log.exists())
        self.assertEqual(self.model.read_bytes(), PAYLOAD[:10])
        self.assert_no_temporary_files()

    def test_cleanup_preserves_another_downloads_temporary_file(self):
        other = self.models / "shape_predictor_68_face_landmarks.dat.other.part"
        other.write_bytes(b"another installer's download")
        result = self.run_download("failure")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.models.glob("*.part")), [other])
        self.assertEqual(other.read_bytes(), b"another installer's download")

    def test_upstream_download_is_commit_pinned_and_uncompressed(self):
        self.assertRegex(MODEL_BLOCK, r'https://raw\.githubusercontent\.com/italojs/facial-landmarks-recognition/[0-9a-f]{40}/shape_predictor_68_face_landmarks\.dat"')
        self.assertEqual(PINNED_DIGEST, "fbdc2cb80eb9aa7a758672cbfdda32ba6300efe9b6e6c7a299ff7e736b11b92f")


if __name__ == "__main__":
    unittest.main()
