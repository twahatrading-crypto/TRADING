"""MT5 adapter + live service tests against a test double of the MetaTrader5
package (the real package needs a Windows terminal; see README for the manual
live checklist)."""
import asyncio
import dataclasses
import re
from pathlib import Path

import pytest

from xau.backtest import run_backtest
from xau.config import AppConfig
from xau.live import LIVE, MARKET_CLOSED, OFFLINE, RECONNECTING, STALE, LiveService
from xau.models import TIMEFRAMES
from xau.mt5_client import MT5Client, ReadOnlyMT5, TradingCallBlocked, rank_symbols
from xau.sessions import SessionEngine
from xau.signal_log import SignalLog
from xau.timeutil import ServerClock
from tests.fake_mt5 import FakeMT5
from tests.helpers import aggregate, make_store, ts
from tests.scenarios import sell_scenario

ROOT = Path(__file__).resolve().parent.parent
CLOCK = ServerClock("NY+7")


def fake_with_data(m5=None, **kw):
    m5 = m5 or sell_scenario()
    m1 = []
    for c in m5:   # M1 bars only needed for the chart; split each M5 bar evenly (test data)
        for k in range(5):
            m1.append(type(c)(c.time + 60 * k, c.open, c.high, c.low, c.close, 20, c.spread))
    bars = {"M1": m1, "M5": m5, "M15": aggregate(m5, "M15"), "H1": aggregate(m5, "H1"),
            "H4": aggregate(m5, "H4"), "D1": aggregate(m5, "D1", CLOCK)}
    return FakeMT5(bars, CLOCK, **kw)


# ------------------------------------------------------------------ symbols
@pytest.mark.parametrize("names,expected", [
    (["EURUSD", "XAUUSD", "XAUUSDm"], "XAUUSD"),
    (["EURUSD", "XAUUSDm", "XAUEUR"], "XAUUSDm"),
    (["XAUUSD.a", "XAUAUD"], "XAUUSD.a"),
    (["GOLD", "GOLDm"], "GOLD"),
    (["GOLDm", "SILVER"], "GOLDm"),
    (["XAUUSD#", "XAUUSD.pro"], "XAUUSD#"),
])
def test_symbol_ranking(names, expected):
    assert rank_symbols(names, ["XAUUSD", "GOLD"])[0] == expected


def test_symbol_ranking_rejects_other_instruments():
    assert rank_symbols(["XAUEUR", "XAUUSDT", "GOLDEUR", "GOLDEN", "XAGUSD"], ["XAUUSD", "GOLD"]) == []


# ------------------------------------------------------------------- safety
def test_read_only_proxy_blocks_trading_calls():
    fake = fake_with_data()
    ro = ReadOnlyMT5(fake)
    for name in ("order_send", "order_check", "positions_get", "Buy", "Sell", "close"):
        with pytest.raises(TradingCallBlocked):
            getattr(ro, name)
    assert fake.orders_sent == 0


def test_source_never_calls_order_send():
    pat = re.compile(r"\border_send\s*\(|\border_check\s*\(|\bpositions_close\b")
    offenders = []
    for p in list((ROOT / "xau").rglob("*.py")) + list((ROOT / "frontend").glob("*.js")):
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            if pat.search(line):
                offenders.append(f"{p}:{i}: {line.strip()}")
    assert offenders == []


# ------------------------------------------------------------------ adapter
def test_adapter_reads_spec_ticks_and_all_timeframes_in_utc():
    fake = fake_with_data()
    fake.set_tick(ts("2025-01-15 08:12"), 2650.5, 2650.75)
    cl = MT5Client(fake, CLOCK)
    assert cl.connect()
    name, cands = cl.detect_symbol(["XAUUSD", "GOLD"])
    assert name == "XAUUSDm" and cands == ["XAUUSDm"]
    spec = cl.spec(name)
    assert spec.contract_size == 100 and spec.volume_step == 0.01 and spec.tick_value == 1.0
    tick, raw = cl.tick(name)
    assert tick.time == ts("2025-01-15 08:12") and raw == ts("2025-01-15 10:12")   # GMT+2 server
    assert tick.spread_points(spec.point) == 25.0
    for tf in TIMEFRAMES:
        bars = cl.rates(name, tf, 50)
        assert bars, tf
        assert bars[-1].time <= ts("2025-01-15 08:12")
        src = [c for c in fake.bars_utc[tf] if c.time <= fake.now_utc][-50:]
        assert [c.time for c in bars] == [c.time for c in src]       # server -> UTC exactly inverted


def test_connect_fails_cleanly_when_terminal_closed_or_package_missing():
    fake = fake_with_data()
    fake.terminal_running = False
    cl = MT5Client(fake, CLOCK)
    assert not cl.connect() and "terminal running" in cl.last_error
    cl2 = MT5Client(None, CLOCK)
    assert not cl2.connect() and "not installed" in cl2.last_error


# -------------------------------------------------------------- live service
class Clock:
    def __init__(self, t):
        self.wall, self.mono = float(t), 1000.0


