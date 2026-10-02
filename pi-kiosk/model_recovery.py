"""Initialize recognition in one background worker, keeping local controls usable."""
import logging
import threading

logger = logging.getLogger(__name__)


class ModelRecovery:
    def __init__(self, checker, retry_seconds=30):
        self._checker = checker
        self._retry_seconds = retry_seconds
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread = None

    @property
    def ready(self):
        return self._ready.is_set()

    def start(self):
        with self._lock:
            if self.ready or self._stop.is_set() or (self._thread and self._thread.is_alive()):
                return
            self._thread = threading.Thread(target=self._run, daemon=True, name="recognition-model-recovery")
            self._thread.start()

    def _run(self):
        while not self._stop.is_set():
            try:
                available = bool(self._checker())
            except Exception:
                available = False
                logger.exception("Recognition initialization failed; local attendance remains available")
            if available:
                if not self._stop.is_set():
                    self._ready.set()
                return
            if self._stop.wait(self._retry_seconds):
                return

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
