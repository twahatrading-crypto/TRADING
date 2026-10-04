"""Stop loss, take profit and R calculation from market structure.

SL  : beyond the sweep extreme + max(ATR buffer, point buffer) [+ bar spread].
      Never shrunk artificially; rejected if wider than the configured limits.
TP2 : the nearest *real* opposing liquidity level giving R >= ``min_rr`` and
      within a realistic distance.  If no such level exists the setup is
      rejected – targets are never invented to reach 1:3.
TP1 : nearest opposing liquidity between entry and TP2 with R >= ``tp1_min_rr``;
      otherwise (optional) a fixed R multiple, but only because TP2 liquidity
      exists beyond it.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Optional

from ..config import RiskConfig
from .liquidity import Level


@dataclass
class TradePlan:
    direction: str
    entry: float
    sl: float
    tp1: Optional[float]
    tp2: Optional[float]
    tp1_source: str = ""
    tp2_source: str = ""
    risk: float = 0.0            # |entry - sl| in price
    risk_points: float = 0.0
    tp1_rr: float = 0.0
    tp2_rr: float = 0.0
    valid: bool = False
    reasons: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def compute_sl(direction: str, extreme: float, atr_m5: float, spread_price: float,
               point: float, cfg: RiskConfig) -> float:
    buf = max(cfg.sl_buffer_atr * atr_m5, cfg.sl_buffer_points * point)
    if cfg.add_spread_to_buffer:
        buf += spread_price
    return extreme + buf if direction == "SELL" else extreme - buf


def build_plan(direction: str, entry: float, sl: float, levels: list[Level], atr_m5: float,
               atr_h1: float, point: float, cfg: RiskConfig) -> TradePlan:
    p = TradePlan(direction, entry, sl, None, None)
    risk = (sl - entry) if direction == "SELL" else (entry - sl)
    p.risk = risk
    p.risk_points = risk / point if point else 0.0
    if risk <= 0:
        p.reasons.append("SL is not beyond entry")
        return p
    if risk < cfg.min_sl_price:
        p.reasons.append(f"Structural SL {risk:.2f} below minimum {cfg.min_sl_price:.2f}")
    if risk > cfg.max_sl_price:
        p.reasons.append(f"Structural SL {risk:.2f} exceeds max {cfg.max_sl_price:.2f}")
    if atr_m5 > 0 and risk > cfg.max_sl_atr * atr_m5:
        p.reasons.append(f"Structural SL {risk / atr_m5:.1f}xATR exceeds max {cfg.max_sl_atr:.1f}xATR")

    max_dist = cfg.max_target_distance_h1_atr * atr_h1 if atr_h1 > 0 else float("inf")
    fr = cfg.target_frontrun_points * point
    cands = []
    for l in levels:
        if not l.is_live():
            continue
        if direction == "SELL" and l.side == "low" and l.price < entry:
            tp = l.price + fr
            dist = entry - tp
        elif direction == "BUY" and l.side == "high" and l.price > entry:
            tp = l.price - fr
            dist = tp - entry
        else:
            continue
        if dist <= 0 or dist > max_dist:
            continue
        cands.append((dist, tp, l))
    cands.sort(key=lambda x: x[0])

    tp2 = next((c for c in cands if c[0] / risk >= cfg.min_rr), None)
    if tp2 is None:
        p.reasons.append(f"No real liquidity target at >= 1:{cfg.min_rr:g} within reach")
    else:
        p.tp2, p.tp2_rr, p.tp2_source = tp2[1], tp2[0] / risk, tp2[2].kind
        tp1 = next((c for c in cands if c[0] < tp2[0] and c[0] / risk >= cfg.tp1_min_rr), None)
        if tp1 is not None:
            p.tp1, p.tp1_rr, p.tp1_source = tp1[1], tp1[0] / risk, tp1[2].kind
        elif cfg.allow_r_multiple_tp1 and cfg.tp1_fallback_r_multiple * risk < tp2[0]:
            d = cfg.tp1_fallback_r_multiple * risk
            p.tp1 = entry - d if direction == "SELL" else entry + d
            p.tp1_rr, p.tp1_source = cfg.tp1_fallback_r_multiple, f"{cfg.tp1_fallback_r_multiple:g}R (partial before {tp2[2].kind})"
        else:
            p.tp1, p.tp1_rr, p.tp1_source = p.tp2, p.tp2_rr, p.tp2_source
    p.valid = not p.reasons
    return p


def position_size(balance: float, risk_percent: float, sl_distance: float, spec) -> dict:
    """Lot size from account risk / structural SL distance using the broker's
    own contract spec (tick size, tick value, volume min/max/step)."""
    out = {"balance": balance, "risk_percent": risk_percent,
           "risk_money": balance * risk_percent / 100.0, "volume": 0.0,
           "loss_per_lot": None, "actual_risk_money": 0.0, "actual_risk_percent": 0.0,
           "warnings": []}
    if spec is None or sl_distance <= 0 or balance <= 0:
        out["warnings"].append("missing symbol spec, balance or SL")
        return out
    tick_size = spec.tick_size or spec.point
    tick_value = spec.tick_value_loss or spec.tick_value
    if not tick_size or not tick_value:
        out["warnings"].append("broker did not report tick size/value")
        return out
    loss_per_lot = sl_distance / tick_size * tick_value
    out["loss_per_lot"] = loss_per_lot
    raw = out["risk_money"] / loss_per_lot
    step = spec.volume_step or 0.01
    vol = int(raw / step + 1e-9) * step
    if spec.volume_max and vol > spec.volume_max:
        vol = spec.volume_max
        out["warnings"].append("capped at broker max volume")
    if vol < (spec.volume_min or step):
        out["warnings"].append(
            f"risk too small for min volume {spec.volume_min:g}: min lot would risk "
            f"{spec.volume_min * loss_per_lot:.2f}")
        vol = 0.0
    decimals = max(0, len(f"{step:.10f}".rstrip("0").split(".")[1]) if "." in f"{step:.10f}".rstrip("0") else 0)
    out["volume"] = round(vol, decimals)
    out["actual_risk_money"] = out["volume"] * loss_per_lot
    out["actual_risk_percent"] = out["actual_risk_money"] / balance * 100.0
    return out
