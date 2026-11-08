"""Broken site configuration must never silently restore kiosk defaults."""

import importlib.abc
import importlib.util
from pathlib import Path
import runpy
import sys
import unittest
from unittest import mock


class LocalConfigLoader(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def __init__(self, source):
        self.source = source

    def find_spec(self, fullname, path=None, target=None):
        if fullname == "config_local":
            if self.source is None:
                raise ModuleNotFoundError("No module named 'config_local'", name=fullname)
            return importlib.util.spec_from_loader(fullname, self)
        return None

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        exec(self.source, module.__dict__)


class LocalConfigImportTests(unittest.TestCase):
    def load_config(self, source):
        loader = LocalConfigLoader(source)
        with mock.patch.dict(sys.modules):
            sys.modules.pop("config_local", None)
            with mock.patch.object(sys, "meta_path", [loader, *sys.meta_path]):
                return runpy.run_path(str(Path(__file__).with_name("config.py")))

    def test_absent_optional_config_uses_defaults(self):
        config = self.load_config(None)
        self.assertEqual(config["KIOSK_TYPE"], "entry")
        self.assertFalse(config["LIVENESS_REQUIRED"])

    def test_valid_site_overrides_are_loaded(self):
        config = self.load_config('KIOSK_TYPE = "exit"\nLIVENESS_REQUIRED = True\n')
        self.assertEqual(config["KIOSK_TYPE"], "exit")
        self.assertTrue(config["LIVENESS_REQUIRED"])

    def test_missing_site_dependency_stops_configuration(self):
        with self.assertRaises(ModuleNotFoundError) as raised:
            self.load_config('KIOSK_TYPE = "exit"\nLIVENESS_REQUIRED = True\n'
                             'import synthetic_missing_site_dependency\n')
        self.assertEqual(raised.exception.name, "synthetic_missing_site_dependency")

    def test_invalid_import_in_site_config_stops_configuration(self):
        with self.assertRaises(ImportError):
            self.load_config('from math import nonexistent_setting\n')


if __name__ == "__main__":
    unittest.main()
