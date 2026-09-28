"""Behavioral checks for the enrollment gate's resource and numeric boundaries."""
import base64
import io
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image
from fastapi.testclient import TestClient

os.environ['FACE_SERVICE_KEY'] = 'test-key'
os.environ['FACE_MODEL_DIR'] = tempfile.mkdtemp(prefix='gatekeeper-quality-')
import main
from enrollment_quality import select_consistent_embeddings


class QualityBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.headers = {'x-face-service-key': 'test-key'}

    def test_invalid_and_zero_embeddings_never_reach_similarity_selection(self):
        for vector in [np.zeros(512), np.full(512, np.nan), np.ones(128), np.full(512, np.inf)]:
            with self.subTest(shape=vector.shape), self.assertRaises(ValueError):
                select_consistent_embeddings([vector, vector])

    def test_nonfinite_threshold_is_rejected(self):
        with self.assertRaises(ValueError):
            select_consistent_embeddings([np.ones(512), np.ones(512)], float('nan'))

    def test_configured_minimum_fits_portal_capture_count(self):
        for minimum in (1, 2, 3, 4, 6):
            with self.subTest(minimum=minimum):
                result = subprocess.run(
                    [sys.executable, '-c', 'import enrollment_quality'],
                    cwd=os.path.dirname(__file__),
                    env={**os.environ, 'MIN_GOOD_PHOTOS': str(minimum)},
                    capture_output=True, text=True,
                )
                self.assertEqual(result.returncode == 0, minimum in (2, 3))
                if minimum not in (2, 3):
                    self.assertIn('must be 2 or 3', result.stderr)

    def test_invalid_model_output_is_a_service_error(self):
        with patch.object(main, 'decode_image', return_value=np.zeros((10,10,3))), patch.object(main, 'get_face_crop', return_value=np.zeros((112,112,3))), patch.object(main, 'embed_face_crop', return_value=[0.0]*512):
            response = self.client.post('/encode', headers=self.headers, json={'photos':['image']*3})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('encoding', response.json())

    def test_photo_count_is_bounded_before_any_decoding(self):
        with patch.object(main, 'decode_image') as decode:
            response = self.client.post('/encode', headers=self.headers, json={'photos':['image']*7})
            self.assertEqual(response.status_code, 422)
            decode.assert_not_called()

    def test_image_pixel_limit_applies_before_array_conversion(self):
        data = io.BytesIO()
        Image.new('RGB', (2001, 2000)).save(data, format='PNG')
        with patch.object(main.np, 'array') as convert, self.assertRaises(ValueError):
            main.decode_image(base64.b64encode(data.getvalue()).decode())
        convert.assert_not_called()

    def test_blank_image_has_no_center_crop_fallback(self):
        self.assertIsNone(main.get_face_crop(np.zeros((480,640,3),dtype=np.uint8)))


if __name__ == '__main__':
    unittest.main()
