"""Pre-flight checks run by start.bat:  python -m xau.doctor

Exit code 0 = OK (or only warnings), 2 = a hard problem (missing dependency).
A closed MT5 terminal is only a warning: the dashboard starts anyway, shows
MT5 OFFLINE and keeps retrying until the terminal is running.
"""
from __future__ import annotations

import importlib
import platform
import struct
import sys


def main() -> int:
    ok = True
    print(f"Python {platform.python_version()} ({struct.calcsize('P') * 8}-bit) on {platform.system()}")
    if sys.version_info < (3, 10):
        print("[ERROR] Python 3.10 or newer is required.")
        return 2
    if struct.calcsize("P") * 8 != 64:
        print("[ERROR] 64-bit Python is required by the MetaTrader5 package.")
        return 2
    for mod, pipname in (("fastapi", "fastapi"), ("uvicorn", "uvicorn[standard]"), ("numpy", "numpy"),
                         ("tzdata", "tzdata"), ("websockets", "websockets")):
        try:
            importlib.import_module(mod)
        except Exception:
            print(f"[ERROR] missing Python package '{pipname}'. Run: pip install -r requirements.txt")
            ok = False
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo("America/New_York"); ZoneInfo("Europe/London"); ZoneInfo("Asia/Tokyo")
    except Exception as e:
        print(f"[ERROR] time-zone database unavailable ({e}). Run: pip install tzdata")
        ok = False
    if not ok:
        return 2

    from .config import load_config
    from .mt5_client import MT5Client, load_mt5_module
    from .timeutil import ServerClock
    cfg = load_config()
    mod = load_mt5_module()
    if mod is None:
        print("[ERROR] the 'MetaTrader5' package is not installed (Windows only): pip install MetaTrader5")
        return 2
    client = MT5Client(mod, ServerClock(cfg.feed.server_timezone), cfg.feed.terminal_path)
    if not client.connect():
        print(f"[WARNING] {client.last_error}")
        print("          Start MetaTrader 5, log in to your broker, then the dashboard connects automatically.")
        return 0
    try:
        ti = client.terminal_state()
        acc = client.account()
        print(f"MT5 terminal: {ti['name']} build {ti['build']} - broker connection: {'OK' if ti['connected'] else 'NOT CONNECTED'}")
        if acc:
            print(f"Account: {acc.server} ({acc.trade_mode}, {acc.currency})  [login not shown]")
        sym = cfg.feed.symbol_override or client.detect_symbol(cfg.feed.symbol_candidates)[0]
        if sym:
            spec = client.spec(sym)
            print(f"Symbol: {sym}  digits={spec.digits} point={spec.point} contract={spec.contract_size} "
                  f"tick_value={spec.tick_value} vol {spec.volume_min}-{spec.volume_max} step {spec.volume_step}")
        else:
            print("[WARNING] no XAUUSD/GOLD symbol detected - choose it in Settings.")
    finally:
        client.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
