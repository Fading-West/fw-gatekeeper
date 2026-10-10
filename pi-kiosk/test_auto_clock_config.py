"""Validate the auto shift window after normal per-kiosk config overrides."""

from pathlib import Path
import runpy
import sys
from types import ModuleType
import unittest
from unittest import mock


class AutoClockConfigTests(unittest.TestCase):
    def load_config(self, **overrides):
        local = ModuleType("config_local")
        local.__dict__.update(overrides)
        with mock.patch.dict(sys.modules, {"config_local": local}):
            return runpy.run_path(str(Path(__file__).with_name("config.py")))

    def test_default_and_positive_local_overrides(self):
        self.assertEqual(self.load_config()["AUTO_CLOCK_STALE_HOURS"], 16)
        for hours in (1, 16, 10.5):
            with self.subTest(hours=hours):
                self.assertEqual(self.load_config(AUTO_CLOCK_STALE_HOURS=hours)["AUTO_CLOCK_STALE_HOURS"], hours)

    def test_invalid_local_overrides_fail_with_setting_name(self):
        for hours in (0, -1, float("nan"), float("inf"), float("-inf"), True, False, "16", None,
                      1e308, 10 ** 1000):
            with self.subTest(hours=hours), self.assertRaisesRegex(ValueError, "AUTO_CLOCK_STALE_HOURS"):
                self.load_config(AUTO_CLOCK_STALE_HOURS=hours)


if __name__ == "__main__":
    unittest.main()
