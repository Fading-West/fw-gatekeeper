"""Commit-pinned download and SHA-256 verification of the kiosk face model.

Pure standard library (no numpy/cv2) so it can be unit tested on any machine.

The kiosk and the face service MUST embed faces with byte-identical models:
if either side silently picked up a different upstream file, every match
would fail. Both therefore pin the same HuggingFace commit and digest.

Re-pin procedure (update ALL of the following together):
  1. sha=$(curl -sS https://huggingface.co/api/models/immich-app/buffalo_s | jq -r .sha)
  2. curl -sSL -o /tmp/rec.onnx \
       "https://huggingface.co/immich-app/buffalo_s/resolve/$sha/recognition/model.onnx"
  3. sha256sum /tmp/rec.onnx
  4. Set MODEL_COMMIT and REC_MODEL_SHA256 here, and the matching values in
     face-service/model_pinning.py and face-service/Dockerfile.
  5. Re-enroll or re-verify workers if the recognition model actually changed.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
import tempfile
import urllib.request
from pathlib import Path

logger = logging.getLogger(__name__)

MODEL_REPO = "immich-app/buffalo_s"
MODEL_COMMIT = "0ff1751885575e62e084dff70549ce24a11fa5dc"
REC_MODEL_URL = f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_COMMIT}/recognition/model.onnx"
REC_MODEL_SHA256 = "9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f"

DOWNLOAD_TIMEOUT_SECONDS = 120
_CHUNK_SIZE = 1024 * 1024


class ModelDigestMismatch(RuntimeError):
    """Raised when a model file's SHA-256 does not match its pinned digest."""


def sha256_of_file(path: Path | str) -> str:
    """Return the hex SHA-256 of ``path``, streaming so large files stay cheap."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_model_digest(path: Path | str, expected_sha256: str) -> str:
    """Verify ``path`` matches ``expected_sha256``.

    On mismatch the file is deleted (so a corrupt or drifted file can never be
    loaded on a later boot) and ModelDigestMismatch is raised. Returns the
    actual digest on success.
    """
    path = Path(path)
    actual = sha256_of_file(path)
    if actual.lower() != expected_sha256.lower():
        path.unlink(missing_ok=True)
        raise ModelDigestMismatch(
            f"{path} sha256 {actual} does not match pinned {expected_sha256}; file removed"
        )
    return actual


def _download(url: str, destination: Path) -> None:
    with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response, open(destination, "wb") as out:
        shutil.copyfileobj(response, out, _CHUNK_SIZE)


def ensure_pinned_model(url: str, path: Path | str, expected_sha256: str, *, label: str = "model") -> Path:
    """Make sure ``path`` holds the pinned model, downloading if needed.

    An already-present file is re-verified so a corrupt cached copy is caught;
    a mismatching file is deleted and fetched again. A fresh download is
    written to a temporary sibling, verified, then atomically moved into place.
    Raises on download failure or digest mismatch.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    if path.exists():
        try:
            verify_model_digest(path, expected_sha256)
            return path
        except ModelDigestMismatch as exc:
            logger.warning("Cached %s failed verification, re-downloading: %s", label, exc)

    # Concurrent cold-start requests must never share a partial download.
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", suffix=".part", delete=False) as handle:
        partial = Path(handle.name)
    logger.info("Downloading %s from %s", label, url)
    try:
        _download(url, partial)
        verify_model_digest(partial, expected_sha256)
    except Exception:
        partial.unlink(missing_ok=True)
        raise
    partial.replace(path)
    logger.info("Downloaded and verified %s at %s", label, path)
    return path
