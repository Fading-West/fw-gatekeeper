"""Bound the request bodies of authenticated image work held in memory at once.

``_image_lock`` serializes decoding, HOG and inference, but every waiting request
has already read and parsed its JSON body. Three concurrent maximum-size
/encode requests measured ~535 MiB in the service process, above Render's
512 MB instance. Admit image requests by declared body size instead: portal
captures (three 640px JPEGs, well under 1 MB) are never refused for one another,
while a second maximum-size request is refused without its body being buffered
or parsed. Actual received bytes enforce the same limit for chunked or
underdeclared bodies; no single body may exceed the budget. Authentication
also happens before FastAPI reads JSON.
"""
import threading

from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

from face_auth import FACE_SERVICE_KEY_HEADER, get_configured_face_service_key, is_valid_face_service_key

IMAGE_PATHS = frozenset({"/encode", "/match"})
# One maximum /encode body (6 x 4,000,000 characters plus JSON) and ~8 MB more.
IN_FLIGHT_BODY_BUDGET = 32 * 1024 * 1024
# JSON float vectors and matching arrays cost substantially more than base64
# strings: a valid 30.9 MiB /match roster measured 687 MiB peak RSS.
MATCH_BODY_WEIGHT = 4


def declared_body_size(headers: Headers, budget: int) -> int:
    """Declared Content-Length; unknown, chunked or malformed bodies count as the full budget."""
    values = headers.getlist("content-length")
    if len(values) != 1 or "transfer-encoding" in headers:
        return budget
    value = values[0].strip()
    if not value.isascii() or not value.isdigit():
        return budget
    value = value.lstrip("0") or "0"
    # Avoid Python's integer-string conversion limit on malformed headers.
    if len(value) > len(str(budget)):
        return budget + 1
    return int(value)


def body_error(status):
    details = {
        401: "Unauthorized",
        413: "Image request body is too large",
        503: "Recognition service is busy. Please try again shortly.",
    }
    return HTTPException(status, details[status],
                         headers={"Retry-After": "5"} if status == 503 else None)


async def refuse(scope, receive, send, status):
    # Drain without buffering, including after a partly consumed oversized body.
    while True:
        message = await receive()
        if message["type"] != "http.request" or not message.get("more_body", False):
            break
    error = body_error(status)
    response = JSONResponse({"detail": error.detail}, status_code=status, headers=error.headers)
    await response(scope, receive, send)


class ImageAdmissionMiddleware:
    def __init__(self, app, budget: int = IN_FLIGHT_BODY_BUDGET):
        self.app = app
        self.budget = budget
        self.in_flight = 0
        self._lock = threading.Lock()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"] not in IMAGE_PATHS:
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        if not get_configured_face_service_key():
            await refuse(scope, receive, send, 503)
            return
        if not is_valid_face_service_key(headers.get(FACE_SERVICE_KEY_HEADER)):
            # FastAPI reads JSON before running endpoint dependencies. Reject here
            # so unauthenticated bodies are never buffered or parsed.
            await refuse(scope, receive, send, 401)
            return
        weight = MATCH_BODY_WEIGHT if scope["path"] == "/match" else 1
        body_limit = self.budget // weight
        size = declared_body_size(headers, body_limit) * weight
        if size > self.budget:
            await refuse(scope, receive, send, 413)
            return
        with self._lock:
            admitted = self.in_flight + size <= self.budget
            if admitted:
                self.in_flight += size
        if not admitted:
            await refuse(scope, receive, send, 503)
            return
        received = 0

        async def bounded_receive():
            nonlocal size, received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                status = None
                if received > body_limit:
                    status = 413
                # Account for actual bytes too, even if an ASGI transport passes
                # more bytes than Content-Length promised.
                else:
                    with self._lock:
                        extra = max(0, received * weight - size)
                        if self.in_flight + extra > self.budget:
                            status = 503
                        else:
                            self.in_flight += extra
                            size += extra
                if status is not None:
                    if message.get("more_body", False):
                        while True:
                            remaining = await receive()
                            if remaining["type"] != "http.request" or not remaining.get("more_body", False):
                                break
                    # FastAPI propagates HTTPException from body reads instead
                    # of replacing it with a generic JSON parsing error.
                    raise body_error(status)
            return message

        try:
            await self.app(scope, bounded_receive, send)
        finally:
            with self._lock:
                self.in_flight -= size
