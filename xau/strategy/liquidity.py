"""Liquidity level detection.

Only these deterministic definitions count as liquidity (ordinary candles never do):

* PDH / PDL       – high / low of the last *closed* broker D1 candle.
* ASIA_HIGH / LOW – high / low of the last *completed* Asian session (session engine).
* EQH / EQL       – two confirmed M5 fractal swings within a tolerance, at least
                    N bars apart, with no price beyond them in between.
* H1 / M15 swings – confirmed fractal swing highs / lows on those timeframes.

Each level carries ``formed_at`` (the UTC time it became knowable) and is only
"live" liquidity while it has not been traded through since then.
"""
from __future__ import annotations

from bisect import bisect_left
from dataclasses import asdict, dataclass, field
from typing import Optional

from ..config import LiquidityConfig
from ..models import Candle, TF_SECONDS
from ..sessions import SessionEngine
from .market import Snapshot
from .swings import find_swings

# Base liquidity-quality points (max 20 incl. confluence bonus) — explicit rules.
BASE_SCORE = {
    "PDH": 14, "PDL": 14,
    "ASIA_HIGH": 13, "ASIA_LOW": 13,
    "EQH": 11, "EQL": 11,
    "H1_SWING_HIGH": 11, "H1_SWING_LOW": 11,
    "M15_SWING_HIGH": 8, "M15_SWING_LOW": 8,
}
CONFLUENCE_BONUS = 3
LIQ_MAX = 20

LABELS = {
    "PDH": "Previous Day High (PDH)", "PDL": "Previous Day Low (PDL)",
    "ASIA_HIGH": "Asia High", "ASIA_LOW": "Asia Low",
    "EQH": "Equal Highs", "EQL": "Equal Lows",
    "H1_SWING_HIGH": "H1 Swing High", "H1_SWING_LOW": "H1 Swing Low",
    "M15_SWING_HIGH": "M15 Swing High", "M15_SWING_LOW": "M15 Swing Low",
}


@dataclass
class Level:
    kind: str
    side: str                 # "high" (buy-side liquidity above) | "low" (sell-side below)
    price: float
    formed_at: int            # UTC time the level became known
    source_time: int          # UTC time of the extreme candle(s)
    tags: list = field(default_factory=list)   # other kinds merged into this level
    taken_time: Optional[int] = None           # open time of first M5/HTF bar trading through
    m5_take_index: Optional[int] = None        # index in snapshot M5 list of that bar (if inside window)

    @property
    def id(self) -> str:
        return f"{self.kind}@{self.source_time}"

    @property
    def label(self) -> str:
        return LABELS.get(self.kind, self.kind)

    @property
    def score(self) -> int:
        return min(LIQ_MAX, BASE_SCORE.get(self.kind, 0) + CONFLUENCE_BONUS * len(self.tags))

    def is_live(self) -> bool:
        return self.taken_time is None

    def to_dict(self) -> dict:
        d = asdict(self)
        d.update(id=self.id, label=self.label, score=self.score)
        return d


class _Taker:
    """Finds the first bar after ``formed_at`` that traded through a level.

    M5 gives the precise bar (suffix max/min arrays make untaken levels O(1));
    M15/H1 bars cover any period older than the M5 window.
    """

    def __init__(self, snap: Snapshot):
        m5 = snap.bars.get("M5", [])
        self.times = [c.time for c in m5]
        self.hs = [c.high for c in m5]
        self.ls = [c.low for c in m5]
        n = len(m5)
        self.smax = [float("-inf")] * (n + 1)
        self.smin = [float("inf")] * (n + 1)
        for i in range(n - 1, -1, -1):
            self.smax[i] = max(self.hs[i], self.smax[i + 1])
            self.smin[i] = min(self.ls[i], self.smin[i + 1])
        self.first_m5 = m5[0].time if m5 else None
        self.older = []
        for tf in ("M15", "H1"):
            for c in snap.bars.get(tf, []):
                if self.first_m5 is None or c.time + TF_SECONDS[tf] <= self.first_m5:
                    self.older.append(c)
        self.older.sort(key=lambda c: c.time)

    def mark(self, lvl: "Level") -> None:
        high = lvl.side == "high"
        if self.first_m5 is None or lvl.formed_at < self.first_m5:
            for c in self.older:
                if c.time >= lvl.formed_at and (c.high > lvl.price if high else c.low < lvl.price):
                    lvl.taken_time, lvl.m5_take_index = c.time, None
                    return
        j = bisect_left(self.times, lvl.formed_at)
        if (high and self.smax[j] <= lvl.price) or (not high and self.smin[j] >= lvl.price):
            return
        arr = self.hs if high else self.ls
        for i in range(j, len(arr)):
            if (arr[i] > lvl.price) if high else (arr[i] < lvl.price):
                lvl.taken_time, lvl.m5_take_index = self.times[i], i
                return


def _asia_levels(snap: Snapshot, cfg: LiquidityConfig, sessions: SessionEngine) -> list[Level]:
    if "Asian" not in sessions.by_name:
        return []
    win = sessions.last_completed("Asian", snap.now)
    if not win or snap.now - win[1] > cfg.asia_max_age_hours * 3600:
        return []
    a, b = win
    bars = [c for c in snap.bars.get("M5", []) if a <= c.time and c.time + 300 <= b]
    if len(bars) < 6:   # need real data for the session (e.g. not a holiday / data gap)
        return []
    hi = max(bars, key=lambda c: c.high)
    lo = min(bars, key=lambda c: c.low)
    return [Level("ASIA_HIGH", "high", hi.high, b, hi.time),
            Level("ASIA_LOW", "low", lo.low, b, lo.time)]


