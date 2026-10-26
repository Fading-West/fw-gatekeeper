"""Use the face service's quality policy for supported local enrollment too."""
# Immutable kiosk releases contain only pi-kiosk. Keep a bundled policy beside
# this helper; test_enrollment_samples.py checks it against the service copy.
import enrollment_quality as _policy


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
