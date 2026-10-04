"""The real-MT5 validation tool, exercised against the MT5 TEST DOUBLE.
Everything it produces here must be labelled TEST/SYNTHETIC and must never tick
a completion-gate item."""
import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from xau import validate as V
from xau.config import AppConfig
from xau.timeutil import ServerClock
from tests.helpers import ts
from tests.test_mt5_live import fake_with_data


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(V, "EVIDENCE", tmp_path / "validation")
    monkeypatch.setattr(V, "BASELINE_DIR", tmp_path / "baseline")
    monkeypatch.setattr(V, "REPORT", tmp_path / "real-mt5-validation.md")
    monkeypatch.setattr(V, "TZ_FILE", tmp_path / "tz.json")
    monkeypatch.setattr(V, "sntp_offset", lambda *a, **k: None)
    monkeypatch.setattr(V, "http_json", lambda *a, **k: None)      # no dashboard running
    fake = fake_with_data()
    fake.set_tick(ts("2025-01-15 09:31"), 2649.0, 2649.25)
    return fake, AppConfig(), tmp_path


def test_preflight_records_spec_without_login(env):
    fake, cfg, tmp = env
    out = V.phase_preflight(cfg, fake)
    assert out["real_mt5"] is False and out["data_source"].startswith("TEST/SYNTHETIC")
    assert out["symbol"]["detected"] == "XAUUSDm"
    assert out["broker_spec_raw"]["trade_contract_size"] == 100.0 and out["spec_consistency"] == "OK"
    assert out["position_size_example"]["volume"] == pytest.approx(0.16)
    assert "1234" not in json.dumps(out) and "balance" not in out["account"]


def test_timezone_without_live_ticks_is_not_verified(env):
    fake, cfg, tmp = env
    out = V.phase_timezone(cfg, fake, seconds=0.3, sleep=lambda s: None)
    assert out["verdict"] == "NOT VERIFIED" and not (tmp / "tz.json").exists()
    assert "Asian" in out["session_boundaries_last_completed"]


def _weekly_h1(rule_true: str, weeks: int = 70):
    """H1 raw rows of a broker whose weekly open is Sunday 18:00 New York."""
    clk, ny = ServerClock(rule_true), ZoneInfo("America/New_York")
    rows = []
    sun = datetime(2023, 1, 1, 18, 0, tzinfo=ny)
    for w in range(weeks):
        open_ny = (sun + timedelta(weeks=w)).replace(hour=18)
        close_ny = open_ny + timedelta(days=4, hours=22)
        u0 = int(open_ny.astimezone(timezone.utc).timestamp())
        u1 = int(close_ny.astimezone(timezone.utc).timestamp())
        for u in range(u0, u1, 3600):                       # hourly bars through the week
            rows.append({"time": clk.to_server(u), "open": 1, "high": 1, "low": 1, "close": 1})
    return rows


def test_weekly_open_history_identifies_dst_convention():
    r = V.weekly_open_analysis(_weekly_h1("NY+7"))
    assert r["per_rule"]["NY+7"]["consistency"] == 1.0
    assert r["per_rule"]["Europe/Athens"]["consistency"] < 0.97
    assert r["dst_discriminating_weeks"]


def test_ohlc_and_levels_and_statemachine(env):
    fake, cfg, tmp = env
    o = V.phase_ohlc(cfg, fake)
    assert all(v["verified"] for v in o["timeframes"].values())
    lv = V.phase_levels(cfg, fake)
    got = {r["level"]: r for r in lv["levels"]}
    assert got["PDH"]["pass"] and got["PDL"]["pass"] and got["Asia High"]["pass"] and got["Asia Low"]["pass"]
    assert lv["swings_agree"]
    sm = V.phase_statemachine(cfg, fake, days=3)
    assert sm["setups_total"] > 0 and sm["paths_seen"]["full_chain_to_entry"]
    assert any("INVALIDATED" in k or "EXPIRED" in k for k in sm["paths"])


def test_report_never_ticks_gate_from_synthetic_evidence(env):
    fake, cfg, tmp = env
    V.phase_preflight(cfg, fake)
    V.phase_ohlc(cfg, fake)
    V.save("tests", {"returncode": 0, "summary": "93 passed, 1 skipped", "git_commit": "x",
                     "platform": "Linux", "real_mt5_history_replay_test": "skipped"})
    md = V.phase_report(cfg)
    assert "- [x] Real MT5 connection" not in md and "- [x] M5 verified" not in md
    assert "TEST/SYNTHETIC DATA" in md and "Phase NOT complete" in md


def test_baseline_refuses_to_overwrite_frozen(env):
    fake, cfg, tmp = env
    (tmp / "baseline").mkdir()
    (tmp / "baseline" / "BASELINE.json").write_text("{}")
    with pytest.raises(SystemExit, match="FROZEN"):
        V.phase_baseline(cfg, fake)
