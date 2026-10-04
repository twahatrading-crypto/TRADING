"""DEVELOPER UI SMOKE-TEST HARNESS – NOT PART OF THE APPLICATION.

Serves the real dashboard against the MetaTrader5 *test double* with the
hand-built rule-test scenario, so the UI can be rendered and screenshotted on
a machine without MetaTrader 5 (e.g. CI / Linux).  The app itself only ever
talks to the real MT5 terminal (see xau/server.py).

    python -m tests.ui_harness --at "2025-01-15 08:40" --port 8799
"""
from __future__ import annotations

import argparse
import threading
import time
import tempfile
from pathlib import Path

import uvicorn

from xau.config import AppConfig
from xau.server import create_app
from tests.helpers import ts
from tests.scenarios import sell_scenario
from tests.test_mt5_live import fake_with_data


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--at", default="2025-01-15 08:40")
    ap.add_argument("--port", type=int, default=8799)
    a = ap.parse_args()
    fake = fake_with_data(sell_scenario())
    t = ts(a.at)
    cur = [c for c in fake.bars_utc["M5"] if c.time <= t][-1]
    fake.set_tick(t, cur.close, cur.close + 0.25)
    cfg = AppConfig()
    tmp = Path(tempfile.mkdtemp())
    cfg.server.db_path = str(tmp / "ui.db")
    cfg.server.port = a.port
    app = create_app(cfg, mt5_module=fake, config_path=tmp / "settings.json")
    svc = app.state.service
    svc.wall = lambda: fake.now_utc + 0.5

    def ticker():
        k = 0
        while True:
            k += 1
            c = [x for x in fake.bars_utc["M5"] if x.time <= fake.now_utc][-1]
            bid = round(c.low + (c.high - c.low) * ((k % 10) / 10), 2)
            fake.set_tick(fake.now_utc, bid, bid + 0.25, msc_extra=k % 1000)
            time.sleep(0.4)

    threading.Thread(target=ticker, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
