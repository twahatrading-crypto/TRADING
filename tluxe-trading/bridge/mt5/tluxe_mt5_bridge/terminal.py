"""Thread-safe wrapper around the MetaTrader5 package (read-only usage)."""
from __future__ import annotations

import importlib
import logging
import threading
import time
from typing import Any

from .config import BridgeConfig, mask_login
from .timeutil import TimeBasis, detect_offset, server_to_utc

log = logging.getLogger("tluxe.mt5")

TIMEFRAMES = {"M1": ("TIMEFRAME_M1", 60), "M5": ("TIMEFRAME_M5", 300), "M15": ("TIMEFRAME_M15", 900),
              "M30": ("TIMEFRAME_M30", 1800), "H1": ("TIMEFRAME_H1", 3600), "H4": ("TIMEFRAME_H4", 14400),
              "D1": ("TIMEFRAME_D1", 86400)}
TRADE_MODES = {0: "demo", 1: "contest", 2: "real"}
CHUNK = 5000
DETECT_EVERY = 600
PROBE_SYMBOLS = ("EURUSD", "GBPUSD", "XAUUSD", "USDJPY")


class BridgeError(Exception):
    def __init__(self, code: str, message: str, status: int = 503):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class Terminal:
    """Owns the MT5 session. All MT5 calls are serialised (the package is not thread-safe)."""

    def __init__(self, cfg: BridgeConfig, mt5_module: Any | None = None):
        self.cfg = cfg
        self._mt5 = mt5_module
        self._lock = threading.RLock()
        self.state = "INITIALIZING"  # INITIALIZING | CONNECTED | NOT_RUNNING | DISCONNECTED
        self.last_error: dict | None = None
        self.basis = TimeBasis("iana", cfg.server_timezone) if cfg.server_timezone else TimeBasis("unresolved")
        self._backoff = 1.0
        self._next_attempt = 0.0

    # ------------------------------------------------------------------ session
    @property
    def mt5(self) -> Any:
        if self._mt5 is None:
            try:
                self._mt5 = importlib.import_module("MetaTrader5")
            except ImportError as exc:  # not Windows / package missing
                raise BridgeError("MT5_PACKAGE_MISSING", "The MetaTrader5 Python package is not installed (Windows only).") from exc
        return self._mt5

    def ensure(self) -> None:
        """Initialise / re-initialise with exponential backoff. Never raises."""
        with self._lock:
            try:
                if self.state == "CONNECTED":
                    info = self.mt5.terminal_info()
                    if info is not None:
                        self.state = "CONNECTED" if info.connected else "DISCONNECTED"
                        self._maybe_detect()
                        return
                    log.warning("MT5 terminal went away; re-initialising")
                    self.mt5.shutdown()
                    self.state = "NOT_RUNNING"
                if time.time() < self._next_attempt:
                    return
                kwargs: dict[str, Any] = {}
                if self.cfg.terminal_path:
                    kwargs["path"] = self.cfg.terminal_path
                if self.cfg.login is not None:
                    kwargs.update(login=self.cfg.login, password=self.cfg.password or "", server=self.cfg.server or "")
                ok = self.mt5.initialize(**kwargs)
                if not ok:
                    code, msg = self.mt5.last_error()
                    self.state = "NOT_RUNNING"
                    self.last_error = {"code": "MT5_NOT_RUNNING", "message": f"initialize() failed: {code} {msg}"}
                    log.warning("Cannot attach to MT5 terminal (%s %s); retrying in %.0fs", code, msg, self._backoff)
                    self._next_attempt = time.time() + self._backoff
                    self._backoff = min(self._backoff * 2, 30.0)
                    return
                info = self.mt5.terminal_info()
                self.state = "CONNECTED" if info is not None and info.connected else "DISCONNECTED"
                self.last_error = None
                self._backoff = 1.0
                acc = self.mt5.account_info()
                log.info("MT5 initialised: build=%s server=%s login=%s", getattr(info, "build", "?"),
                         getattr(acc, "server", "?"), mask_login(getattr(acc, "login", "")))
                self._maybe_detect(force=True)
            except BridgeError as exc:
                self.state = "NOT_RUNNING"
                self.last_error = {"code": exc.code, "message": exc.message}
            except Exception as exc:  # pragma: no cover - defensive
                self.state = "NOT_RUNNING"
                self.last_error = {"code": "ERROR", "message": str(exc)}

    def _maybe_detect(self, force: bool = False) -> None:
        if self.basis.method == "iana":
            return
        if not force and self.basis.detected_at and time.time() - self.basis.detected_at < DETECT_EVERY:
            return
        for name in PROBE_SYMBOLS:
            self.mt5.symbol_select(name, True)
            tick = self.mt5.symbol_info_tick(name)
            if tick is None:
                continue
            off = detect_offset(int(tick.time))
            if off is not None:
                self.basis = TimeBasis("detected", None, off, time.time())
                return

    def require(self) -> None:
        self.ensure()
        if self.state != "CONNECTED":
            code = "MT5_NOT_RUNNING" if self.state in ("NOT_RUNNING", "INITIALIZING") else "MT5_DISCONNECTED"
            raise BridgeError(code, (self.last_error or {}).get("message", f"MT5 terminal {self.state.lower()}"))

    # --------------------------------------------------------------- endpoints
    def health(self) -> dict:
        self.ensure()
        with self._lock:
            out: dict[str, Any] = {"terminal": {"state": self.state}, "account": None, "time": self.basis.as_dict(),
                                   "error": self.last_error}
            if self.state in ("CONNECTED", "DISCONNECTED"):
                info = self.mt5.terminal_info()
                acc = self.mt5.account_info()
                if info is not None:
                    out["terminal"].update(build=info.build, company=info.company, name=info.name,
                                           connected=bool(info.connected), tradeAllowed=bool(info.trade_allowed))
                if acc is not None:
                    out["account"] = {"server": acc.server, "company": acc.company, "loginMasked": mask_login(acc.login),
                                      "tradeMode": TRADE_MODES.get(acc.trade_mode, "unknown"), "currency": acc.currency}
            return out

    def symbols(self) -> list[dict]:
        self.require()
        with self._lock:
            rows = self.mt5.symbols_get() or ()
            return [self._symbol_dict(s) for s in rows]

    def symbol(self, name: str) -> dict:
        self.require()
        with self._lock:
            info = self.mt5.symbol_info(name)
            if info is None:
                raise BridgeError("SYMBOL_NOT_FOUND", f"Symbol {name!r} not found on this terminal", 404)
            return self._symbol_dict(info)

    @staticmethod
    def _symbol_dict(s: Any) -> dict:
        return {"name": s.name, "description": s.description, "path": s.path, "digits": s.digits, "point": s.point,
                "tickSize": s.trade_tick_size, "contractSize": s.trade_contract_size,
                "currencyBase": s.currency_base, "currencyProfit": s.currency_profit,
                "tradeMode": s.trade_mode, "visible": bool(s.visible), "spreadFloat": bool(s.spread_float)}

    def quote(self, name: str) -> dict:
        self.require()
        with self._lock:
            if not self.mt5.symbol_select(name, True):
                raise BridgeError("SYMBOL_NOT_FOUND", f"Symbol {name!r} not found on this terminal", 404)
            info = self.mt5.symbol_info(name)
            tick = self.mt5.symbol_info_tick(name)
            if tick is None or info is None:
                raise BridgeError("NO_QUOTE", f"No quote available for {name!r}", 404)
            src_ms = int(tick.time_msc) if getattr(tick, "time_msc", 0) else int(tick.time) * 1000
            utc = server_to_utc(src_ms // 1000, self.basis)
            bid = float(tick.bid) or None
            ask = float(tick.ask) or None
            return {"symbol": name, "bid": bid, "ask": ask, "last": float(tick.last) or None,
                    "spreadPoints": round((ask - bid) / info.point) if bid and ask and info.point else None,
                    "sourceTimeMs": src_ms, "timeUtcMs": None if utc is None else utc * 1000 + src_ms % 1000,
                    "timeBasis": self.basis.method, "digits": info.digits}

    def rates(self, name: str, tf: str, count: int, now_utc: float | None = None) -> dict:
        if tf not in TIMEFRAMES:
            raise BridgeError("BAD_TIMEFRAME", f"Unsupported timeframe {tf!r}", 400)
        count = max(1, min(int(count), self.cfg.max_bars))
        self.require()
        const, tf_sec = TIMEFRAMES[tf]
        with self._lock:
            if not self.mt5.symbol_select(name, True):
                raise BridgeError("SYMBOL_NOT_FOUND", f"Symbol {name!r} not found on this terminal", 404)
            chunks: list[Any] = []
            got = 0
            while got < count:
                n = min(CHUNK, count - got)
                arr = self.mt5.copy_rates_from_pos(name, getattr(self.mt5, const), got, n)
                if arr is None or len(arr) == 0:
                    break
                chunks.append(arr)
                got += len(arr)
                if len(arr) < n:
                    break  # broker/terminal history limit reached
            rows = [r for chunk in reversed(chunks) for r in chunk]  # oldest first
        if self.basis.method == "unresolved":
            raise BridgeError("TIMEZONE_UNRESOLVED", "Broker server timezone unknown: set TLUXE_MT5_SERVER_TIMEZONE "
                              "(IANA name, e.g. Europe/Athens) so candle times can be converted to UTC.", 503)
        now = time.time() if now_utc is None else now_utc
        bars = []
        for i, r in enumerate(rows):
            st = int(r["time"])
            utc = server_to_utc(st, self.basis)
            rv = int(r["real_volume"])
            last = i == len(rows) - 1
            bars.append({"t": utc, "st": st, "o": float(r["open"]), "h": float(r["high"]), "l": float(r["low"]),
                         "c": float(r["close"]), "tv": int(r["tick_volume"]), "rv": rv if rv > 0 else None,
                         "sp": int(r["spread"]), "closed": (not last) or now >= utc + tf_sec})
        return {"symbol": name, "timeframe": tf, "timeBasis": self.basis.as_dict(), "requested": count,
                "returned": len(bars), "historyLimited": len(bars) < count,
                "realVolumeAvailable": any(b["rv"] is not None for b in bars), "bars": bars}
