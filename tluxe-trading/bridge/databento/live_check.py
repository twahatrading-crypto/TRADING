"""REAL Databento live validation for GC and SI (run on YOUR machine; needs DATABENTO_API_KEY in .env or env).

    .venv\\Scripts\\python.exe live_check.py            (default 120 s)
    .venv\\Scripts\\python.exe live_check.py --seconds 300

It opens the same two sessions as the bridge (mbo snapshot + trades/ohlcv-1m replay), observes real records and
prints a PASS / FAIL / NOT OBSERVED checklist per instrument. The API key is never printed. Nothing is
fabricated: when the exchange is closed or quiet, items are reported as NOT OBSERVED.
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
            line = " | ".join(f"{r}: {i['status']} {i['contract'] or '?'} book={i['book']['state']} trades={seen[r]['trades']} mbo={seen[r]['mboLive']}" for r, i in h["instruments"].items())
            print(f"[{int(t_end - time.time()):>4}s left] {line}", flush=True)
    finally:
        mgr.stop()
    h = hub.health()
    sess = h["sessions"]
    results = {}
    ok_all = True
    for root, i in h["instruments"].items():
        s = seen[root]
        auth_ok = sess["book"]["state"] not in ("AUTH_ERROR",) and sess["book"]["connectedAtMs"] is not None
        st = hub.roots[root]
        checks = [
            ("1 authentication successful", auth_ok),
            ("2 dataset GLBX.MDP3", h["dataset"] == "GLBX.MDP3" and auth_ok),
            ("3 symbol mapping received", i["instrumentId"] is not None),
            ("4 actual contract resolved", bool(i["contract"])),
            ("5 MBO snapshot received", s["mboSnapshot"] > 0),
            ("6 snapshot reached valid state", st.book is not None and st.book.epoch > 0),
            ("7 incremental MBO events received", s["mboLive"] > 0),
            ("8 real trades received", s["trades"] > 0),
            ("9 timestamps moving", s["firstEventNs"] is not None and s["lastEventNs"] is not None and s["lastEventNs"] > s["firstEventNs"]),
            ("10 sequence / integrity diagnostics", i["book"]["counts"].get("outOfOrder", 0) == 0 and i["book"]["counts"].get("maybeBadBook", 0) == 0),
            ("11 heatmap input (book levels)", (i["book"]["bidLevels"] + i["book"]["askLevels"]) > 0 and i["book"]["state"] == VALID),
            ("12 footprint input (classified trades)", i["tape"]["counts"].get("accepted", 0) > 0),
            ("13 volume-profile input (ohlcv-1m bars)", i["candles"]["bars"] > 0),
        ]
        results[root] = {"contract": i["contract"], "instrumentId": i["instrumentId"], "status": i["status"], "checks": {k: v for k, v in checks},
                         "observed": s, "book": i["book"], "tape": i["tape"]["counts"], "volume": i["tape"]["volume"]}
        print(f"\n=== {root} -> actual contract {i['contract']} (instrument_id {i['instrumentId']}) · status {i['status']} ===")
        for name, ok in checks:
            label = "PASS" if ok else ("NOT OBSERVED" if name[0] in "5678912" and auth_ok else "FAIL")
            ok_all &= bool(ok)
            print(f"  {label:<13} {name}")
        print(f"  records: mbo snapshot {s['mboSnapshot']} · mbo live {s['mboLive']} · trades {s['trades']} · volume {i['tape']['volume']}")
    print("\nSessions:", json.dumps({k: {x: v[x] for x in ("state", "reconnects", "resyncs", "lastError")} for k, v in sess.items()}))
    if a.json:
        print(json.dumps(results, default=str))
    print("\nRESULT:", "ALL CHECKS PASSED (real Databento records observed)" if ok_all else "NOT ALL CHECKS PASSED - see above (market closed / quiet is reported as NOT OBSERVED, never faked)")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
