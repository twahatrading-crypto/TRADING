"""Read-only adapter around the official ``MetaTrader5`` Python package.

SAFETY: version 1 is ANALYSIS + SIGNALS ONLY.  The terminal module is wrapped
in :class:`ReadOnlyMT5`, which exposes an explicit whitelist of *read*
functions.  ``order_send``, ``order_check``, ``positions_*`` modification and
every other trading call are unreachable from this code base.  A unit test
also scans the source tree to prove ``order_send`` is never called.

All methods here are blocking and must be called from ONE thread (the
MetaTrader5 package is not thread-safe); the live service runs them on a
dedicated single-thread executor.
"""
from __future__ import annotations

import re
import time
from typing import Any, Optional

from .models import AccountInfo, Candle, SymbolSpec, Tick, TF_SECONDS
from .timeutil import ServerClock

_ALLOWED = frozenset({
    "initialize", "shutdown", "last_error", "version", "terminal_info", "account_info",
    "symbols_get", "symbols_total", "symbol_info", "symbol_info_tick", "symbol_select",
    "copy_rates_from_pos", "copy_rates_range", "copy_rates_from",
    "TIMEFRAME_M1", "TIMEFRAME_M5", "TIMEFRAME_M15", "TIMEFRAME_H1", "TIMEFRAME_H4", "TIMEFRAME_D1",
    "ACCOUNT_TRADE_MODE_DEMO", "ACCOUNT_TRADE_MODE_CONTEST", "ACCOUNT_TRADE_MODE_REAL",
})


class TradingCallBlocked(RuntimeError):
    pass


class ReadOnlyMT5:
    """Whitelist proxy: only read functions of the MetaTrader5 module are reachable."""

    def __init__(self, module: Any):
        object.__setattr__(self, "_m", module)

    def __getattr__(self, name: str):
        if name not in _ALLOWED:
            raise TradingCallBlocked(
                f"MetaTrader5.{name} is not available: this application is analysis-only "
                f"and never sends, modifies or closes orders/positions.")
        return getattr(object.__getattribute__(self, "_m"), name)

    def __setattr__(self, key, value):
        raise TradingCallBlocked("read-only")


def load_mt5_module() -> Optional[Any]:
    try:
        import MetaTrader5  # type: ignore
        return MetaTrader5
    except Exception:
        return None


_SEPARATOR_SUFFIX = re.compile(r"^[._#+\-!][A-Za-z0-9]{0,8}$")
_KNOWN_SUFFIXES = {"M", "PRO", "ECN", "RAW", "STD", "MICRO", "MINI", "I", "C", "X", "Z"}
_CURRENCIES = {"USD", "EUR", "GBP", "JPY", "AUD", "CHF", "CAD", "NZD", "CNH", "SGD", "HKD", "TRY", "ZAR", "MXN", "THB"}


def rank_symbols(names: list[str], bases: list[str]) -> list[str]:
    """Rank broker symbol names that represent spot gold vs USD.

    XAUUSD, XAUUSDm, XAUUSD.a, XAUUSD#, GOLD, GOLDm, GOLD.pro ... are accepted;
    XAUEUR, XAUUSDT, GOLDEUR, GOLDEN are rejected.  Exact names rank first.
    """
    ranked: list[tuple[int, int, str]] = []
    for n in names:
        u = n.upper()
        for pri, base in enumerate(b.upper() for b in bases):
            if not u.startswith(base):
                continue
            rest = n[len(base):]
            ru = rest.upper()
            if rest == "":
                score = 0
            elif _SEPARATOR_SUFFIX.match(rest):
                score = 1
            elif ru in _KNOWN_SUFFIXES or (rest.islower() and len(rest) <= 5):
                score = 2
            else:
                continue
            if ru.lstrip("._#+-!") in _CURRENCIES or ru == "T":
                continue
            ranked.append((pri, score, n))
            break
    ranked.sort(key=lambda x: (x[0], x[1], len(x[2]), x[2]))
    return [n for _, _, n in ranked]


