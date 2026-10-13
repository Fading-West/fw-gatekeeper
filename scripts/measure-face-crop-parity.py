#!/usr/bin/env python3
"""Compare old Haar, held-out box calibration, corrected service, and kiosk HOG.

Uses committed AI-generated fixtures, the digest-verified recognition model,
and actual face_recognition when installed (otherwise its equivalent HOG API).
No photos or models are downloaded here. Pass --model /path/to/rec_model.onnx.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys

import cv2
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--model', required=True)
args = parser.parse_args()
os.environ['FACE_MODEL_DIR'] = str(Path(args.model).resolve().parent)
sys.path.insert(0, str(ROOT / 'face-service'))
import main
from model_pinning import REC_MODEL_SHA256, verify_model_digest
verify_model_digest(args.model, REC_MODEL_SHA256)
spec = importlib.util.spec_from_file_location('kiosk_embeddings', ROOT / 'pi-kiosk/embeddings.py')
kiosk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kiosk)
options = ort.SessionOptions()
options.intra_op_num_threads = options.inter_op_num_threads = 1
session = ort.InferenceSession(args.model, sess_options=options, providers=['CPUExecutionProvider'])
main._rec_session = kiosk._rec_session = session
try:
    import face_recognition as fr
    reference = 'face_recognition 1.3.0 (real kiosk API)'
    def locations(img):
        small = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), (0,0), fx=0.5, fy=0.5)
        return [tuple(v*2 for v in loc) for loc in fr.face_locations(small, model='hog')]
except ImportError:
    sys.path.insert(0, str(ROOT / 'face-service'))
    from test_crop_parity import kiosk_locations as locations
    reference = 'direct dlib, equivalent face_recognition 1.3.0 HOG adapter'


def cosine(a,b):
    a,b=np.asarray(a),np.asarray(b)
    return float(a@b/(np.linalg.norm(a)*np.linalg.norm(b)))


def embed_box(img,box):
    x,y,r,b=box
    return kiosk.embed_face(img,(y,r,b,x))


samples=[]
cascade=cv2.CascadeClassifier(cv2.data.haarcascades+'haarcascade_frontalface_default.xml')
for path in sorted((ROOT/'face-service/fixtures').glob('synthetic-*.jpg')):
    img=cv2.imread(str(path))
    faces=cascade.detectMultiScale(cv2.cvtColor(img,cv2.COLOR_BGR2GRAY),scaleFactor=1.1,minNeighbors=3,minSize=(30,30))
    assert len(faces)==1, (path,len(faces))
    x,y,w,h=map(int,faces[0]);haar=np.array([x,y,x+w,y+h])
    locs=locations(img);assert len(locs)==1,(path,len(locs))
    t,r,b,l=locs[0];hog=np.array([l,t,r,b])
    # Fit center translation and width/height ratios on FIVE other images;
    # evaluating on the held-out sixth avoids reporting training-set fit.
    hw,hh=haar[2:]-haar[:2];gw,gh=hog[2:]-hog[:2]
    shift=((hog[:2]+hog[2:])/2-(haar[:2]+haar[2:])/2)/[hw,hh]
    samples.append((path.name,img,haar,hog,np.r_[shift,gw/hw,gh/hh]))
rows=[]
for i,(name,img,haar,hog,_features) in enumerate(samples):
    fit=np.mean([s[4] for j,s in enumerate(samples) if j!=i],axis=0)
    size=haar[2:]-haar[:2];center=(haar[:2]+haar[2:])/2+fit[:2]*size
    adjusted=np.rint(np.r_[center-fit[2:]*size/2,center+fit[2:]*size/2]).astype(int)
    baseline=embed_box(img,hog)
    corrected=main.get_embedding(img)
    shifted=cv2.warpAffine(img,np.float32([[1,0,3],[0,1,0]]),(img.shape[1],img.shape[0]),borderMode=cv2.BORDER_REFLECT)
    shifted_locs=locations(shifted);assert len(shifted_locs)==1
    rows.append({'image':name,'haar_box':haar.tolist(),'hog_box':hog.tolist(),
                 'haar_vs_kiosk':round(cosine(embed_box(img,haar),baseline),6),
                 'calibrated_held_out_vs_kiosk':round(cosine(embed_box(img,adjusted),baseline),6),
                 'corrected_vs_kiosk':round(cosine(corrected,baseline),6),
                 'kiosk_vs_shift3px':round(cosine(kiosk.embed_face(shifted,shifted_locs[0]),baseline),6)})
print(json.dumps({'reference':reference,'model_sha256':REC_MODEL_SHA256,'padding':0.25,'rows':rows},indent=2))
