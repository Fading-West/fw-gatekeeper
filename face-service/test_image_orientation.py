"""Decode displayed JPEG orientation before enrollment or matching sees pixels."""
import base64
import io
import os
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

os.environ['FACE_SERVICE_KEY'] = 'test-orientation-key'
os.environ['FACE_MODEL_DIR'] = tempfile.mkdtemp(prefix='gatekeeper-orientation-')
import main


def jpeg_photo(orientation=None):
    # Asymmetric pixels make mirrors and 180-degree rotation observable too.
    image = Image.new('RGB', (80, 120), 'white')
    image.paste((240, 20, 10), (0, 0, 40, 60))
    image.paste((10, 20, 240), (40, 60, 80, 120))
    exif = Image.Exif()
    if orientation is not None:
        exif[274] = orientation
    buffer = io.BytesIO()
    image.save(buffer, format='JPEG', exif=exif)
    return buffer.getvalue()


def data_url(photo):
    return 'data:image/jpeg;base64,' + base64.b64encode(photo).decode('ascii')


class ImageOrientationTests(unittest.TestCase):
    def test_all_exif_orientations_decode_to_displayed_pixels(self):
        transforms = {
            1: None,
            2: Image.Transpose.FLIP_LEFT_RIGHT,
            3: Image.Transpose.ROTATE_180,
            4: Image.Transpose.FLIP_TOP_BOTTOM,
            5: Image.Transpose.TRANSPOSE,
            6: Image.Transpose.ROTATE_270,
            7: Image.Transpose.TRANSVERSE,
            8: Image.Transpose.ROTATE_90,
        }
        for orientation, transform in transforms.items():
            with self.subTest(orientation=orientation):
                photo = jpeg_photo(orientation)
                with Image.open(io.BytesIO(photo)) as source:
                    expected = source.convert('RGB')
                    if transform is not None:
                        expected = expected.transpose(transform)
                    expected_bgr = np.array(expected)[:, :, ::-1]
                np.testing.assert_array_equal(main.decode_image(data_url(photo)), expected_bgr)

    def test_jpeg_without_orientation_preserves_pixels(self):
        photo = jpeg_photo()
        with Image.open(io.BytesIO(photo)) as source:
            expected_bgr = np.array(source.convert('RGB'))[:, :, ::-1]
        np.testing.assert_array_equal(main.decode_image(data_url(photo)), expected_bgr)

    def test_encode_and_match_pass_upright_pixels_to_face_detection(self):
        # EXIF 6 means the stored 80x120 raster displays as 120x80.
        photo = data_url(jpeg_photo(6))
        vector = [1.0] + [0.0] * 511
        client = TestClient(main.app)
        headers = {'x-face-service-key': 'test-orientation-key'}

        def detect(image):
            if image.shape == (80, 120, 3):
                return [(30, 10, 90, 70)]
            return []  # A sideways frame cannot supply an upright detection.

        with patch.object(main, 'detect_faces_haar', side_effect=detect), patch.object(
            main, 'embed_face_crop', return_value=vector,
        ):
            encoded = client.post('/encode', headers=headers, json={'photos': [photo] * 3})
            matched = client.post('/match', headers=headers, json={
                'photo': photo, 'encodings': [{'worker_id': 'worker-1', 'encoding': vector}],
            })
        self.assertEqual(encoded.status_code, 200, encoded.text)
        self.assertEqual(encoded.json()['used_photo_indexes'], [0, 1, 2])
        self.assertEqual(matched.status_code, 200, matched.text)
        self.assertEqual(matched.json()['match'], {'worker_id': 'worker-1', 'confidence': 1.0})


if __name__ == '__main__':
    unittest.main()
