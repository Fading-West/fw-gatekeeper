"""Camera.capture() must hand every consumer the same channel order for CSI and USB.

Picamera2 "RGB888" is laid out [B, G, R] in memory (OpenCV BGR), the same as
cv2.VideoCapture. A pure-red scene must therefore stay red in the BGR frame
(MJPEG preview, embeddings, liveness) and in the RGB frame (dlib detection).
"""
import sys
import types
import unittest
from unittest import mock

import cv2
import numpy as np

# main.py imports dlib-backed modules that are not installed in CI. Stub only
# the ones that are missing; camera capture does not use them.
for _name in ("face_recognition", "dlib"):
    try:
        __import__(_name)
    except ImportError:
        sys.modules[_name] = types.ModuleType(_name)
try:
    import scipy.spatial.distance  # noqa: F401
except ImportError:
    _distance = types.ModuleType("scipy.spatial.distance")
    _distance.euclidean = lambda a, b: float(np.linalg.norm(np.subtract(a, b)))
    sys.modules.setdefault("scipy", types.ModuleType("scipy"))
    sys.modules.setdefault("scipy.spatial", types.ModuleType("scipy.spatial"))
    sys.modules["scipy.spatial.distance"] = _distance

import embeddings  # noqa: E402
import main  # noqa: E402

HEIGHT, WIDTH = 8, 12
BGR_RED = (0, 0, 255)


def red_bgr_frame():
    """A pure-red scene as both Picamera2 RGB888 and cv2.VideoCapture deliver it."""
    frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    frame[:] = BGR_RED
    return frame


class FakePicamera2:
    configured_format = None

    def create_video_configuration(self, main):
        FakePicamera2.configured_format = main["format"]
        return {"main": main}

    def configure(self, config):
        pass

    def start(self):
        pass

    def stop(self):
        pass

    def capture_array(self):
        return red_bgr_frame()


class FakeVideoCapture:
    def __init__(self, index):
        pass

    def set(self, prop, value):
        return True

    def isOpened(self):
        return True

    def read(self):
        return True, red_bgr_frame()

    def release(self):
        pass


class FakeOnnxInput:
    name = "input.1"


class FakeOnnxSession:
    def __init__(self):
        self.batch = None

    def get_inputs(self):
        return [FakeOnnxInput()]

    def run(self, outputs, feeds):
        self.batch = feeds["input.1"]
        return [np.ones((1, 512), dtype=np.float32)]


def start_pi_camera():
    picamera2 = types.ModuleType("picamera2")
    picamera2.Picamera2 = FakePicamera2
    with mock.patch.dict(sys.modules, {"picamera2": picamera2}), mock.patch.object(main.time, "sleep"):
        camera = main.Camera(mode="pi")
        camera.start()
    return camera


def start_usb_camera():
    with mock.patch.object(main.cv2, "VideoCapture", FakeVideoCapture):
        camera = main.Camera(mode="usb")
        camera.start()
    return camera


class CameraColorOrderTests(unittest.TestCase):
    def assert_red_for_every_consumer(self, camera):
        bgr, rgb = camera.capture()

        # BGR frame: MJPEG preview, liveness and embed_face all treat it as BGR.
        self.assertEqual(tuple(int(v) for v in bgr[0, 0]), (0, 0, 255))
        # RGB frame: dlib HOG detection via face_recognition expects RGB.
        self.assertEqual(tuple(int(v) for v in rgb[0, 0]), (255, 0, 0))

        # MJPEG preview: cv2.imencode expects BGR; decoding must still be red.
        ok, jpg = cv2.imencode(".jpg", main.draw_box(bgr, None, main.GOLD), [cv2.IMWRITE_JPEG_QUALITY, 95])
        self.assertTrue(ok)
        decoded = cv2.imdecode(jpg, cv2.IMREAD_COLOR)
        b, g, r = (int(v) for v in decoded[HEIGHT // 2, WIDTH // 2])
        self.assertGreater(r, 200)
        self.assertLess(b, 50)
        self.assertLess(g, 50)

        # Embedding model input: embed_face converts BGR->RGB, so channel 0
        # (R) must be saturated and channel 2 (B) empty after [-1, 1] scaling.
        session = FakeOnnxSession()
        with mock.patch.object(embeddings, "get_rec_session", return_value=session):
            self.assertIsNotNone(embeddings.embed_face(bgr, (2, 9, 6, 3)))
        red, green, blue = (session.batch[0, channel] for channel in range(3))
        np.testing.assert_allclose(red, 1.0)
        np.testing.assert_allclose(green, -1.0)
        np.testing.assert_allclose(blue, -1.0)

    def test_picamera2_rgb888_frames_are_treated_as_bgr(self):
        camera = start_pi_camera()
        self.assertEqual(camera._mode, "pi")
        self.assertEqual(FakePicamera2.configured_format, "RGB888")
        self.assert_red_for_every_consumer(camera)

    def test_usb_videocapture_frames_are_treated_as_bgr(self):
        camera = start_usb_camera()
        self.assertEqual(camera._mode, "usb")
        self.assert_red_for_every_consumer(camera)

    def test_csi_and_usb_capture_identical_frames_for_the_same_scene(self):
        pi_bgr, pi_rgb = start_pi_camera().capture()
        usb_bgr, usb_rgb = start_usb_camera().capture()
        np.testing.assert_array_equal(pi_bgr, usb_bgr)
        np.testing.assert_array_equal(pi_rgb, usb_rgb)


if __name__ == "__main__":
    unittest.main()
