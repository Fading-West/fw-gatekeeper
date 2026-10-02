"""Bound recognition evidence to a recent camera frame."""
import math

def is_fresh_scan(result, now, invalidated_at=0.0, max_age_seconds=5.0):
    if not isinstance(result, dict):
        return False
    stamp = result.get("frame_ts")
    return (isinstance(stamp, (int, float)) and math.isfinite(stamp)
            and math.isfinite(now) and stamp >= invalidated_at
            and 0 <= now - stamp <= max_age_seconds)
