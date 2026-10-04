"""Application + strategy settings.  Persisted as JSON in ``config/settings.json``.

Every threshold the strategy uses lives here, so the rules are explicit and the
same values drive live mode and backtests.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(os.environ.get("XAU_CONFIG", ROOT / "config" / "settings.json"))


@dataclass
class LiquidityConfig:
    swing_strength_m5: int = 2          # bars each side for an M5 fractal swing
    swing_strength_m15: int = 2
    swing_strength_h1: int = 2
    m15_swing_lookback_bars: int = 96   # 24h of M15
    h1_swing_lookback_bars: int = 72    # 3 days of H1
    max_swings_per_side: int = 3        # most recent unswept swings kept per TF/side
    eq_lookback_bars: int = 288         # 24h of M5 for equal highs/lows
    eq_tolerance_atr: float = 0.10      # |h1-h2| <= tol * ATR(M5)
    eq_tolerance_points_min: int = 10   # floor on the tolerance, in points
    eq_min_separation_bars: int = 6     # the two swings must be >= N bars apart
    asia_max_age_hours: float = 20.0    # Asia range is only used for this long after it closes
    confluence_atr: float = 0.15        # levels within this distance are merged (confluence)
    use_pdh_pdl: bool = True
    use_asia: bool = True
    use_equal_levels: bool = True
    use_m15_swings: bool = True
    use_h1_swings: bool = True


@dataclass
class SweepConfig:
    min_penetration_points: int = 10    # wick must trade beyond the level by at least this
    min_penetration_atr: float = 0.05
    max_penetration_atr: float = 1.5    # beyond this it is a breakout, not a sweep
    reclaim_max_bars: int = 3           # close back inside within N M5 bars (1 = same candle)


@dataclass
class MSSConfig:
    swing_strength: int = 2             # M5 fractal strength for the protected swing
    lookback_bars: int = 36             # how far before the sweep to look for the protected swing
    max_bars_after_sweep: int = 24      # MSS must happen within N M5 bars after the sweep


@dataclass
class DisplacementConfig:
    atr_period: int = 14
    median_body_period: int = 20
    min_body_atr: float = 1.2           # body >= k * ATR(M5)
    min_body_median: float = 1.8        # body >= k * median body of previous N candles
    max_close_location: float = 0.35    # bearish: (close-low)/range <= x ; bullish mirrored
    consecutive_min: int = 3            # alt. rule: N consecutive directional candles...
    consecutive_total_body_atr: float = 2.0  # ...whose bodies sum to >= k * ATR
    max_bars_after_mss: int = 2         # displacement may complete up to N bars after MSS


@dataclass
class FVGConfig:
    min_size_atr: float = 0.15
    min_size_points: int = 20
    max_bars_after_mss: int = 3         # FVG's 3rd candle must close within N bars after MSS


@dataclass
class EntryConfig:
    # "limit_ce": limit at the FVG midpoint (consequent encroachment)
    # "limit_edge": limit at the proximal FVG edge
    # "confirmation": candle trades into the FVG and closes back in trade direction; entry = close
    mode: str = "limit_ce"
    retrace_max_bars: int = 36          # wait at most N M5 bars for the retracement
    max_hold_bars: int = 144            # trade tracking horizon (12h of M5)


@dataclass
class RiskConfig:
    sl_buffer_atr: float = 0.10
    sl_buffer_points: int = 20
    add_spread_to_buffer: bool = True
    min_sl_price: float = 0.50          # $ distance
    max_sl_price: float = 12.0          # $ distance – reject if structure needs more
    max_sl_atr: float = 3.0
    min_rr: float = 3.0                 # TP2 must be a real liquidity target at >= this R
    tp1_min_rr: float = 1.5
    tp1_fallback_r_multiple: float = 2.0  # TP1 at fixed R only if TP2 liquidity exists beyond it
    allow_r_multiple_tp1: bool = True
    target_frontrun_points: int = 10    # TP placed this many points before the liquidity
    max_target_distance_h1_atr: float = 8.0  # targets further than this are "unrealistic"


@dataclass
class FilterConfig:
    allowed_entry_sessions: list = field(default_factory=lambda: ["London", "New York"])
    htf_mode: str = "not_opposed"       # "off" | "not_opposed" | "aligned"
    htf_swing_strength: int = 2
    news_block_before_min: int = 30
    news_block_after_min: int = 30
    # Manually maintained list (MT5's Python API exposes no economic calendar):
    # [{"time": "2026-10-02T12:30:00Z", "title": "US NFP", "currency": "USD"}]
    news_events: list = field(default_factory=list)


@dataclass
class ScoreConfig:
    a_plus_threshold: int = 80


@dataclass
class StrategyConfig:
    liquidity: LiquidityConfig = field(default_factory=LiquidityConfig)
    sweep: SweepConfig = field(default_factory=SweepConfig)
    mss: MSSConfig = field(default_factory=MSSConfig)
    displacement: DisplacementConfig = field(default_factory=DisplacementConfig)
    fvg: FVGConfig = field(default_factory=FVGConfig)
    entry: EntryConfig = field(default_factory=EntryConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)
    filters: FilterConfig = field(default_factory=FilterConfig)
    score: ScoreConfig = field(default_factory=ScoreConfig)


@dataclass
class SessionItem:
    name: str
    tz: str
    start: str
    end: str


@dataclass
class FeedConfig:
    terminal_path: str = ""             # optional path to terminal64.exe; "" = attach to running terminal
    symbol_override: str = ""           # "" = auto-detect
    symbol_candidates: list = field(default_factory=lambda: ["XAUUSD", "GOLD"])
    server_timezone: str = "NY+7"       # see xau/timeutil.py
    stale_seconds: float = 30.0         # no new tick for this long during market hours => STALE
    poll_interval_ms: int = 250
    chart_bars: int = 1500


@dataclass
class AccountConfig:
    balance_source: str = "mt5"         # "mt5" | "manual"
    manual_balance: float = 10000.0
    risk_percent: float = 0.5


@dataclass
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8765
    open_browser: bool = True
    db_path: str = "data/signals.db"


@dataclass
class AppConfig:
    strategy: StrategyConfig = field(default_factory=StrategyConfig)
    feed: FeedConfig = field(default_factory=FeedConfig)
    account: AccountConfig = field(default_factory=AccountConfig)
    server: ServerConfig = field(default_factory=ServerConfig)
    sessions: list = field(default_factory=lambda: [
        {"name": "Asian", "tz": "Asia/Tokyo", "start": "09:00", "end": "15:00"},
        {"name": "London", "tz": "Europe/London", "start": "08:00", "end": "16:30"},
        {"name": "New York", "tz": "America/New_York", "start": "08:00", "end": "17:00"},
    ])

    def to_dict(self) -> dict:
        return asdict(self)


def _from_dict(cls, data: Any):
    """Recursively build dataclass ``cls`` from a dict, ignoring unknown keys
    and keeping defaults for missing keys (so old settings files keep working)."""
    if not is_dataclass(cls) or not isinstance(data, dict):
        return data
    kwargs = {}
    for f in fields(cls):
        if f.name not in data:
            continue
        val = data[f.name]
        ftype = f.type if not isinstance(f.type, str) else globals().get(f.type, None)
        if ftype is not None and is_dataclass(ftype):
            kwargs[f.name] = _from_dict(ftype, val)
        else:
            kwargs[f.name] = val
    return cls(**kwargs)


def config_from_dict(d: dict) -> AppConfig:
    return _from_dict(AppConfig, d)


def strategy_from_dict(d: dict) -> StrategyConfig:
    return _from_dict(StrategyConfig, d)


def load_config(path: Path = CONFIG_PATH) -> AppConfig:
    if path.exists():
        with open(path, "r", encoding="utf-8") as fh:
            return config_from_dict(json.load(fh))
    cfg = AppConfig()
    save_config(cfg, path)
    return cfg


def save_config(cfg: AppConfig, path: Path = CONFIG_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg.to_dict(), fh, indent=2)
    os.replace(tmp, path)
