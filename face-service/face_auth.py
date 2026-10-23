"""Authentication and CORS policy for the public face service."""

import hmac
import os
from typing import Optional


FACE_SERVICE_KEY_HEADER = "x-face-service-key"
DEFAULT_ALLOWED_ORIGINS = "https://fw-gatekeeper.onrender.com"


def get_configured_face_service_key() -> Optional[str]:
    key = os.environ.get("FACE_SERVICE_KEY", "").strip()
    return key or None


def is_valid_face_service_key(provided_key: Optional[str]) -> bool:
    configured_key = get_configured_face_service_key()
    candidate = (provided_key or "").strip()
    if not configured_key or not candidate:
        return False
    # Compare bytes: str compare_digest raises TypeError on non-ASCII input.
    return hmac.compare_digest(
        candidate.encode("utf-8", "surrogatepass"),
        configured_key.encode("utf-8", "surrogatepass"),
    )


def get_allowed_cors_origins() -> list[str]:
    configured = os.environ.get("FACE_SERVICE_ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS)
    origins = [origin.strip().rstrip("/") for origin in configured.split(",") if origin.strip()]
    if "*" in origins:
        raise RuntimeError("FACE_SERVICE_ALLOWED_ORIGINS must not contain '*'")
    return origins
