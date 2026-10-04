import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from xau.backtest import compute_stats, format_report, load_csv, load_store_from_csv, run_backtest, save_csv, save_spec
from xau.config import AppConfig, StrategyConfig
from xau.server import create_app
from xau.sessions import SessionEngine
from xau.signal_log import SignalLog
from tests.helpers import SPEC, aggregate, make_store, ts
from tests.scenarios import mirror, sell_scenario, sell_stopped
from xau.models import Candle
from xau.timeutil import ServerClock

DATA = Path(__file__).parent / "data"


def three_weeks():
    shift = 7 * 86400
    return (sell_scenario() + [Candle(c.time + shift, *c[1:]) for c in mirror(sell_scenario())]
            + [Candle(c.time + 2 * shift, *c[1:]) for c in sell_stopped()])


def test_backtest_stats():
    _, setups = run_backtest(make_store(three_weeks()), StrategyConfig(), SessionEngine())
    st = compute_stats(setups)
    o = st["overall"]
    assert o["trades"] == 3 and o["wins"] == 2 and o["losses"] == 1
    rs = sorted(s["trade"]["r_result"] for s in setups if s.get("taken"))
    assert o["total_r"] == pytest.approx(sum(rs), abs=1e-3)
    assert o["profit_factor"] == pytest.approx((rs[1] + rs[2]) / 1.0, abs=1e-3)
    assert o["max_consecutive_losses"] == 1 and o["max_drawdown_r"] == pytest.approx(1.0)
    assert set(st["exits"]) == {"TP1", "TP2", "2R", "3R", "4R"}
    assert st["by_session"]["London"]["trades"] == 3
    assert "2025-01" in st["by_month"]
    assert "not evidence of future profitability" in format_report(st)


def test_replay_stored_candles_csv(tmp_path):
    """Replay test: candles written to CSV (the format exported from MT5) and
    read back must reproduce the same setups as the in-memory run."""
    m5 = three_weeks()
    store = make_store(m5)
    for tf, cs in store.bars.items():
        save_csv(tmp_path / f"XAUUSD_{tf}.csv", cs)
    save_spec(tmp_path / "XAUUSD_spec.json", SPEC)
    replay = load_store_from_csv(tmp_path, "XAUUSD")
    assert load_csv(tmp_path / "XAUUSD_M5.csv") == store.bars["M5"]
    _, a = run_backtest(store, StrategyConfig(), SessionEngine())
    _, b = run_backtest(replay, StrategyConfig(), SessionEngine())
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


@pytest.mark.skipif(not (DATA / "real").exists(), reason="no exported MT5 history in tests/data/real")
def test_replay_real_mt5_history():
    """Runs automatically once real history has been exported on the MT5 PC:
        python -m xau.backtest --from 2025-01-01 --to 2025-01-31 --csv-dir tests/data/real
    Checks determinism and look-ahead safety on real broker candles."""
    sym = next((DATA / "real").glob("*_M5.csv")).name.rsplit("_M5.csv", 1)[0]
    store = load_store_from_csv(DATA / "real", sym)
    _, a = run_backtest(store, StrategyConfig(), SessionEngine())
    _, b = run_backtest(store, StrategyConfig(), SessionEngine())
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    for s in a:
        if s.get("entry_time"):
            assert s["sweep"]["extreme_time"] <= s["mss"]["break_time"] <= s["entry_time"]


def test_signal_log_roundtrip(tmp_path):
    _, setups = run_backtest(make_store(sell_scenario()), StrategyConfig(), SessionEngine())
    db = SignalLog(tmp_path / "x.db")
    for s in setups:
        db.upsert(s)
        db.upsert(s)                      # idempotent
    rows = db.recent(100)
    assert len(rows) == len(setups)
    a = [r for r in rows if r["grade"] == "A+"][0]
    assert a["result"] == "WIN" and a["mfe_r"] > 0 and a["score_total"] > 0
    full = db.get(a["id"])
    assert full["score"]["liquidity"]["points"] == 20


# ------------------------------------------------------------------- server
@pytest.fixture
def client(tmp_path):
    cfg = AppConfig()
    cfg.server.db_path = str(tmp_path / "db.sqlite")
    app = create_app(cfg, mt5_module=None, config_path=tmp_path / "settings.json", start_loop=False)
    with TestClient(app) as c:
        yield c


def test_api_state_offline_without_mt5(client):
    st = client.get("/api/state").json()
    assert st["status"]["status"] in ("CONNECTING", "OFFLINE")
    assert st["tick"] == {}
    assert st["tz"][0][1] == 7200 or st["tz"][0][1] == 10800
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200


def test_api_settings_validation(client, tmp_path):
    assert client.put("/api/settings", json={"account": {"risk_percent": 50}}).status_code == 400
    assert client.put("/api/settings", json={"feed": {"server_timezone": "Mars/Base"}}).status_code == 400
    r = client.put("/api/settings", json={"account": {"risk_percent": 0.75}, "strategy": {"risk": {"min_rr": 3.5}}})
    assert r.status_code == 200
    assert r.json()["account"]["risk_percent"] == 0.75 and r.json()["strategy"]["risk"]["min_rr"] == 3.5
    saved = json.loads((tmp_path / "settings.json").read_text())
    assert saved["strategy"]["risk"]["min_rr"] == 3.5
    assert saved["strategy"]["displacement"]["min_body_atr"] == 1.2     # untouched keys preserved


def test_websocket_snapshot(client):
    with client.websocket_connect("/ws") as ws:
        first = ws.receive_json()
        assert first["type"] == "snapshot" and "strategy" in first
        second = ws.receive_json()
        assert second["type"] == "candles" and second["candles"] == []        # nothing invented offline
