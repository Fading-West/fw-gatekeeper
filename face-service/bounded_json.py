"""Check JSON structure with bounded parser state before FastAPI allocates objects.

Byte limits alone cannot bound a numeric roster's Python object expansion. This
streaming pass never constructs arrays/maps, and stops at the first excess item.
FastAPI retains responsibility for normal schema validation and JSON decoding.
"""
import io

import ijson
from fastapi import HTTPException
from fastapi.routing import APIRoute
from starlette.concurrency import run_in_threadpool

MAX_MATCH_ENCODINGS = 1001
EMBEDDING_DIMENSIONS = 512


def check_structure(body: bytes, path: str):
    matching = path == "/match"
    # A full match has 520 events per worker (512 numbers and eight framing
    # events). Allow some ignored fields, but bound those too.
    event_limit = MAX_MATCH_ENCODINGS * (EMBEDDING_DIMENSIONS + 8) + 1024 if matching else 1024
    arrays = []
    depth = 0
    expected = ({"photo": "string", "encodings": "start_array",
                 "encodings.item": "start_map", "encodings.item.encoding": "start_array",
                 "encodings.item.encoding.item": "number"} if matching else
                {"photos": "start_array", "photos.item": "string"})
    try:
        for count, (prefix, event, value) in enumerate(ijson.parse(io.BytesIO(body)), 1):
            if count > event_limit:
                raise HTTPException(422, "Image request JSON has too many values")
            # Prefixes include ancestor keys. Bound keys before a deeply nested
            # document can multiply a large key into many large prefix strings.
            if event == "map_key" and len(value) > 256:
                raise HTTPException(422, "Image request JSON key is too long")
            if event == "string" and len(value) > 4_000_000:
                raise HTTPException(422, "Image request JSON string is too long")
            if event not in ("map_key", "end_map", "end_array"):
                if prefix in expected and event != expected[prefix]:
                    raise HTTPException(422, "Invalid image request structure")
                if arrays and prefix == arrays[-1][0] + ".item":
                    arrays[-1][1] += 1
                    if arrays[-1][1] > arrays[-1][2]:
                        raise HTTPException(422, "Image request array is too long")
            if event in ("start_map", "start_array"):
                depth += 1
                if depth > 32:
                    raise HTTPException(422, "Image request JSON is too deeply nested")
                if event == "start_array":
                    limit = (MAX_MATCH_ENCODINGS if matching and prefix == "encodings" else
                             6 if not matching and prefix == "photos" else EMBEDDING_DIMENSIONS)
                    arrays.append([prefix, 0, limit])
            elif event in ("end_map", "end_array"):
                depth -= 1
                if event == "end_array":
                    arrays.pop()
    except (ijson.JSONError, ValueError, OverflowError):
        raise HTTPException(422, "Invalid image request JSON") from None


class BoundedImageJsonRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def bounded_handler(request):
            if request.method == "POST" and self.path in ("/encode", "/match"):
                # A full roster has half a million numeric events. Keep this
                # pass off the event loop so health/auth responses remain cheap.
                await run_in_threadpool(check_structure, await request.body(), self.path)
            return await handler(request)

        return bounded_handler
