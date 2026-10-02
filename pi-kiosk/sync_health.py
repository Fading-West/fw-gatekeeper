"""Protected sync authorization observations, separate from public reachability."""
import threading


class SyncAuthHealth:
    PHASES = ("roster", "roster_ack", "attendance", "recognition")

    def __init__(self):
        self._lock = threading.Lock()
        self._phases: dict[str, bool | None] = dict.fromkeys(self.PHASES)

    def observe(self, phase: str, status_code: int) -> None:
        if phase not in self.PHASES:
            raise ValueError("Unknown protected sync phase")
        # Network errors, public health, malformed bodies and unrelated phases
        # cannot demonstrate that a previously denied credential is accepted.
        if status_code in (401, 403):
            accepted = False
        elif 200 <= status_code < 300:
            accepted = True
        else:
            return
        with self._lock:
            self._phases[phase] = accepted

    def snapshot(self) -> dict:
        with self._lock:
            phases = dict(self._phases)
        faults = [phase for phase, accepted in phases.items() if accepted is False]
        known = any(accepted is not None for accepted in phases.values())
        return {"sync_auth_ok": not faults if known else None,
                "sync_auth_faults": faults, "sync_auth_phases": phases}


sync_auth_health = SyncAuthHealth()
