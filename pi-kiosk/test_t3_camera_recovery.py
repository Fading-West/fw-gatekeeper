"""Exercise production Camera with synthetic devices, without native models."""
import ast
import logging
import sys
import time
import types
import unittest
from pathlib import Path
from unittest import mock

import config

source = ast.parse(Path(__file__).with_name("main.py").read_text())
node = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == "Camera")
cv2 = types.SimpleNamespace(CAP_PROP_FRAME_WIDTH=1, CAP_PROP_FRAME_HEIGHT=2, COLOR_BGR2RGB=3, COLOR_RGB2BGR=4,
                            cvtColor=lambda frame, _: frame)
namespace = {"config": config, "cv2": cv2, "time": time, "logger": logging.getLogger(__name__)}
exec(compile(ast.Module(body=[node], type_ignores=[]), "main.py", "exec"), namespace)
Camera = namespace["Camera"]


def usb(*, opened=True, capture=True):
    camera = mock.Mock()
    camera.isOpened.return_value = opened
    camera.read.return_value = (capture, "synthetic-frame")
    return camera


class CameraRecoveryTests(unittest.TestCase):
    def test_disconnect_closes_old_handle_backoff_then_reopens(self):
        now = [0.0]
        old, replacement = usb(capture=False), usb()
        with mock.patch.object(cv2, "VideoCapture", side_effect=[old, replacement], create=True) as factory:
            camera = Camera("usb", retry_seconds=5, clock=lambda: now[0])
            camera.start()
            with self.assertRaises(RuntimeError):
                camera.capture()
            old.release.assert_called_once()
            now[0] = 4
            with self.assertRaises(RuntimeError):
                camera.capture()
            self.assertEqual(factory.call_count, 1)
            now[0] = 5
            self.assertEqual(camera.capture(), ("synthetic-frame", "synthetic-frame"))
            camera.stop()
            replacement.release.assert_called_once()

    def test_failed_reopens_release_resources_and_keep_retrying(self):
        now = [0.0]
        failed, healthy = usb(opened=False), usb()
        with mock.patch.object(cv2, "VideoCapture", side_effect=[failed, healthy], create=True) as factory:
            camera = Camera("usb", clock=lambda: now[0])
            with self.assertRaises(RuntimeError):
                camera.capture()
            failed.release.assert_called_once()
            with self.assertRaises(RuntimeError):
                camera.capture()
            self.assertEqual(factory.call_count, 1)
            now[0] = 5
            self.assertEqual(camera.capture()[0], "synthetic-frame")
            camera.stop()
            camera.stop()
            healthy.release.assert_called_once()

    def test_partial_pi_start_is_closed_before_usb_fallback(self):
        partial = mock.Mock()
        partial.configure.side_effect = RuntimeError("synthetic configuration failure")
        module = types.SimpleNamespace(Picamera2=lambda: partial)
        with mock.patch.dict(sys.modules, {"picamera2": module}), mock.patch.object(cv2, "VideoCapture", return_value=usb(), create=True):
            camera = Camera("auto")
            camera.start()
            partial.stop.assert_called_once()
            partial.close.assert_called_once()
            self.assertEqual(camera.capture()[0], "synthetic-frame")
            camera.stop()

    def test_pi_capture_fault_closes_and_reopens_original_mode(self):
        now = [0.0]
        old, healthy = mock.Mock(), mock.Mock()
        old.capture_array.side_effect = RuntimeError("synthetic disconnect")
        healthy.capture_array.return_value = "synthetic-frame"
        module = types.SimpleNamespace(Picamera2=mock.Mock(side_effect=[old, healthy]))
        with mock.patch.dict(sys.modules, {"picamera2": module}), mock.patch.object(time, "sleep"):
            camera = Camera("pi", clock=lambda: now[0])
            camera.start()
            with self.assertRaises(RuntimeError):
                camera.capture()
            old.close.assert_called_once()
            now[0] = 5
            self.assertEqual(camera.capture(), ("synthetic-frame", "synthetic-frame"))
            camera.stop()
            healthy.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
