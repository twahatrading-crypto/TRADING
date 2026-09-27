"""REAL Databento live validation for GC and SI (run on YOUR machine; needs DATABENTO_API_KEY in .env or env).

    .venv\\Scripts\\python.exe live_check.py            (default 120 s)
    .venv\\Scripts\\python.exe live_check.py --seconds 300

It opens exactly the sessions the bridge opens for the configured plan (TLUXE_DB_PLAN, default `standard`:
trades + ohlcv-1m only - mbo / mbp-10 are never requested), observes real records and prints a
PASS / FAIL / NOT OBSERVED checklist per instrument. On Standard, depth is reported as
"NOT ENTITLED - EXPECTED FOR STANDARD", never as a failure. The API key is never printed. Nothing is fabricated:
when the exchange is closed or quiet, data items are reported as NOT OBSERVED.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from tluxe_databento_bridge.book import VALID  # noqa: E402
from tluxe_databento_bridge.config import ConfigError, from_env, load_dotenv  # noqa: E402
from tluxe_databento_bridge.manager import Manager  # noqa: E402
from tluxe_databento_bridge.redact import Redactor, install_log_redaction  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=120)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    load_dotenv(HERE / ".env")
    install_log_redaction(Redactor(os.environ.get("DATABENTO_API_KEY", ""), os.environ.get("TLUXE_DB_BRIDGE_TOKEN", "")))
    env = dict(os.environ)
    env.setdefault("TLUXE_DB_BRIDGE_TOKEN", "live-check-only-" + "x" * 32)  # no HTTP server is started here
    try:
        cfg = from_env(env)
    except ConfigError as exc:
        print(f"FAIL  configuration: {exc}")
        return 2
    mgr = Manager(cfg)
    hub = mgr.hub
    first_event: dict = {}
    seen = {root: {"mboLive": 0, "mboSnapshot": 0, "trades": 0, "firstEventNs": None, "lastEventNs": None} for root in hub.roots}
    orig = hub.on_record

    def spy(session, r, recv_ms=None):
        orig(session, r, recv_ms)
        kind = type(r).__name__
        iid = getattr(r, "instrument_id", None)
        root = hub.symmap.root_of(int(iid)) if iid is not None else None
        if root and kind in ("MBOMsg", "TradeMsg"):
            s = seen[root]
            if kind == "MBOMsg":
                s["mboSnapshot" if int(r.flags or 0) & 32 else "mboLive"] += 1
            else:
                s["trades"] += 1
            s["firstEventNs"] = s["firstEventNs"] or int(r.ts_event)
            s["lastEventNs"] = int(r.ts_event)

    hub.on_record = spy  # type: ignore[method-assign]
    mgr.start()
    t_end = time.time() + a.seconds
    try:
        while time.time() < t_end:
            time.sleep(5)
            h = hub.health()
            line = " | ".join(f"{r}: {i['status']} {i['contract'] or '?'} trades={seen[r]['trades']} bars={i['candles']['bars']} depth={i['capabilities']['depth']}" for r, i in h["instruments"].items())
            print(f"[{int(t_end - time.time()):>4}s left] {line}", flush=True)
    finally:
        mgr.stop()
    h = hub.health()
    sess = h["sessions"]
    tape_s = sess["tape"]
    results = {}
    ok_all = True
    authenticated = tape_s["connectedAtMs"] is not None and tape_s["state"] != "AUTH_ERROR"
    print(f"\nPlan mode: {cfg.plan} · dataset {h['dataset']} · requested schemas {h['schemas']['requested']}")
    rp = h["replay"]
    fmt = lambda ns: "-" if ns is None else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ns / 1e9))  # noqa: E731
    print(f"Replay start requested: {fmt(rp['requestedStartNs'])} · gateway floor {fmt(rp['floorNs'])} · margin {rp['marginMin']} min"
          f" · live-only {rp['liveOnly']}{' (' + rp['liveOnlyReason'] + ')' if rp['liveOnly'] else ''} · local clock {fmt(time.time_ns())}")
    for root, i in h["instruments"].items():
        s = seen[root]
        caps = i["capabilities"]
        st = hub.roots[root]
        # (name, outcome) outcome: True = PASS, False = FAIL, None = NOT OBSERVED, str = informational verdict
        checks: list[tuple[str, object]] = [
            ("Authentication", authenticated),
            ("Dataset connection (GLBX.MDP3)", authenticated and h["dataset"] == "GLBX.MDP3"),
            ("Symbol mapping", True if i["instrumentId"] is not None else (None if authenticated else False)),
            ("Actual contract", True if i["contract"] else (None if authenticated else False)),
            ("Trades", True if s["trades"] > 0 else "NOT ENTITLED" if caps["trades"] == "NOT_ENTITLED" else (None if authenticated else False)),
            ("OHLCV (ohlcv-1m)", True if i["candles"]["bars"] > 0 else "NOT ENTITLED" if caps["ohlcv"] == "NOT_ENTITLED" else (None if authenticated else False)),
            ("Volume (real exchange volume)", True if (i["candles"]["bars"] > 0 or sum(i["tape"]["volume"].values()) > 0) else (None if authenticated else False)),
            ("Timestamps moving", True if (s["firstEventNs"] is not None and s["lastEventNs"] and s["lastEventNs"] > s["firstEventNs"]) else (None if authenticated else False)),
        ]
        if cfg.depth_plan and caps["mbo"] != "NOT_ENTITLED":
            checks += [
                ("Depth: MBO snapshot received", True if s["mboSnapshot"] > 0 else None),
                ("Depth: book valid", True if (st.book is not None and st.book.epoch > 0 and i["book"]["state"] == VALID) else None),
                ("Depth: incremental MBO", True if s["mboLive"] > 0 else None),
            ]
        elif cfg.depth_plan:
            checks.append(("Depth entitlement", "NOT ENTITLED - your plan does not include real-time MBO (depth unavailable)"))
        else:
            checks.append(("Depth entitlement", "NOT ENTITLED - EXPECTED FOR STANDARD (mbo / mbp-10 never requested)"))
        results[root] = {"contract": i["contract"], "instrumentId": i["instrumentId"], "status": i["status"], "capabilities": caps,
                         "checks": {k: v for k, v in checks}, "observed": s, "tape": i["tape"]["counts"], "volume": i["tape"]["volume"]}
        print(f"\n=== {root} -> actual contract {i['contract']} (instrument_id {i['instrumentId']}) · subscribed {i['subscribed']} · status {i['status']} ===")
        for name, outcome in checks:
            label = "PASS" if outcome is True else "FAIL" if outcome is False else "NOT OBSERVED" if outcome is None else "INFO"
            ok_all &= outcome is not False
            print(f"  {label:<13} {name}{'' if isinstance(outcome, (bool, type(None))) else ': ' + str(outcome)}")
        print(f"  capabilities: trades {caps['trades']} · ohlcv {caps['ohlcv']} · volume {caps['volume']} · depth {caps['depth']} · MBO {caps['mbo']} · MBP-10 {caps['mbp10']}")
        print(f"  records: trades {s['trades']} · ohlcv bars {i['candles']['bars']} · volume {i['tape']['volume']}")
    print("\nSessions:", json.dumps({k: {x: v[x] for x in ("state", "reconnects", "resyncs", "lastError")} for k, v in sess.items()}))
    if a.json:
        print(json.dumps(results, default=str))
    print("\nRESULT:", "NO FAILURES (PASS items = real Databento records observed; NOT OBSERVED = market closed / quiet, never faked)" if ok_all else "FAILURES - see above")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