class MT5Client:
    def __init__(self, module: Any, clock: ServerClock, terminal_path: str = ""):
        self.raw_module = module
        self.mt5 = ReadOnlyMT5(module) if module is not None else None
        self.clock = clock
        self.terminal_path = terminal_path
        self.connected = False
        self.last_error: str = ""

    # ------------------------------------------------------------ connection
    def connect(self) -> bool:
        if self.mt5 is None:
            self.last_error = "MetaTrader5 Python package not installed (pip install MetaTrader5; Windows only)"
            return False
        kwargs = {"path": self.terminal_path} if self.terminal_path else {}
        ok = self.mt5.initialize(**kwargs)
        if not ok:
            self.last_error = f"MT5 initialize() failed: {self.mt5.last_error()} – is the MetaTrader 5 terminal running and logged in?"
            self.connected = False
            return False
        self.connected = True
        self.last_error = ""
        return True

    def shutdown(self) -> None:
        try:
            if self.mt5 is not None:
                self.mt5.shutdown()
        finally:
            self.connected = False

    def terminal_state(self) -> dict:
        ti = self.mt5.terminal_info()
        if ti is None:
            raise ConnectionError(f"terminal_info() returned None: {self.mt5.last_error()}")
        return {"connected": bool(getattr(ti, "connected", False)),
                "name": getattr(ti, "name", ""), "company": getattr(ti, "company", ""),
                "build": getattr(ti, "build", 0), "path": getattr(ti, "path", ""),
                "ping_ms": round(getattr(ti, "ping_last", 0) / 1000.0, 1)}

    def account(self) -> Optional[AccountInfo]:
        ai = self.mt5.account_info()
        if ai is None:
            return None
        modes = {getattr(self.raw_module, "ACCOUNT_TRADE_MODE_DEMO", 0): "DEMO",
                 getattr(self.raw_module, "ACCOUNT_TRADE_MODE_CONTEST", 1): "CONTEST",
                 getattr(self.raw_module, "ACCOUNT_TRADE_MODE_REAL", 2): "REAL"}
        return AccountInfo(login=ai.login, server=ai.server, company=getattr(ai, "company", ""),
                           currency=ai.currency, balance=float(ai.balance), equity=float(ai.equity),
                           trade_mode=modes.get(getattr(ai, "trade_mode", -1), "UNKNOWN"))

    # --------------------------------------------------------------- symbols
    def all_symbol_names(self) -> list[str]:
        syms = self.mt5.symbols_get()
        return [s.name for s in syms] if syms else []

    def detect_symbol(self, bases: list[str]) -> tuple[Optional[str], list[str]]:
        cands = rank_symbols(self.all_symbol_names(), bases)
        for name in cands:
            if not self.mt5.symbol_select(name, True):
                continue
            info = self.mt5.symbol_info(name)
            if info is None:
                continue
            if self.mt5.symbol_info_tick(name) is None:
                continue
            return name, cands
        return None, cands

    def select(self, name: str) -> bool:
        return bool(self.mt5.symbol_select(name, True)) and self.mt5.symbol_info(name) is not None

    def spec(self, name: str) -> Optional[SymbolSpec]:
        si = self.mt5.symbol_info(name)
        if si is None:
            return None
        return SymbolSpec(
            name=si.name, description=getattr(si, "description", ""), digits=si.digits, point=si.point,
            tick_size=getattr(si, "trade_tick_size", 0.0) or si.point,
            tick_value=getattr(si, "trade_tick_value", 0.0),
            tick_value_loss=getattr(si, "trade_tick_value_loss", 0.0),
            contract_size=getattr(si, "trade_contract_size", 0.0),
            volume_min=si.volume_min, volume_max=si.volume_max, volume_step=si.volume_step,
            currency_profit=getattr(si, "currency_profit", ""),
            currency_margin=getattr(si, "currency_margin", ""),
            spread_points=getattr(si, "spread", 0))

    # ------------------------------------------------------------ market data
    def tick(self, name: str) -> Optional[tuple[Tick, int]]:
        """Returns (Tick in UTC, raw server time seconds) or None."""
        t = self.mt5.symbol_info_tick(name)
        if t is None or not getattr(t, "time", 0):
            return None
        raw = int(t.time)
        utc = self.clock.to_utc(raw)
        msc = int(getattr(t, "time_msc", raw * 1000))
        utc_msc = msc - (raw - utc) * 1000
        return Tick(time=utc, time_msc=utc_msc, bid=float(t.bid), ask=float(t.ask),
                    last=float(getattr(t, "last", 0.0) or 0.0), volume=float(getattr(t, "volume", 0) or 0)), raw

    def tf_const(self, tf: str):
        return getattr(self.mt5, f"TIMEFRAME_{tf}")

    def _convert(self, rates) -> list[Candle]:
        out = []
        if rates is None:
            return out
        for r in rates:
            out.append(Candle(self.clock.to_utc(int(r["time"])), float(r["open"]), float(r["high"]),
                              float(r["low"]), float(r["close"]), int(r["tick_volume"]),
                              int(r["spread"]), int(r["real_volume"])))
        return out

    def rates(self, name: str, tf: str, count: int) -> list[Candle]:
        r = self.mt5.copy_rates_from_pos(name, self.tf_const(tf), 0, int(count))
        if r is None:
            raise ConnectionError(f"copy_rates_from_pos({name},{tf}) failed: {self.mt5.last_error()}")
        return self._convert(r)

    def rates_range(self, name: str, tf: str, utc_from: int, utc_to: int) -> list[Candle]:
        """Historical candles for backtests.  MT5 interprets the datetimes in
        server time, so the request is widened and filtered after conversion."""
        from datetime import datetime, timezone
        pad = 2 * 86400
        a = datetime.fromtimestamp(self.clock.to_server(utc_from) - pad, timezone.utc)
        b = datetime.fromtimestamp(self.clock.to_server(utc_to) + pad, timezone.utc)
        r = self.mt5.copy_rates_range(name, self.tf_const(tf), a, b)
        if r is None:
            raise ConnectionError(f"copy_rates_range({name},{tf}) failed: {self.mt5.last_error()}")
        return [c for c in self._convert(r) if utc_from <= c.time <= utc_to]


def now() -> float:
    return time.time()


__all__ = ["MT5Client", "ReadOnlyMT5", "TradingCallBlocked", "rank_symbols", "load_mt5_module", "TF_SECONDS"]
