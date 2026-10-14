"""Validate kiosk action and scan policy without loading native models.

No coercion or silent fallback: local Python overrides must use the documented
types. Errors identify setting names only, never configured credentials.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math
import sys
from typing import Any


@dataclass(frozen=True)
class KioskPolicy:
    action_errors: tuple[str, ...]
    recognition_errors: tuple[str, ...]

    @property
    def valid(self) -> bool:
        return not self.errors

    @property
    def errors(self) -> tuple[str, ...]:
        return self.action_errors + self.recognition_errors


def validate_kiosk_policy(settings: Any) -> KioskPolicy:
    action_errors = []
    recognition_errors = []
    kiosk_type = getattr(settings, "KIOSK_TYPE", None)
    if not isinstance(kiosk_type, str) or kiosk_type not in ("entry", "exit", "auto"):
        action_errors.append("KIOSK_TYPE")

    def number(name: str, minimum: float = 0, maximum: float | None = None,
               positive: bool = False) -> None:
        value = getattr(settings, name, None)
        try:
            finite = isinstance(value, (int, float)) and math.isfinite(value)
        except (OverflowError, TypeError, ValueError):
            finite = False
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not finite or value < minimum
                or (positive and value <= minimum)
                or (maximum is not None and value > maximum)):
            recognition_errors.append(name)

    def positive_integer(name: str, maximum: int | None = None) -> None:
        value = getattr(settings, name, None)
        if (isinstance(value, bool) or not isinstance(value, int) or value <= 0
                or (maximum is not None and value > maximum)):
            recognition_errors.append(name)

    if not isinstance(getattr(settings, "LIVENESS_REQUIRED", None), bool):
        recognition_errors.append("LIVENESS_REQUIRED")
    number("RECOGNITION_MATCH_THRESHOLD", maximum=1, positive=True)
    number("RECOGNITION_NEAR_MISS_MARGIN", maximum=1)
    # deque(maxlen=...) consumes Py_ssize_t, even though Python integers grow.
    positive_integer("RECOGNITION_EMBEDDING_WINDOW", maximum=sys.maxsize)
    positive_integer("RECOGNITION_UNKNOWN_STREAK")
    number("LIVENESS_EAR_THRESHOLD", maximum=1, positive=True)
    positive_integer("LIVENESS_BLINK_FRAMES")
    positive_integer("LIVENESS_TIMEOUT_SEC")
    number("LIVENESS_WAIT_SEC", positive=True)
    number("CLOCK_DEBOUNCE_MINUTES")
    if "CLOCK_DEBOUNCE_MINUTES" not in recognition_errors:
        # Match the attendance consumer's actual representable range rather
        # than inventing an operational maximum for a site's policy.
        try:
            # SQLite's recent-attendance query subtracts this duration from
            # the current UTC datetime; timedelta alone has a wider domain.
            (datetime.now(timezone.utc) - timedelta(minutes=settings.CLOCK_DEBOUNCE_MINUTES)).timestamp()
        except (OverflowError, ValueError, OSError):
            recognition_errors.append("CLOCK_DEBOUNCE_MINUTES")
    number("DISPLAY_TIME_SEC")
    number("DISPLAY_TIME_SUCCESS_SEC")
    return KioskPolicy(tuple(action_errors), tuple(recognition_errors))


def require_kiosk_action_type(settings: Any) -> str:
    """Require an explicit supported policy before inferring an action."""
    if validate_kiosk_policy(settings).action_errors:
        raise ValueError("KIOSK_TYPE must be entry, exit, or auto")
    return settings.KIOSK_TYPE
