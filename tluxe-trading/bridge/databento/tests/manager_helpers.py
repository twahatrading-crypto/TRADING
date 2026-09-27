"""Small helpers for the manager tests (TEST DATA only)."""
import databento_dbn as dbn

A = dbn.Action


class Clock:
    def __init__(self, t: int) -> None:
        self.t = t

    def __call__(self) -> int:
        return self.t
