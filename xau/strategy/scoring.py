"""Setup quality score (0-100).  Every point comes from an explicit rule below,
so any score can be reproduced from the stored components.

    Liquidity quality  20   level type base + 3 per confluent level (see liquidity.BASE_SCORE)
    Sweep quality      15   reclaim speed 6 | penetration sweet-spot 5 | rejection wick 4
    MSS                15   close beyond level 5 | speed after sweep 5 | MSS candle is displacement 5
    Displacement       15   body/ATR 8 | close location 4 | follow-through 3
    Retracement / FVG  10   gap size 5 | first touch 3 | fill depth (CE reached) 2
    H1 / M15 alignment 10   H1 5 | M15 5   (aligned = full, neutral = 2, opposed = 0)
    R quality          10   TP2 R >= 4 -> 10, >= 3 -> 7
    Session quality     5   entry in London/New York 5 (overlap counts), else 0
"""
from __future__ import annotations

from typing import Optional

MAX = {"liquidity": 20, "sweep": 15, "mss": 15, "displacement": 15,
       "fvg": 10, "htf": 10, "rr": 10, "session": 5}


def _c(points: int, maxp: int, notes: list[str]) -> dict:
    return {"points": int(min(points, maxp)), "max": maxp, "rules": notes}


def score_liquidity(level: dict) -> dict:
    return _c(level["score"], MAX["liquidity"],
              [f"{level['kind']} base", *(f"+3 confluence {t}" for t in level.get("tags", []))])


def score_sweep(sweep: dict) -> dict:
    pts, notes = 0, []
    if sweep["reclaim_bars"] == 1:
        pts += 6; notes.append("same-candle reclaim +6")
    elif sweep["reclaim_bars"] <= 3:
        pts += 3; notes.append(f"reclaim in {sweep['reclaim_bars']} bars +3")
    pa = sweep["penetration_atr"]
    if 0.1 <= pa <= 1.0:
        pts += 5; notes.append(f"penetration {pa:.2f}xATR in 0.1-1.0 +5")
    else:
        pts += 2; notes.append(f"penetration {pa:.2f}xATR outside sweet-spot +2")
    if sweep["rejection_wick_ratio"] >= 0.4:
        pts += 4; notes.append("rejection wick >= 40% of range +4")
    elif sweep["rejection_wick_ratio"] >= 0.2:
        pts += 2; notes.append("rejection wick >= 20% +2")
    return _c(pts, MAX["sweep"], notes)


def score_mss(mss: dict, disp: Optional[dict]) -> dict:
    pts, notes = 0, []
    if mss["close_beyond_atr"] >= 0.1:
        pts += 5; notes.append("close >= 0.1xATR beyond structure +5")
    else:
        pts += 2; notes.append("marginal close beyond structure +2")
    if mss["bars_after_sweep"] <= 6:
        pts += 5; notes.append(f"MSS {mss['bars_after_sweep']} bars after sweep (<=6) +5")
    elif mss["bars_after_sweep"] <= 12:
        pts += 3; notes.append(f"MSS {mss['bars_after_sweep']} bars after sweep (<=12) +3")
    if disp and disp["start_time"] <= mss["break_time"] <= disp["end_time"]:
        pts += 5; notes.append("MSS candle is part of displacement +5")
    return _c(pts, MAX["mss"], notes)


def score_displacement(d: dict) -> dict:
    pts, notes = 0, []
    b = d["best_body_atr"]
    if b >= 2.0:
        pts += 8; notes.append(f"body {b:.2f}xATR >= 2.0 +8")
    elif b >= 1.5:
        pts += 6; notes.append(f"body {b:.2f}xATR >= 1.5 +6")
    else:
        pts += 4; notes.append(f"body {b:.2f}xATR meets minimum +4")
    if d["best_close_location"] <= 0.2:
        pts += 4; notes.append("closed in outer 20% of range +4")
    else:
        pts += 2; notes.append("close location acceptable +2")
    if d["consecutive"] >= 3 or d["total_body_atr"] >= 2.5:
        pts += 3; notes.append("follow-through +3")
    return _c(pts, MAX["displacement"], notes)


def score_fvg(fvg: dict, first_touch: bool, ce_reached: bool) -> dict:
    pts, notes = 0, []
    if fvg["size_atr"] >= 0.5:
        pts += 5; notes.append(f"gap {fvg['size_atr']:.2f}xATR >= 0.5 +5")
    else:
        pts += 3; notes.append(f"gap {fvg['size_atr']:.2f}xATR meets minimum +3")
    if first_touch:
        pts += 3; notes.append("first touch of the zone +3")
    if ce_reached:
        pts += 2; notes.append("retracement reached 50% (CE) +2")
    return _c(pts, MAX["fvg"], notes)


def _align(bias: str, direction: str) -> int:
    want = "bearish" if direction == "SELL" else "bullish"
    if bias == want:
        return 5
    return 2 if bias == "neutral" else 0


def score_htf(h1: str, m15: str, direction: str) -> dict:
    a, b = _align(h1, direction), _align(m15, direction)
    return _c(a + b, MAX["htf"], [f"H1 {h1} +{a}", f"M15 {m15} +{b}"])


def score_rr(tp2_rr: float) -> dict:
    if tp2_rr >= 4:
        return _c(10, MAX["rr"], [f"TP2 {tp2_rr:.2f}R >= 4 +10"])
    if tp2_rr >= 3:
        return _c(7, MAX["rr"], [f"TP2 {tp2_rr:.2f}R >= 3 +7"])
    return _c(0, MAX["rr"], [f"TP2 {tp2_rr:.2f}R < 3"])


def score_session(active: list[str]) -> dict:
    if "London" in active or "New York" in active:
        return _c(5, MAX["session"], [f"entry in {'/'.join(active)} +5"])
    return _c(0, MAX["session"], [f"entry in {'/'.join(active) or 'no major session'} +0"])


def total(components: dict) -> int:
    return int(sum(c["points"] for c in components.values()))
