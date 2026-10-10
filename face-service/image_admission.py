"""Bound the request bodies of authenticated image work held in memory at once.

``_image_lock`` serializes decoding, HOG and inference, but every waiting request
has already read and parsed its JSON body. Three concurrent maximum-size
/encode requests measured ~535 MiB in the service process, above Render's
512 MB instance. Admit image requests by declared body size instead: portal
captures (three 640px JPEGs, well under 1 MB) are never refused for one another,
while a second maximum-size request is refused without its body being buffered
or parsed.
"""
import threading

from starlette.datastructures import Headers
from starlette.responses import JSONResponse

from face_auth import FACE_SERVICE_KEY_HEADER, is_valid_face_service_key

IMAGE_PATHS = frozenset({"/encode", "/match"})
# One maximum /encode body (6 x 4,000,000 characters plus JSON) and ~8 MB more.
IN_FLIGHT_BODY_BUDGET = 32 * 1024 * 1024


def declared_body_size(headers: Headers, budget: int) -> int:
    """Declared Content-Length; unknown, chunked or malformed bodies count as the full budget."""
    values = headers.getlist("content-length")
    if len(values) != 1 or "transfer-encoding" in headers or not values[0].strip().isdigit():
        return budget
    return int(values[0])


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
        if not is_valid_face_service_key(headers.get(FACE_SERVICE_KEY_HEADER)):
            # Endpoint authentication still rejects these; unauthenticated callers
            # cannot occupy capacity reserved for the portal.
            await self.app(scope, receive, send)
            return
        size = declared_body_size(headers, self.budget)
        with self._lock:
            # Always admit when idle so one maximum-size request can still run.
            admitted = self.in_flight == 0 or self.in_flight + size <= self.budget
            if admitted:
                self.in_flight += size
        if not admitted:
            # Discard the body chunk by chunk (never buffered) so the client
            # receives the 503 instead of a connection reset mid-upload.
            while True:
                message = await receive()
                if message["type"] != "http.request" or not message.get("more_body", False):
                    break
            response = JSONResponse(
                {"detail": "Recognition service is busy. Please try again shortly."},
                status_code=503,
                headers={"Retry-After": "5"},
            )
            await response(scope, receive, send)
            return
        try:
            await self.app(scope, receive, send)
        finally:
            with self._lock:
                self.in_flight -= size
