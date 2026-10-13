"""Check JSON structure with bounded parser state before FastAPI allocates objects.

Byte limits alone cannot bound a numeric roster's Python object expansion. This
streaming pass never constructs arrays/maps, and stops at the first excess item.
FastAPI retains responsibility for normal schema validation and JSON decoding.
"""
import io
import re

import ijson
from fastapi import HTTPException
from fastapi.routing import APIRoute
from starlette.concurrency import run_in_threadpool

MAX_MATCH_ENCODINGS = 1001
EMBEDDING_DIMENSIONS = 512


def _check_events(body: bytes, path: str):
    matching = path == "/match"
    # A full match has 520 events per worker (512 numbers and eight framing
    # events). Allow some ignored fields, but bound those too.
    event_limit = MAX_MATCH_ENCODINGS * (EMBEDDING_DIMENSIONS + 8) + 1024 if matching else 1024
    arrays = []
    paths = [()]
    expected = ({("photo",): "string", ("encodings",): "start_array",
                 ("encodings", "item"): "start_map", ("encodings", "item", "encoding"): "start_array",
                 ("encodings", "item", "encoding", "item"): "number"} if matching else
                {("photos",): "start_array", ("photos", "item"): "string"})
    # basic_parse batches events without expanding path prefixes. Build paths
    # only after validating each key/depth, so parser read-ahead stays bounded.
    for count, (event, value) in enumerate(ijson.basic_parse(io.BytesIO(body), use_float=True), 1):
        if event in ("end_map", "end_array"):
            paths.pop()
        prefix = paths[-2] if event == "map_key" else paths[-1]
        if count == 1 and event != "start_map":
            raise HTTPException(422, "Image request JSON must be an object")
        if count > event_limit:
            raise HTTPException(422, "Image request JSON has too many values")
        # Validate keys before putting them in paths. Tuple paths also prevent
        # dots/empty keys from impersonating schema paths or hiding array items.
        if event == "map_key" and len(value) > 256:
            raise HTTPException(422, "Image request JSON key is too long")
        if event == "string" and len(value) > 4_000_000:
            raise HTTPException(422, "Image request JSON string is too long")
        if event not in ("map_key", "end_map", "end_array"):
            if prefix in expected and event != expected[prefix]:
                raise HTTPException(422, "Invalid image request structure")
            if arrays and prefix == arrays[-1][0] + ("item",):
                arrays[-1][1] += 1
                if arrays[-1][1] > arrays[-1][2]:
                    raise HTTPException(422, "Image request array is too long")
        if event in ("start_map", "start_array"):
            if len(paths) > 32:
                raise HTTPException(422, "Image request JSON is too deeply nested")
            if event == "start_array":
                limit = (MAX_MATCH_ENCODINGS if matching and prefix == ("encodings",) else
                         6 if not matching and prefix == ("photos",) else EMBEDDING_DIMENSIONS)
                arrays.append([prefix, 0, limit])
                paths.append(prefix + ("item",))
            else:
                paths.append(None)
        elif event == "map_key":
            paths[-1] = prefix + (value,)
        elif event == "end_array":
            arrays.pop()


# Consume every escape, including escaped backslashes, so literal "\\ud800"
# is not mistaken for a Unicode escape. YAJL replaces some lone surrogates;
# Python JSON preserves them and FastAPI cannot serialize validation errors.
_JSON_ESCAPE = re.compile(rb'\\(?:u([0-9a-fA-F]{4})|.)', re.DOTALL)


def check_structure(body: bytes, path: str):
    pending_high = None
    for escape in _JSON_ESCAPE.finditer(body):
        code = int(escape[1], 16) if escape[1] is not None else 0
        low = 0xDC00 <= code <= 0xDFFF
        if pending_high is not None:
            if escape.start() != pending_high or not low:
                raise HTTPException(422, "Invalid image request JSON")
            pending_high = None
        elif low:
            raise HTTPException(422, "Invalid image request JSON")
        elif 0xD800 <= code <= 0xDBFF:
            pending_high = escape.end()
    if pending_high is not None:
        raise HTTPException(422, "Invalid image request JSON")

    try:
        # Float mode avoids the native arbitrary-precision integer crash.
        _check_events(body, path)
    except (ijson.JSONError, ValueError, ArithmeticError):
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
