"""Use the face service's quality policy for supported local enrollment too."""
import importlib.util
from pathlib import Path


_policy_path = Path(__file__).resolve().parents[1] / "face-service/enrollment_quality.py"
_spec = importlib.util.spec_from_file_location("gatekeeper_enrollment_quality", _policy_path)
_policy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_policy)


def competing_faces(locations):
    # face_recognition uses top/right/bottom/left; the shared policy uses x/y.
    return _policy.has_competing_faces([(left, top, right, bottom)
                                        for top, right, bottom, left in locations])


def samples_agree(encodings):
    """Reject a mismatched new capture, allowing a fresh retake before publication."""
    try:
        kept, _ = _policy.select_consistent_embeddings(encodings)
    except ValueError:
        return False
    return kept == list(range(len(encodings)))
