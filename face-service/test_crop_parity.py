"""Native detector/crop/tensor parity. The Docker CI job also uses the real model.

The reference detector follows face_recognition 1.3.0's HOG adapter and the
kiosk's half-frame scaling. No real-person images or downloads are needed.
"""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'face-service'))
os.environ.setdefault('FACE_MODEL_DIR', tempfile.mkdtemp(prefix='crop-parity-'))
import main
from face_detection import detect_faces_hog

spec = importlib.util.spec_from_file_location('kiosk_embeddings', ROOT / 'pi-kiosk/embeddings.py')
kiosk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kiosk)


def kiosk_locations(img):
    # Exactly the face_recognition HOG adapter, including its bounds trim.
    import dlib
    small = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), (0, 0), fx=0.5, fy=0.5)
    return [(max(0, r.top())*2, min(small.shape[1], r.right())*2,
             min(small.shape[0], r.bottom())*2, max(0, r.left())*2)
            for r in dlib.get_frontal_face_detector()(small, 1)]


class CapturingSession:
    def get_inputs(self):
        return [type('Input', (), {'name': 'input'})()]

    def run(self, _outputs, inputs):
        self.tensor = inputs['input'].copy()
        return [np.ones((1, 512), dtype=np.float32)]


class CropParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.images = [cv2.imread(str(p)) for p in sorted((ROOT / 'face-service/fixtures').glob('synthetic-*.jpg'))]
        assert len(cls.images) == 6
        cls.session = CapturingSession()
        model = os.environ.get('FACE_PARITY_MODEL')
        if model:
            from model_pinning import REC_MODEL_SHA256, verify_model_digest
            import onnxruntime as ort
            verify_model_digest(model, REC_MODEL_SHA256)
            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            options.inter_op_num_threads = 1
            cls.real_session = ort.InferenceSession(model, sess_options=options, providers=['CPUExecutionProvider'])
        else:
            cls.real_session = None

    def assert_crop_parity(self, img, loc, detected=False):
        # Capture the actual kiosk crop before its resize/preprocessing.
        with patch.object(kiosk, 'get_512_embedding', side_effect=lambda crop: cv2.resize(crop, (112,112))):
            expected = kiosk.embed_face(img, loc)
        if detected:
            # Use the service's own production detector wiring, not a patched box.
            actual = main.get_face_crop(img, reject_competing_faces=True)
        else:
            with patch.object(main, 'detect_faces_hog', return_value=[(loc[3],loc[0],loc[1],loc[2])]):
                actual = main.get_face_crop(img)
        np.testing.assert_array_equal(actual, expected)
        with patch.object(main, 'get_rec_session', return_value=self.session), patch.object(kiosk, 'get_rec_session', return_value=self.session):
            main.embed_face_crop(actual)
            service_tensor = self.session.tensor.copy()
            kiosk.embed_face(img, loc)
            np.testing.assert_array_equal(service_tensor, self.session.tensor)
        if self.real_session is not None:
            with patch.object(main, 'get_rec_session', return_value=self.real_session), patch.object(kiosk, 'get_rec_session', return_value=self.real_session):
                a = np.array(main.embed_face_crop(actual))
                b = kiosk.embed_face(img, loc)
            self.assertEqual(a.shape, (512,))
            self.assertGreater(float(a @ b / (np.linalg.norm(a)*np.linalg.norm(b))), 0.999999)

    def test_real_detections_and_embeddings_for_synthetic_faces(self):
        for i, img in enumerate(self.images):
            # 640x480 is both the kiosk camera and the portal capture size.
            for shape in [(640,480), (512,512), (511,509), (1024,768)]:
                with self.subTest(face=i+1, shape=shape):
                    frame = cv2.resize(img, shape)
                    locs = kiosk_locations(frame)
                    self.assertEqual(len(locs), 1)
                    self.assertEqual(detect_faces_hog(frame), [(l,t,r,b) for t,r,b,l in locs])
                    self.assert_crop_parity(frame, locs[0], detected=True)

    def test_padding_rounding_and_all_image_edges(self):
        frame = self.images[0]
        for loc in [(0,90,90,0), (430,512,512,430), (0,512,91,419), (419,91,512,0), (75,301,298,76)]:
            with self.subTest(loc=loc):
                self.assert_crop_parity(frame, loc)

    def test_face_recognition_bounds_trim_before_scaling(self):
        import dlib
        frame = np.zeros((511,509,3), dtype=np.uint8)
        # cv2 rounds half-frame dimensions; face_recognition clamps its inclusive
        # endpoints to that frame, then the kiosk doubles (without adding 1).
        small = cv2.resize(frame, (0,0), fx=0.5, fy=0.5)
        rect = dlib.rectangle(-5,-7,small.shape[1]+10,small.shape[0]+12)
        with patch('face_detection._hog_detector', return_value=lambda rgb, upsample: [rect]):
            self.assertEqual(detect_faces_hog(frame), [(0,0,small.shape[1]*2,small.shape[0]*2)])

    def test_maximum_photo_batch_with_real_model(self):
        if self.real_session is None:
            self.skipTest('real-model resource check runs in the Docker CI job')
        import base64
        import resource
        frame = cv2.resize(self.images[0], (2000,2000))
        ok, jpeg = cv2.imencode('.jpg', frame)
        self.assertTrue(ok)
        photo = base64.b64encode(jpeg).decode()
        with patch.object(main, 'get_rec_session', return_value=self.real_session):
            result = main.encode(main.EncodeRequest(photos=[photo]*6))
        self.assertEqual(len(result.encoding), 512)
        self.assertEqual(result.used_photo_indexes, list(range(6)))
        peak_mib = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        print(f'Peak RSS with six 4 MP enrollment photos: {peak_mib:.1f} MiB')
        self.assertLess(peak_mib, 450, 'leave headroom within Render 512 MB')

    def test_no_face_and_multiple_faces_keep_quality_gate(self):
        for size in [(480,640), (1,1), (1,20)]:
            self.assertIsNone(main.get_face_crop(np.zeros((*size,3), dtype=np.uint8)))
        crowd = np.concatenate(self.images[:2], axis=1)
        self.assertEqual(len(detect_faces_hog(crowd)), 2)
        with self.assertRaises(main.MultipleFacesError):
            main.get_face_crop(crowd, reject_competing_faces=True)
        self.assertIsNotNone(main.get_face_crop(crowd))


if __name__ == '__main__':
    unittest.main()
