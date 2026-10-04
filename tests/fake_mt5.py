"""TEST DOUBLE for the MetaTrader5 package.

Used only by the automated tests (and the UI smoke-test harness) because the
real MetaTrader5 package needs a Windows terminal.  It mimics the API shape
(structured numpy arrays, server-time timestamps, None on failure).  It is
never imported by the application.
"""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np

from xau.timeutil import ServerClock

RATE_DTYPE = np.dtype([("time", "<i8"), ("open", "<f8"), ("high", "<f8"), ("low", "<f8"), ("close", "<f8"),
                       ("tick_volume", "<u8"), ("spread", "<i4"), ("real_volume", "<u8")])


class FakeMT5:
    TIMEFRAME_M1, TIMEFRAME_M5, TIMEFRAME_M15 = 1, 5, 15
    TIMEFRAME_H1, TIMEFRAME_H4, TIMEFRAME_D1 = 16385, 16388, 16408
    ACCOUNT_TRADE_MODE_DEMO, ACCOUNT_TRADE_MODE_CONTEST, ACCOUNT_TRADE_MODE_REAL = 0, 1, 2
    _TF = {1: "M1", 5: "M5", 15: "M15", 16385: "H1", 16388: "H4", 16408: "D1"}

    def __init__(self, bars_utc: dict, clock: ServerClock, symbols=("EURUSD", "XAUUSDm", "XAUEUR"),
                 gold_name="XAUUSDm"):
        self.bars_utc = bars_utc
        self.clock = clock
        self.symbols = list(symbols)
        self.gold = gold_name
        self.terminal_running = True
        self.broker_connected = True
        self.initialized = False
        self.now_utc = 0
        self.bid, self.ask = 0.0, 0.0
        self.tick_time_msc = 0
        self.calls: list[str] = []
        self.orders_sent = 0

    # --- trading function exists on the real module; our app must never reach it
    def order_send(self, *a, **k):
        self.orders_sent += 1
        raise AssertionError("order_send must never be called")

    def set_tick(self, utc: int, bid: float, ask: float, msc_extra: int = 0):
        self.now_utc = utc
        self.bid, self.ask = bid, ask
        self.tick_time_msc = self.clock.to_server(utc) * 1000 + msc_extra

    def initialize(self, **kw):
        self.calls.append("initialize")
        self.initialized = self.terminal_running
        return self.initialized

    def shutdown(self):
        self.initialized = False

    def last_error(self):
        return (-10003, "IPC initialize failed, MetaTrader 5 x64 not found") if not self.terminal_running else (1, "Success")

    def version(self):
        return (500, 4000, "fake")

    def _alive(self):
        return self.initialized and self.terminal_running

    def terminal_info(self):
        if not self._alive():
            return None
        return SimpleNamespace(connected=self.broker_connected, name="MetaTrader 5 (test double)",
                               company="Test Broker", build=4000, path="C:/fake", ping_last=25000)

    def account_info(self):
        if not self._alive():
            return None
        return SimpleNamespace(login=1234, server="TestBroker-Demo", company="Test Broker", currency="USD",
                               balance=10000.0, equity=10000.0, trade_mode=0)

    def symbols_get(self):
        return [SimpleNamespace(name=n) for n in self.symbols] if self._alive() else None

    def symbol_select(self, name, enable=True):
        return self._alive() and name in self.symbols

    def symbol_info(self, name):
        if not self._alive() or name not in self.symbols:
            return None
        return SimpleNamespace(name=name, description="Gold vs US Dollar", digits=2, point=0.01,
                               trade_tick_size=0.01, trade_tick_value=1.0, trade_tick_value_loss=1.0,
                               trade_contract_size=100.0, volume_min=0.01, volume_max=50.0, volume_step=0.01,
                               currency_profit="USD", currency_margin="USD", spread=20)

    def symbol_info_tick(self, name):
        if not self._alive() or name not in self.symbols or not self.tick_time_msc:
            return None
        return SimpleNamespace(time=self.tick_time_msc // 1000, bid=self.bid, ask=self.ask, last=0.0,
                               volume=0, time_msc=self.tick_time_msc, flags=6, volume_real=0.0)

    def _arr(self, bars):
        a = np.zeros(len(bars), dtype=RATE_DTYPE)
        for i, c in enumerate(bars):
            a[i] = (self.clock.to_server(c.time), c.open, c.high, c.low, c.close, c.tick_volume, c.spread, 0)
        return a

    def copy_rates_from_pos(self, name, tf, start, count):
        if not self._alive():
            return None
        if name != self.gold:
            return None
        tfn = self._TF[tf]
        bars = [c for c in self.bars_utc.get(tfn, []) if c.time <= self.now_utc]   # includes forming bar
        end = len(bars) - start
        return self._arr(bars[max(0, end - count):end])

    def copy_rates_range(self, name, tf, date_from, date_to):
        if not self._alive():
            return None
        tfn = self._TF[tf]
        a = self.clock.to_utc(int(date_from.timestamp()))
        b = self.clock.to_utc(int(date_to.timestamp()))
        return self._arr([c for c in self.bars_utc.get(tfn, []) if a <= c.time <= b])

