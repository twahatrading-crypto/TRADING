"""FastAPI app: static dashboard + REST + WebSocket stream.

Run:  python -m xau            (see start.bat)
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import webbrowser
from pathlib import Path
from typing import Any, Optional

from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import ROOT, AppConfig, config_from_dict, load_config, save_config
from .live import LiveService, dumps
from .models import TIMEFRAMES
from .mt5_client import load_mt5_module
from .signal_log import SignalLog

FRONTEND = ROOT / "frontend"
log = logging.getLogger("xau.server")


class WSListener:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.tf = "M5"

    async def send(self, msg: dict) -> None:
        await self.ws.send_text(dumps(msg))


def create_app(cfg: Optional[AppConfig] = None, mt5_module: Any = "auto",
               config_path: Optional[Path] = None, start_loop: bool = True) -> FastAPI:
    cfg = cfg or load_config()
    module = load_mt5_module() if mt5_module == "auto" else mt5_module
    db_path = Path(cfg.server.db_path)
    if not db_path.is_absolute():
        db_path = ROOT / db_path
    signal_log = SignalLog(db_path)
    service = LiveService(cfg, module, log_db=signal_log)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(service.run_forever()) if start_loop else None
        try:
            yield
        finally:
            if task:
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task
            with contextlib.suppress(Exception):
                service.client.shutdown()
            signal_log.close()

    app = FastAPI(title="XAUUSD Strategy Dashboard", lifespan=lifespan)
    app.state.service = service
    app.state.signal_log = signal_log

    @app.get("/")
    async def index():
        return FileResponse(FRONTEND / "index.html", headers={"Cache-Control": "no-store"})

    @app.get("/api/state")
    async def state():
        return JSONResponse(service.full_state())

    @app.get("/api/candles")
    async def candles(tf: str = "M5", count: int = 1500):
        if tf not in TIMEFRAMES:
            raise HTTPException(400, "bad timeframe")
        return {"tf": tf, "candles": await service.chart_candles(tf, min(max(count, 10), 5000)),
                "status": service.status}

    @app.get("/api/audit")
    async def audit():
        return service.audit_json()

    @app.get("/api/signals")
    async def signals(limit: int = 100):
        return signal_log.recent(min(limit, 1000))

    @app.get("/api/signals/{setup_id}")
    async def signal(setup_id: str):
        s = signal_log.get(setup_id)
        if not s:
            raise HTTPException(404, "not found")
        return s

    @app.get("/api/settings")
    async def get_settings():
        return service.cfg.to_dict()

    @app.put("/api/settings")
    async def put_settings(body: dict = Body(...)):
        merged = _deep_merge(service.cfg.to_dict(), body)
        try:
            new_cfg = config_from_dict(merged)
            from .timeutil import ServerClock
            ServerClock(new_cfg.feed.server_timezone)       # validate
            if not (0 < float(new_cfg.account.risk_percent) <= 5):
                raise ValueError("risk_percent must be in (0, 5]")
            if new_cfg.strategy.entry.mode not in ("limit_ce", "limit_edge", "confirmation"):
                raise ValueError("entry.mode must be limit_ce | limit_edge | confirmation")
        except Exception as e:
            raise HTTPException(400, f"invalid settings: {e}")
        if config_path is not None:
            save_config(new_cfg, config_path)
        else:
            save_config(new_cfg)
        service.apply_config(new_cfg)
        await service.broadcast({"type": "snapshot", **service.full_state()})
        return new_cfg.to_dict()

    @app.get("/api/symbols")
    async def symbols():
        return {"current": service.symbol, "candidates": service.candidates,
                "override": service.cfg.feed.symbol_override}

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        await ws.accept()
        listener = WSListener(ws)
        service.listeners.add(listener)
        try:
            await listener.send({"type": "snapshot", **service.full_state()})
            await listener.send({"type": "candles", "tf": listener.tf,
                                 "candles": await service.chart_candles(listener.tf, service.cfg.feed.chart_bars)})
            while True:
                msg = await ws.receive_json()
                if msg.get("type") == "set_tf" and msg.get("tf") in TIMEFRAMES:
                    listener.tf = msg["tf"]
                    await listener.send({"type": "candles", "tf": listener.tf,
                                         "candles": await service.chart_candles(listener.tf, service.cfg.feed.chart_bars)})
        except WebSocketDisconnect:
            pass
        except Exception:
            log.debug("ws closed", exc_info=True)
        finally:
            service.listeners.discard(listener)

    app.mount("/static", StaticFiles(directory=FRONTEND), name="static")
    return app


def _deep_merge(base: dict, upd: dict) -> dict:
    out = dict(base)
    for k, v in upd.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def main() -> None:
    import uvicorn
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = load_config()
    mod = load_mt5_module()
    if mod is None:
        log.error("The 'MetaTrader5' Python package is not installed. Run: pip install MetaTrader5 "
                  "(Windows only). The dashboard will show MT5 OFFLINE.")
    app = create_app(cfg, mod)
    url = f"http://{cfg.server.host}:{cfg.server.port}/"
    if cfg.server.open_browser:
        import threading
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    log.info("Dashboard: %s", url)
    uvicorn.run(app, host=cfg.server.host, port=cfg.server.port, log_level="warning")


if __name__ == "__main__":
    main()