def make_service(tmp_path, fake, t):
    cfg = AppConfig()
    cfg.feed.stale_seconds = 30
    clk = Clock(t)
    svc = LiveService(cfg, fake, log_db=SignalLog(tmp_path / "s.db"),
                      wall=lambda: clk.wall, mono=lambda: clk.mono)
    return svc, clk


def step(svc):
    asyncio.run(svc.run_once())


def advance(fake, clk, utc, bid=None, tick=True):
    clk.mono += utc - fake.now_utc if utc > fake.now_utc else 1
    clk.wall = utc + 0.5
    if tick:
        b = bid if bid is not None else 2650.0
        fake.set_tick(utc, b, b + 0.25)
    else:
        fake.now_utc = utc


def test_live_connect_stale_reconnect_cycle(tmp_path):
    fake = fake_with_data()
    t = ts("2025-01-15 08:12")
    fake.set_tick(t, 2650.0, 2650.25)
    svc, clk = make_service(tmp_path, fake, t + 1)
    step(svc)
    assert svc.status == LIVE and svc.symbol == "XAUUSDm"
    assert svc.engine.last_bar_time == ts("2025-01-15 08:05")          # last CLOSED bar only
    assert svc.strategy_payload()["label"]["text"] == "SETUP FORMING"

    # ticks stop while the market is open -> DATA STALE, nothing evaluated
    clk.mono += 31
    fake.now_utc = ts("2025-01-15 08:21")                                # new bars exist, but no new tick
    clk.wall = fake.now_utc
    step(svc)
    assert svc.status == STALE
    assert svc.engine.last_bar_time == ts("2025-01-15 08:05")
    assert "STALE" in svc.strategy_payload()["paused_reason"]
    assert svc.full_state()["tick"] == {}                                 # no stale quote exposed

    # ticks resume -> LIVE and the missed bars are processed in order
    advance(fake, clk, ts("2025-01-15 08:21"))
    clk.mono += 11
    step(svc)
    assert svc.status == LIVE
    assert svc.engine.last_bar_time == ts("2025-01-15 08:15")
    assert svc.strategy_payload()["label"]["text"] == "WAITING FOR RETRACEMENT"

    # terminal loses broker connection
    fake.broker_connected = False
    step(svc)
    assert svc.status == RECONNECTING

    # terminal closed entirely -> reconnecting, then OFFLINE after retries
    fake.broker_connected = True
    fake.terminal_running = False
    step(svc)
    assert svc.status == RECONNECTING
    for _ in range(5):
        clk.mono += 20
        step(svc)
    assert svc.status == OFFLINE
    assert "terminal" in svc.status_detail.lower() or "initialize" in svc.status_detail.lower()

    # terminal back -> reconnect, fresh tick -> LIVE
    fake.terminal_running = True
    clk.mono += 20
    advance(fake, clk, ts("2025-01-15 08:23"))
    step(svc)
    assert svc.status == LIVE


def test_market_closed_status(tmp_path):
    fake = fake_with_data()
    t = ts("2025-01-15 08:12")
    fake.set_tick(t, 2650.0, 2650.25)
    svc, clk = make_service(tmp_path, fake, t + 1)
    step(svc)
    clk.mono += 100
    clk.wall = ts("2025-01-18 12:00")       # Saturday
    step(svc)
    assert svc.status == MARKET_CLOSED


def test_detects_server_offset_mismatch(tmp_path):
    fake = fake_with_data()
    t = ts("2025-01-15 08:12")
    fake.set_tick(t, 2650.0, 2650.25)
    svc, clk = make_service(tmp_path, fake, t + 1)
    step(svc)
    advance(fake, clk, t + 5)
    step(svc)
    st = svc.status_json()
    assert st["server_offset_detected"] == 7200 and st["server_offset_configured"] == 7200
    assert not [w for w in st["warnings"] if "offset" in w]


def test_live_and_backtest_produce_identical_setups(tmp_path):
    """Same engine, same data -> same setups.  Drives the live service bar by bar."""
    m5 = sell_scenario()
    fake = fake_with_data(m5)
    t = ts("2025-01-15 07:01")
    fake.set_tick(t, 2650.0, 2650.25)
    svc, clk = make_service(tmp_path, fake, t + 1)
    step(svc)
    end = m5[-1].time
    cur = t
    while cur < end:
        cur += 300
        advance(fake, clk, cur + 2)
        step(svc)
    live_rows = {r["id"]: r for r in svc.log_db.recent(1000)}

    store = make_store(m5)
    store.spec = dataclasses.replace(store.spec, name="XAUUSDm")
    closes = [ct for ct in store.m5_close_times() if ct <= t]
    first = closes[-576]                                        # the live warm-up window
    _, setups = run_backtest(store, svc.cfg.strategy, SessionEngine(), first, end)
    bt = {s["id"]: s for s in setups}
    assert set(bt) == set(live_rows)
    for k, s in bt.items():
        r = live_rows[k]
        assert (r["status"], r["grade"], r["entry"], r["result"]) == \
               (s["status"], s["grade"], s.get("entry_price") or (s.get("plan") or {}).get("entry"),
                (s.get("trade") or {}).get("result"))
    assert any(s["grade"] == "A+" for s in bt.values())
