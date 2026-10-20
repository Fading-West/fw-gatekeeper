import os
import unittest
from unittest.mock import patch

from face_auth import get_allowed_cors_origins, is_valid_face_service_key


class FaceServiceAuthTests(unittest.TestCase):
    def test_missing_configuration_rejects_every_key(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(is_valid_face_service_key(None))
            self.assertFalse(is_valid_face_service_key("candidate"))

    def test_invalid_key_is_rejected_and_valid_key_is_accepted(self):
        with patch.dict(os.environ, {"FACE_SERVICE_KEY": " expected-key "}, clear=True):
            self.assertFalse(is_valid_face_service_key("wrong-key"))
            self.assertTrue(is_valid_face_service_key("expected-key"))

    def test_non_ascii_keys_are_rejected_without_raising(self):
        with patch.dict(os.environ, {"FACE_SERVICE_KEY": "expected-key"}, clear=True):
            self.assertFalse(is_valid_face_service_key("\u00e9"))
            self.assertFalse(is_valid_face_service_key("\u0661\u0662\u0663\u0664"))
        with patch.dict(os.environ, {"FACE_SERVICE_KEY": "cl\u00e9-locale"}, clear=True):
            self.assertTrue(is_valid_face_service_key("cl\u00e9-locale"))
            self.assertFalse(is_valid_face_service_key("expected-key"))

    def test_cors_origins_are_normalized_and_wildcards_are_rejected(self):
        with patch.dict(
            os.environ,
            {"FACE_SERVICE_ALLOWED_ORIGINS": " https://one.example/,https://two.example "},
            clear=True,
        ):
            self.assertEqual(
                get_allowed_cors_origins(),
                ["https://one.example", "https://two.example"],
            )

        with patch.dict(os.environ, {"FACE_SERVICE_ALLOWED_ORIGINS": "*"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "must not contain"):
                get_allowed_cors_origins()


if __name__ == "__main__":
    unittest.main()
