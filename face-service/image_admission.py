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

from starlette._utils import get_route_path
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

from face_auth import FACE_SERVICE_KEY_HEADER, get_configured_face_service_key, is_valid_face_service_key

IMAGE_PATHS = frozenset({"/encode", "/match"})
# One maximum /encode body (6 x 4,000,000 characters plus JSON) and ~8 MB more.
IN_FLIGHT_BODY_BUDGET = 32 * 1024 * 1024
# Match rosters contain at most 1001 x 512 numbers, checked before JSON object
# allocation. Even short float spellings need room for the parsed roster, so
# reserve at least half the budget rather than weighting only the wire bytes.
MATCH_MIN_RESERVATION = 16 * 1024 * 1024
MAX_REQUEST_BODY_BYTES = 6 * 4_000_000 + 64 * 1024


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
    # Respond immediately. Uvicorn discards unread input after the response;
    # draining first lets a slow/chunked client delay rejection indefinitely.
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
        path = get_route_path(scope) if scope["type"] == "http" else None
        if scope["type"] != "http" or scope["method"] != "POST" or path not in IMAGE_PATHS:
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        if not get_configured_face_service_key():
            await JSONResponse({"detail": "Face service authentication is not configured"},
                               status_code=503)(scope, receive, send)
            return
        if not is_valid_face_service_key(headers.get(FACE_SERVICE_KEY_HEADER)):
            # FastAPI reads JSON before running endpoint dependencies. Reject here
            # so unauthenticated bodies are never buffered or parsed.
            await refuse(scope, receive, send, 401)
            return
        body_limit = min(self.budget, MAX_REQUEST_BODY_BYTES)
        declared = declared_body_size(headers, body_limit)
        if declared > body_limit:
            await refuse(scope, receive, send, 413)
            return
        minimum = min(self.budget, MATCH_MIN_RESERVATION) if path == "/match" else 0
        # Unknown framing returns body_limit; reserve the entire shared budget
        # until completion (also conservative for an exactly-at-limit body).
        size = self.budget if declared == body_limit else max(declared, minimum)
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
                        extra = max(0, received - size)
                        if self.in_flight + extra > self.budget:
                            status = 503
                        else:
                            self.in_flight += extra
                            size += extra
                if status is not None:
                    # FastAPI propagates HTTPException from body reads instead
                    # of replacing it with a generic JSON parsing error.
                    raise body_error(status)
            return message

        try:
            await self.app(scope, bounded_receive, send)
        finally:
            with self._lock:
                self.in_flight -= size
