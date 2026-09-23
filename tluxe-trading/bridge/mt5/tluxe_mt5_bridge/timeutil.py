"""MT5 server time → UTC.

MT5 returns bar and tick times as the broker's *server wall-clock time*
encoded as epoch seconds (not UTC). Treating them as UTC shifts every candle by
the server offset (often +2h/+3h with DST). Conversion methods, in order:

1. `iana`: TLUXE_MT5_SERVER_TIMEZONE (e.g. "Europe/Athens", "Asia/Nicosia",
   "UTC"). Handles DST exactly. Recommended.
2. `detected`: offset measured from a fresh tick vs this PC's UTC clock,
   rounded to 30 minutes. Only valid while ticks are fresh; rechecked
   periodically; can be wrong across a DST change until re-detected.
3. `unresolved`: no conversion possible → the bridge refuses to label times UTC.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

FRESH_TICK_SECONDS = 120
ROUND_TO = 1800


@dataclass
class TimeBasis:
    method: str  # 'iana' | 'detected' | 'unresolved'
    timezone: str | None = None
    offset_sec: int | None = None
    detected_at: float | None = None

    def as_dict(self) -> dict:
        return {"basis": self.method, "timezone": self.timezone, "offsetSec": self.offset_sec,
                "detectedAtMs": int(self.detected_at * 1000) if self.detected_at else None}


def server_to_utc(server_sec: int, basis: TimeBasis) -> int | None:
    """Convert a server-wall-time epoch to a true UTC epoch. None if unresolved."""
    if basis.method == "iana" and basis.timezone:
        wall = datetime.fromtimestamp(server_sec, tz=timezone.utc).replace(tzinfo=None)
        # fold=0: during the repeated autumn hour the first occurrence is used (documented).
        return int(wall.replace(tzinfo=ZoneInfo(basis.timezone), fold=0).timestamp())
    if basis.method == "detected" and basis.offset_sec is not None:
        return int(server_sec - basis.offset_sec)
    return None


def detect_offset(tick_server_sec: int, now_utc: float | None = None) -> int | None:
    """Offset (server − UTC) from a tick, if the tick is fresh enough to trust."""
    now = time.time() if now_utc is None else now_utc
    raw = tick_server_sec - now
    offset = int(round(raw / ROUND_TO) * ROUND_TO)
    if abs(raw - offset) > FRESH_TICK_SECONDS:
        return None  # stale tick: cannot separate offset from tick age
    return offset
