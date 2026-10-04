import pytest

from xau.config import StrategyConfig
from xau.sessions import SessionEngine
from xau.strategy.engine import StrategyEngine
from tests.helpers import make_store, ts
from tests.scenarios import mirror, sell_core, sell_no_retrace, sell_scenario, sell_stopped


def run(m5, cfg=None, until=None):
    store = make_store(m5)
    eng = StrategyEngine(cfg or StrategyConfig(), SessionEngine())
    events = []
    for ct in store.m5_close_times(None, until):
        events += eng.on_bar(store.snapshot_at(ct))
    return eng, events


def final(events, setup_id):
    return [e for e in events if e["id"] == setup_id][-1]


def london_setup(events, direction):
    ids = [e["id"] for e in events if e["direction"] == direction and e["sweep"]["sweep_time"] == ts("2025-01-15 08:00")]
    assert ids, "London sweep setup not created"
    return ids[0]


def test_full_sell_chain_a_plus_and_tp2():
    eng, ev = run(sell_scenario())
    s = final(ev, london_setup(ev, "SELL"))
    assert s["sweep"]["level"]["kind"] == "ASIA_HIGH"
    assert s["mss"]["level"] == pytest.approx(2652.0)
    assert s["displacement"]["rule"] == "single"
    assert (s["fvg"]["bottom"], s["fvg"]["top"]) == (2651.2, 2654.4)
    assert s["plan"]["entry"] == pytest.approx(2652.8)
    assert s["plan"]["sl"] == pytest.approx(2656.2 + 0.2 + 0.2)       # extreme + max(0.1ATR, 20pt) + spread
    assert s["plan"]["tp2_source"] == "PDL" and s["plan"]["tp2_rr"] >= 3
    assert s["grade"] == "A+" and s["taken"]
    assert s["score_total"] == sum(c["points"] for c in s["score"].values())   # reproducible
    assert s["trade"]["result"] == "WIN" and s["trade"]["r_result"] == pytest.approx(s["plan"]["tp2_rr"])
    assert s["trade"]["outcomes"]["2R"]["status"] == "win"
    assert s["trade"]["mae_r"] < 1 and s["trade"]["mfe_r"] >= s["plan"]["tp2_rr"]


def test_stage_order_is_strictly_sequential():
    """MSS cannot precede the sweep, FVG/entry cannot precede displacement."""
    _, ev = run(sell_scenario())
    s = final(ev, london_setup(ev, "SELL"))
    assert s["sweep"]["extreme_time"] <= s["mss"]["break_time"]
    assert s["mss"]["swing_time"] < s["sweep"]["extreme_time"]
    assert s["displacement"]["start_time"] >= s["sweep"]["extreme_time"]
    assert s["fvg"]["c3_time"] <= s["fvg_selected_time"] < s["entry_time"]


def test_waiting_for_retracement_state_and_labels():
    eng, ev = run(sell_scenario(), until=ts("2025-01-15 08:30"))
    d = eng.describe()
    assert d["label"]["text"] == "WAITING FOR RETRACEMENT"
    steps = {x["name"]: x["state"] for x in d["steps"]}
    assert steps == {"Liquidity": "done", "Sweep": "done", "MSS": "done", "Displacement": "done",
                     "Retracement": "current", "Entry": "locked", "Target": "locked"}
    ck = {c["key"]: c["state"] for c in d["checklist"]}
    assert ck["fvg"] == "pass" and ck["retrace"] == "pending" and ck["rr"] == "pass"


def test_signal_label_after_entry():
    eng, _ = run(sell_scenario(), until=ts("2025-01-15 09:10"))
    d = eng.describe()
    assert d["label"]["text"] == "A+ SELL"
    assert {c["key"]: c["state"] for c in d["checklist"]}["retrace"] == "pass"


def test_stop_loss_outcome():
    _, ev = run(sell_stopped())
    s = final(ev, london_setup(ev, "SELL"))
    assert s["trade"]["result"] == "LOSS" and s["trade"]["r_result"] == -1.0
    assert all(o["status"] == "loss" for o in s["trade"]["outcomes"].values())


def test_no_chasing_when_price_never_retraces():
    _, ev = run(sell_no_retrace())
    s = final(ev, london_setup(ev, "SELL"))
    assert s["status"] == "INVALIDATED" and s["entry_time"] is None
    assert "without retracing" in s["reasons"][-1]


def test_rejects_setup_when_r_target_missing():
    cfg = StrategyConfig()
    cfg.risk.min_rr = 8.0                         # no real liquidity that far => must reject, not invent
    _, ev = run(sell_scenario(), cfg)
    s = final(ev, london_setup(ev, "SELL"))
    assert s["status"] == "NO_TRADE" and s["entry_time"] is None
    assert "No real liquidity target" in s["reasons"][-1]


def test_score_below_threshold_is_not_a_plus():
    cfg = StrategyConfig()
    cfg.score.a_plus_threshold = 99
    _, ev = run(sell_scenario(), cfg)
    s = final(ev, london_setup(ev, "SELL"))
    assert s["grade"] == "BELOW_THRESHOLD" and not s["taken"]


def test_session_filter_blocks_entry():
    cfg = StrategyConfig()
    cfg.filters.allowed_entry_sessions = ["New York"]
    _, ev = run(sell_scenario(), cfg)
    s = final(ev, london_setup(ev, "SELL"))
    assert s["grade"] == "FILTERED" and not s["filters"]["session"]["ok"]


def test_news_filter_blocks_entry():
    cfg = StrategyConfig()
    cfg.filters.news_events = [{"time": "2025-01-15T09:15:00Z", "title": "test event"}]
    _, ev = run(sell_scenario(), cfg)
    s = final(ev, london_setup(ev, "SELL"))
    assert s["grade"] == "FILTERED" and "test event" in s["filters"]["news"]["detail"]


def test_feed_not_live_blocks_signal():
    store = make_store(sell_scenario())
    eng = StrategyEngine(StrategyConfig(), SessionEngine())
    out = []
    for ct in store.m5_close_times():
        out += eng.on_bar(store.snapshot_at(ct), feed_live=False)
    s = final(out, london_setup(out, "SELL"))
    assert not s["taken"] and not s["filters"]["feed"]["ok"]


def test_buy_mirror_scenario():
    _, ev = run(mirror(sell_scenario()))
    s = final(ev, london_setup(ev, "BUY"))
    assert s["sweep"]["level"]["kind"] == "ASIA_LOW"
    assert s["grade"] == "A+" and s["trade"]["result"] == "WIN"
    assert s["plan"]["tp2_source"] == "PDH"


def test_confirmation_entry_mode():
    cfg = StrategyConfig()
    cfg.entry.mode = "confirmation"
    _, ev = run(sell_scenario(), cfg)
    s = final(ev, london_setup(ev, "SELL"))
    # the retrace leg is all bullish candles, so the first bearish close inside the zone confirms
    assert s["entry_time"] is not None
    assert s["entry_price"] <= s["fvg"]["top"]


def test_no_signal_without_sweep():
    m5 = sell_core()[:-3]
    _, ev = run(m5, until=ts("2025-01-15 07:50"))
    assert not any(e.get("taken") for e in ev)


def test_engine_is_idempotent_per_bar():
    store = make_store(sell_scenario())
    eng = StrategyEngine(StrategyConfig(), SessionEngine())
    ct = store.m5_close_times()[700]
    eng.on_bar(store.snapshot_at(ct))
    assert eng.on_bar(store.snapshot_at(ct)) == []
