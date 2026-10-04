"""Safety gates added for real-MT5 validation (test double + fixtures only)."""
import asyncio
import json

from xau.config import AppConfig
from xau.live import (LIVE, STALE, TZ_MISMATCH, TZ_REQUIRED, TZ_VERIFIED_HISTORY, TZ_VERIFIED_LIVE,
                      LiveService)
from xau.signal_log import SignalLog
from tests.helpers import ts
from tests.test_mt5_live import Clock, advance, fake_with_data


def svc_for(tmp_path, fake, wall, rule="NY+7", tz_file=None):
    cfg = AppConfig()
    cfg.feed.server_timezone = rule
    clk = Clock(wall)
    s = LiveService(cfg, fake, log_db=SignalLog(tmp_path / "s.db"), wall=lambda: clk.wall, mono=lambda: clk.mono)
    s.tz_file = tz_file or (tmp_path / "missing.json")
    return s, clk


def run(s):
    asyncio.run(s.run_once())


def test_wrong_timezone_rule_stops_signals(tmp_path):
    fake = fake_with_data()                      # fake broker really runs NY+7 (GMT+2 in January)
    t = ts("2025-01-15 08:12")
    fake.set_tick(t, 2650.0, 2650.25)
    s, clk = svc_for(tmp_path, fake, t + 1, rule="fixed:+3")   # user configured the wrong rule
    run(s)
    assert s.tz_state()[0] == TZ_REQUIRED                     # first tick disagrees: not accepted
    advance(fake, clk, ts("2025-01-15 08:13"))
    run(s)
    assert s.tz_state()[0] == TZ_MISMATCH
    assert s.engine.last_bar_time is None                      # nothing evaluated
    assert "TIMEZONE VERIFICATION REQUIRED" in s.strategy_payload()["paused_reason"]
    assert any("TIMEZONE VERIFICATION REQUIRED" in w for w in s.status_json()["warnings"])


def test_old_first_tick_cannot_verify_timezone(tmp_path):
    fake = fake_with_data()
    t = ts("2025-01-15 08:12")
    fake.set_tick(t, 2650.0, 2650.25)
    s, clk = svc_for(tmp_path, fake, t + 3 * 3600)             # tick is 3h old: offset can't be measured
    run(s)
    assert s.tz_state()[0] == TZ_REQUIRED and s.status != LIVE
    assert s.engine.last_bar_time is None


def test_tick_change_verifies_timezone(tmp_path):
    fake = fake_with_data()
    t = ts("2025-01-15 08:12")
    fake.set_tick(t, 2650.0, 2650.25)
    s, clk = svc_for(tmp_path, fake, t + 3 * 3600)
    run(s)
    advance(fake, clk, ts("2025-01-15 08:13"))
    run(s)
    assert s.tz_state()[0] == TZ_VERIFIED_LIVE and s.status == LIVE
    assert s.engine.last_bar_time == ts("2025-01-15 08:05")


def test_history_verification_file_requires_same_server_and_rule(tmp_path):
    fake = fake_with_data()
    t = ts("2025-01-15 08:12")
    fake.set_tick(t, 2650.0, 2650.25)
    f = tmp_path / "tz.json"
    f.write_text(json.dumps({"server": "TestBroker-Demo", "rule": "NY+7", "verdict": "VERIFIED"}))
    s, clk = svc_for(tmp_path, fake, t + 3 * 86400, tz_file=f)   # weekend-like: no fresh tick
    run(s)
    assert s.tz_state()[0] == TZ_VERIFIED_HISTORY
    f.write_text(json.dumps({"server": "OtherBroker-Live", "rule": "NY+7", "verdict": "VERIFIED"}))
    assert s.tz_state()[0] == TZ_REQUIRED


def test_audit_exactly_once_in_order_and_catch_up(tmp_path):
    fake = fake_with_data()
    t = ts("2025-01-15 08:12")
    fake.set_tick(t, 2650.0, 2650.25)
    s, clk = svc_for(tmp_path, fake, t + 1)
    run(s)
    n0 = s.audit_stats["processed"]
    assert n0 > 0 and s.audit_stats["duplicates"] == 0
    # stale for 3 bars, then resume: missed bars are caught up in one batch, in order
    clk.mono += 31
    fake.now_utc = ts("2025-01-15 08:27")
    clk.wall = fake.now_utc
    run(s)
    assert s.status == STALE and s.audit_stats["processed"] == n0
    advance(fake, clk, ts("2025-01-15 08:27"))
    clk.mono += 11
    run(s)
    a = s.audit_stats
    assert a["last_batch_after_pause"] and a["last_batch_size"] == 3
    assert a["duplicates"] == 0 and a["skipped_existing_bars"] == 0 and a["lookahead_violations"] == 0
    closes = [e["bar_close_utc"] for e in s.audit]
    assert closes == sorted(set(closes))
    assert all(e["bar_close_utc"] <= e["evaluated_at_tick_utc"] for e in s.audit)
    # polling again inside the same bar processes nothing new
    for _ in range(3):
        clk.mono += 0.6
        advance(fake, clk, fake.now_utc + 5)
        run(s)
    assert s.audit_stats["processed"] == a["processed"] and s.audit_stats["duplicates"] == 0


def test_login_not_exposed(tmp_path):
    fake = fake_with_data()
    t = ts("2025-01-15 08:12")
    fake.set_tick(t, 2650.0, 2650.25)
    s, clk = svc_for(tmp_path, fake, t + 1)
    run(s)
    blob = json.dumps(s.full_state())
    assert "1234" not in blob and '"login"' not in blob
    assert s.status_json()["account"]["server"] == "TestBroker-Demo"
