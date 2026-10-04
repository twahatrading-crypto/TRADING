"""Broker server-time <-> UTC conversion with explicit DST handling.

MT5 timestamps are the broker's *server wall clock* written as if it were UTC.
Brokers differ, and most change their offset when DST changes, so a fixed
offset is wrong for half of the year.  The rule is configured explicitly:

* ``"NY+7"``      – server clock = New York wall clock + 7h (GMT+2 winter /
                    GMT+3 summer, switching on **US** DST dates). This is the
                    most common MT5 forex/metals convention (daily candle opens
                    at the 17:00 New York close).
* ``"UTC"``       – server runs on UTC.
* ``"fixed:+2"``  – a constant offset in hours (no DST).
* any IANA name   – e.g. ``"Europe/Athens"`` (EU DST dates), ``"Etc/GMT-2"``.

The live feed additionally *measures* the offset from the newest tick and the
dashboard warns when the configured rule disagrees with the measurement.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo

UTC = timezone.utc
NY = ZoneInfo("America/New_York")


@lru_cache(maxsize=32)
def _zone(name: str) -> ZoneInfo:
    return ZoneInfo(name)


class ServerClock:
    def __init__(self, rule: str = "NY+7"):
        self.rule = rule.strip()
        r = self.rule
        if r.upper() == "NY+7":
            self._kind, self._arg = "ny7", None
        elif r.upper() == "UTC":
            self._kind, self._arg = "fixed", 0
        elif r.lower().startswith("fixed:"):
            self._kind, self._arg = "fixed", int(round(float(r.split(":", 1)[1]) * 3600))
        else:
            _zone(r)  # validate, raises ZoneInfoNotFoundError
            self._kind, self._arg = "iana", r

    # offset (seconds) such that server_raw = utc + offset
    def offset_at_utc(self, utc_ts: int) -> int:
        if self._kind == "fixed":
            return self._arg
        dt = datetime.fromtimestamp(utc_ts, UTC)
        if self._kind == "ny7":
            return int(dt.astimezone(NY).utcoffset().total_seconds()) + 7 * 3600
        return int(dt.astimezone(_zone(self._arg)).utcoffset().total_seconds())

    def to_server(self, utc_ts: int) -> int:
        return int(utc_ts) + self.offset_at_utc(int(utc_ts))

    def to_utc(self, server_raw: int) -> int:
        """Invert server wall-clock epoch -> UTC epoch.

        Around a DST switch two candidate offsets exist; we pick the one that is
        self-consistent (``offset_at_utc(raw - off) == off``).
        """
        raw = int(server_raw)
        if self._kind == "fixed":
            return raw - self._arg
        candidates = []
        for probe in (raw - 2 * 86400, raw, raw + 2 * 86400):
            off = self.offset_at_utc(probe)
            if off not in candidates:
                candidates.append(off)
        for off in candidates:
            if self.offset_at_utc(raw - off) == off:
                return raw - off
        return raw - self.offset_at_utc(raw)

    def describe(self, utc_ts: int) -> str:
        off = self.offset_at_utc(utc_ts)
        sign = "+" if off >= 0 else "-"
        h, m = divmod(abs(off) // 60, 60)
        return f"{self.rule} (currently GMT{sign}{h}{':%02d' % m if m else ''})"


def measure_offset(server_tick_raw: int, utc_now: float, granularity: int = 1800) -> int:
    """Estimate the server offset from a *fresh* tick, rounded to 30 minutes."""
    return int(round((server_tick_raw - utc_now) / granularity) * granularity)


def iso_utc(ts: int | float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso_utc(s: str) -> int:
    s = s.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return int(dt.timestamp())


def utc_dt(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, UTC)


__all__ = ["ServerClock", "measure_offset", "iso_utc", "parse_iso_utc", "utc_dt", "UTC", "NY", "timedelta"]