def _pd_levels(snap: Snapshot) -> list[Level]:
    d1 = snap.bars.get("D1", [])
    if not d1:
        return []
    d = d1[-1]
    closed = d.time + 86400
    return [Level("PDH", "high", d.high, closed, d.time), Level("PDL", "low", d.low, closed, d.time)]


def _swing_levels(snap: Snapshot, tf: str, k: int, lookback: int, prefix: str,
                  cache: Optional[dict] = None) -> list[Level]:
    bars = snap.bars.get(tf, [])[-lookback:]
    key = (tf, k, len(bars), bars[0].time if bars else 0, bars[-1].time if bars else 0)
    if cache is not None and key in cache:
        highs, lows = cache[key]          # same closed candles => same swings
    else:
        highs, lows = find_swings(bars, k, tf)
        if cache is not None:
            if len(cache) > 64:
                cache.clear()
            cache[key] = (highs, lows)
    out = [Level(f"{prefix}_SWING_HIGH", "high", s.price, s.confirmed_at, s.time) for s in highs]
    out += [Level(f"{prefix}_SWING_LOW", "low", s.price, s.confirmed_at, s.time) for s in lows]
    return out


def _equal_levels(snap: Snapshot, cfg: LiquidityConfig, atr_m5: float, point: float) -> list[Level]:
    bars = snap.bars.get("M5", [])[-cfg.eq_lookback_bars:]
    highs, lows = find_swings(bars, cfg.swing_strength_m5, "M5")
    tol = max(cfg.eq_tolerance_atr * atr_m5, cfg.eq_tolerance_points_min * point)
    out: list[Level] = []
    for swings, side, kind in ((highs, "high", "EQH"), (lows, "low", "EQL")):
        for bi in range(len(swings)):
            b = swings[bi]
            for ai in range(bi - 1, -1, -1):
                a = swings[ai]
                if b.index - a.index < cfg.eq_min_separation_bars:
                    continue
                if abs(a.price - b.price) > tol:
                    continue
                between = bars[a.index + 1:b.index]
                if side == "high":
                    lvl_price = max(a.price, b.price)
                    if any(c.high > lvl_price for c in between):
                        continue
                else:
                    lvl_price = min(a.price, b.price)
                    if any(c.low < lvl_price for c in between):
                        continue
                out.append(Level(kind, side, lvl_price, b.confirmed_at, b.time))
                break
    return out


def _merge_confluence(levels: list[Level], tol: float) -> list[Level]:
    """Merge live levels on the same side within ``tol``; strongest kind wins."""
    result: list[Level] = []
    for side in ("high", "low"):
        lv = sorted([l for l in levels if l.side == side], key=lambda l: l.price)
        groups: list[list[Level]] = []
        for l in lv:
            if groups and abs(l.price - groups[-1][0].price) <= tol and \
                    (l.taken_time is None) == (groups[-1][0].taken_time is None):
                groups[-1].append(l)
            else:
                groups.append([l])
        for g in groups:
            g.sort(key=lambda l: (-BASE_SCORE.get(l.kind, 0), -l.formed_at))
            head = g[0]
            tags = []
            for other in g[1:]:
                if other.kind != head.kind and other.kind not in tags:
                    tags.append(other.kind)
            head.tags = tags
            result.append(head)
    return result


def compute_levels(snap: Snapshot, cfg: LiquidityConfig, sessions: SessionEngine,
                   atr_m5: float, keep_taken_within_bars: int = 3,
                   cache: Optional[dict] = None) -> list[Level]:
    """All liquidity levels knowable at ``snap.now``.

    Returns live (untaken) levels plus levels taken within the last
    ``keep_taken_within_bars`` M5 bars (needed to evaluate a sweep in progress).
    """
    point = snap.spec.point if snap.spec else 0.01
    raw: list[Level] = []
    if cfg.use_pdh_pdl:
        raw += _pd_levels(snap)
    if cfg.use_asia:
        raw += _asia_levels(snap, cfg, sessions)
    if cfg.use_h1_swings:
        raw += _swing_levels(snap, "H1", cfg.swing_strength_h1, cfg.h1_swing_lookback_bars, "H1", cache)
    if cfg.use_m15_swings:
        raw += _swing_levels(snap, "M15", cfg.swing_strength_m15, cfg.m15_swing_lookback_bars, "M15", cache)
    if cfg.use_equal_levels:
        raw += _equal_levels(snap, cfg, atr_m5, point)

    raw = [l for l in raw if l.formed_at <= snap.now]   # defensive: never a future level
    taker = _Taker(snap)
    for l in raw:
        taker.mark(l)

    n_m5 = len(snap.bars.get("M5", []))
    keep: list[Level] = []
    for l in raw:
        if l.taken_time is None:
            keep.append(l)
        elif l.m5_take_index is not None and n_m5 - 1 - l.m5_take_index < keep_taken_within_bars:
            keep.append(l)

    # Swing levels: keep only the most recent N per TF/side to avoid clutter.
    limited: list[Level] = []
    for kind in {l.kind for l in keep}:
        group = sorted([l for l in keep if l.kind == kind], key=lambda l: -l.source_time)
        cap = cfg.max_swings_per_side if "SWING" in kind or kind in ("EQH", "EQL") else len(group)
        limited += group[:cap]

    return _merge_confluence(limited, cfg.confluence_atr * atr_m5)
