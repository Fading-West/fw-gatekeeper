"""Parser safety, container counting and full API boundaries before object parsing."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import ijson
from fastapi import HTTPException

from bounded_json import check_structure


class BoundedJsonTests(unittest.TestCase):
    def test_numeric_overflow_cannot_crash_either_backend(self):
        # Isolate native parsing: a regression in ijson must fail this test,
        # rather than terminate the whole service/test runner with SIGSEGV.
        script = """
import sys
from fastapi import HTTPException
from bounded_json import check_structure
try:
    check_structure(sys.stdin.buffer.read(), '/match')
except HTTPException as error:
    assert error.status_code == 422
else:
    raise AssertionError('numeric overflow was accepted')
"""
        for backend in ("yajl2_c", "python"):
            for number in (b"1" * 5000, b"1e" + b"9" * 5000, b"1e400"):
                with self.subTest(backend=backend, length=len(number)):
                    result = subprocess.run(
                        [sys.executable, "-c", script],
                        input=b'{"photo":"","encodings":[],"ignored":' + number + b'}',
                        cwd=Path(__file__).resolve().parent,
                        env=dict(os.environ, IJSON_BACKEND=backend),
                        capture_output=True, timeout=30,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_full_encode_and_match_boundaries(self):
        check_structure(json.dumps({"photos": ["A" * 4_000_000] * 6}).encode(), "/encode")
        vector = [(-1 if i % 2 else 1) / 32 for i in range(512)]
        body = json.dumps({"photo": "A" * 4_000_000, "encodings": [
            {"worker_id": str(i), "encoding": vector} for i in range(1001)]}).encode()
        for backend in ("yajl2_c", "python"):
            with self.subTest(backend=backend), patch("bounded_json.ijson.parse", ijson.get_backend(backend).parse):
                check_structure(body, "/match")

    def test_nested_arrays_count_containers_once_and_reset_for_siblings(self):
        valid = {"photo": "", "encodings": [], "ignored": [[0] * 512, [0] * 512]}
        check_structure(json.dumps(valid).encode(), "/match")
        for nested in ([[0] * 513], [[]] * 513):
            with self.subTest(nested_length=len(nested)):
                with self.assertRaises(HTTPException) as error:
                    check_structure(json.dumps({**valid, "ignored": nested}).encode(), "/match")
                self.assertEqual(error.exception.status_code, 422)

    def test_event_limit_also_bounds_many_small_objects(self):
        # Maps have no array length, so their members must hit the event limit.
        body = json.dumps({"photos": ["a"], "ignored": {str(i): 0 for i in range(1024)}}).encode()
        with self.assertRaises(HTTPException) as error:
            check_structure(body, "/encode")
        self.assertEqual(error.exception.status_code, 422)

    def test_nonobject_roots_are_rejected_before_their_contents(self):
        for body in (b"[" + b"0," * 1000 + b"0]", b'"photo"', b"null"):
            with self.subTest(body=body[:12]), self.assertRaises(HTTPException) as error:
                check_structure(body, "/match")
            self.assertEqual(error.exception.status_code, 422)
            self.assertIn("must be an object", error.exception.detail)

    def test_escaped_keys_and_unicode_strings_cannot_bypass_limits(self):
        check_structure(b'{"pho\\u0074os":["a\\u00e9\\ud83d\\ude00\\\\\\\""]}', "/encode")
        for body in (
            b'{"pho\\u0074os":[' + b'"a",' * 6 + b'"a"]}',
            json.dumps({"photos": ["a" * 4_000_000 + "\U0001f600"]}, ensure_ascii=False).encode(),
            json.dumps({"photos": ["a"], "\U0001f600" * 257: None}).encode(),
            b'{"photos":["\xff"]}',
        ):
            with self.subTest(length=len(body)), self.assertRaises(HTTPException) as error:
                check_structure(body, "/encode")
            self.assertEqual(error.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
