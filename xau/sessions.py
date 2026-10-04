"""Session engine (Asian / London / New York) and market-hours calendar.

Every session is defined in the **local wall clock of its own market**
(an IANA time zone), so DST is handled by ``zoneinfo`` and nothing is a
hard-coded UTC offset.  E.g. London 08:00-16:30 Europe/London is 08:00 UTC
in January and 07:00 UTC in July automatically.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time as dtime, timedelta
from typing import Iterable, Optional
from zoneinfo import ZoneInfo

from .timeutil import UTC


def _hm(s: str) -> dtime:
    h, m = s.split(":")
    return dtime(int(h), int(m))


@dataclass(frozen=True)
class SessionDef:
    name: str
    tz: str
    start: str   # "HH:MM" local
    end: str     # "HH:MM" local (may be <= start => crosses midnight)

    def window_for_local_date(self, d: date) -> tuple[int, int]:
        z = ZoneInfo(self.tz)
        s, e = _hm(self.start), _hm(self.end)
        start = datetime.combine(d, s, tzinfo=z)
        end_day = d + timedelta(days=1) if (e <= s) else d
        end = datetime.combine(end_day, e, tzinfo=z)
        return int(start.timestamp()), int(end.timestamp())

    def windows_around(self, utc_ts: int, days_back: int = 3, days_fwd: int = 1) -> list[tuple[int, int]]:
        local_d = datetime.fromtimestamp(utc_ts, UTC).astimezone(ZoneInfo(self.tz)).date()
        out = []
        for k in range(-days_back, days_fwd + 1):
            out.append(self.window_for_local_date(local_d + timedelta(days=k)))
        return out


DEFAULT_SESSIONS = [
    # Asian range: Tokyo 09:00-15:00 JST (Japan has no DST) = 00:00-06:00 UTC.
    SessionDef("Asian", "Asia/Tokyo", "09:00", "15:00"),
    SessionDef("London", "Europe/London", "08:00", "16:30"),
    SessionDef("New York", "America/New_York", "08:00", "17:00"),
]


class SessionEngine:
    def __init__(self, sessions: Iterable[SessionDef] = DEFAULT_SESSIONS):
        self.sessions = list(sessions)
        self.by_name = {s.name: s for s in self.sessions}

    def active(self, utc_ts: int) -> list[str]:
        names = []
        for s in self.sessions:
            for a, b in s.windows_around(utc_ts, 1, 1):
                if a <= utc_ts < b:
                    names.append(s.name)
                    break
        return names

    def current_window(self, name: str, utc_ts: int) -> Optional[tuple[int, int]]:
        for a, b in self.by_name[name].windows_around(utc_ts, 1, 1):
            if a <= utc_ts < b:
                return a, b
        return None

    def last_completed(self, name: str, utc_ts: int) -> Optional[tuple[int, int]]:
        """Most recent window of ``name`` that has fully ended at ``utc_ts``."""
        best = None
        for a, b in self.by_name[name].windows_around(utc_ts, 3, 0):
            if b <= utc_ts and (best is None or b > best[1]):
                best = (a, b)
        return best

    def next_window(self, name: str, utc_ts: int) -> Optional[tuple[int, int]]:
        best = None
        for a, b in self.by_name[name].windows_around(utc_ts, 0, 2):
            if a > utc_ts and (best is None or a < best[0]):
                best = (a, b)
        return best

    def describe(self, utc_ts: int) -> list[dict]:
        out = []
        act = set(self.active(utc_ts))
        for s in self.sessions:
            cur = self.current_window(s.name, utc_ts)
            nxt = self.next_window(s.name, utc_ts)
            out.append({
                "name": s.name, "tz": s.tz, "local_start": s.start, "local_end": s.end,
                "active": s.name in act,
                "start_utc": cur[0] if cur else (nxt[0] if nxt else None),
                "end_utc": cur[1] if cur else (nxt[1] if nxt else None),
            })
        return out


@dataclass(frozen=True)
class MarketHours:
    """Expected trading hours, defined in New York wall time (DST-safe).

    Spot gold (CFD) normally trades Sunday 18:00 -> Friday 17:00 New York time
    with a daily maintenance break 17:00-18:00.  Only used to decide whether a
    lack of ticks means "STALE" or simply "market closed".
    """
    tz: str = "America/New_York"
    week_open_weekday: int = 6      # Sunday (Mon=0)
    week_open: str = "18:00"
    week_close_weekday: int = 4     # Friday
    week_close: str = "17:00"
    daily_break_start: str = "17:00"
    daily_break_end: str = "18:00"

    def is_open(self, utc_ts: int) -> bool:
        local = datetime.fromtimestamp(utc_ts, UTC).astimezone(ZoneInfo(self.tz))
        wd, t = local.weekday(), local.time()
        if wd == 5:
            return False
        if wd == self.week_close_weekday and t >= _hm(self.week_close):
            return False
        if wd == self.week_open_weekday:
            return t >= _hm(self.week_open)
        bs, be = _hm(self.daily_break_start), _hm(self.daily_break_end)
        if bs <= t < be:
            return False
        return True
