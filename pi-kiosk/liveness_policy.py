"""Enforce opt-in blink verification and recover unavailable landmark models."""
import logging
import time

logger = logging.getLogger(__name__)


class LivenessVerificationRequired(RuntimeError):
    pass


class LivenessPolicy:
    def __init__(self, required, factory, retry_seconds=30, clock=time.monotonic):
        self.required = bool(required)
        self._factory = factory
        self._retry_seconds = retry_seconds
        self._clock = clock
        self._retry_at = 0.
        self.checker = None

    def refresh(self):
        if not self.required or self.checker is not None or self._clock() < self._retry_at:
            return self.checker
        self._retry_at = self._clock() + self._retry_seconds
        try:
            self.checker = self._factory()
            logger.info('Required blink verification is available')
        except Exception as exc:
            self.checker = None
            logger.error('Required blink verification unavailable; automatic attendance blocked: %s', exc)
        return self.checker

    def invalidate(self):
        self.checker = None
        self._retry_at = self._clock() + self._retry_seconds

    def update(self, frame, face_location, frame_check):
        if self.checker is None:
            return False
        try:
            confirmed = self.checker.update(frame, face_location, frame_check=frame_check)
            if getattr(self.checker, "failed", False) is True:
                self.invalidate()
                return False
            return confirmed
        except Exception as exc:
            logger.error('Blink verification failed; automatic attendance blocked until recovery: %s', exc)
            self.invalidate()
            return False

    def record(self, callback, *, liveness_confirmed=False, **fields):
        """Guard the actual attendance write even if caller state becomes stale."""
        if self.required and (self.checker is None or not liveness_confirmed):
            raise LivenessVerificationRequired('Required blink verification has not completed')
        return callback(liveness_confirmed=liveness_confirmed, **fields)
