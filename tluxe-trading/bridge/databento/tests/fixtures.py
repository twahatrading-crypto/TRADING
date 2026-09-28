"""TEST DATA ONLY - genuine databento_dbn record objects built by hand for deterministic tests.

Nothing here is used by the running bridge; there is no configuration switch that could enable it.
"""
from __future__ import annotations

import threading

import databento_dbn as dbn

from tluxe_databento_bridge.config import Secret, from_env

KEY = "db-TESTKEYabcdefghijklmnopqrstuvwxyz0123"
TOKEN = "t" * 40
T0 = 1_790_000_000_000_000_000  # ns
GC_ID, SI_ID, GC2_ID = 42001, 42002, 42003
A, S = dbn.Action, dbn.Side
P = 1_000_000_000  # price scale


def cfg(**over):
    # Historical downloads are OFF unless a test enables them with a scripted client (never a network call in tests).
    env = {"DATABENTO_API_KEY": KEY, "TLUXE_DB_BRIDGE_TOKEN": TOKEN, "TLUXE_DB_HISTORY": "0", **over}
    return from_env(env)


def mapping(symbol: str, contract: str, iid: int, ts: int = T0) -> dbn.SymbolMappingMsg:
    return dbn.SymbolMappingMsg(publisher_id=1, instrument_id=iid, ts_event=ts, stype_in=dbn.SType.CONTINUOUS, stype_in_symbol=symbol,
                                stype_out=dbn.SType.RAW_SYMBOL, stype_out_symbol=contract, start_ts=ts, end_ts=ts + 86_400 * P)


def mbo(iid: int, action, side, price: float, size: int, oid: int, ts: int, flags: int = 128, seq: int = 0, channel: int = 1) -> dbn.MBOMsg:
    return dbn.MBOMsg(publisher_id=1, instrument_id=iid, ts_event=ts, order_id=oid, price=round(price * P), size=size, action=action, side=side,
                      ts_recv=ts + 1000, flags=flags, channel_id=channel, sequence=seq)


def snapshot(iid: int, orders: list[tuple], ts: int = T0) -> list[dbn.MBOMsg]:
    """Clear + resting orders, every record F_SNAPSHOT, the LAST one F_SNAPSHOT | F_LAST."""
    recs = [mbo(iid, A.CLEAR, S.NONE, 0, 0, 0, ts, flags=32)]
    for k, (side, price, size, oid) in enumerate(orders):
        recs.append(mbo(iid, A.ADD, side, price, size, oid, ts + k + 1, flags=32))
    last = recs[-1]
    recs[-1] = dbn.MBOMsg(publisher_id=1, instrument_id=last.instrument_id, ts_event=last.ts_event, order_id=last.order_id, price=last.price, size=last.size,
                          action=last.action, side=last.side, ts_recv=last.ts_recv, flags=32 | 128, channel_id=1, sequence=0)
    return recs


def trade(iid: int, price: float, size: int, side, ts: int, seq: int = 0, delta: int = 0) -> dbn.TradeMsg:
    return dbn.TradeMsg(publisher_id=1, instrument_id=iid, ts_event=ts, price=round(price * P), size=size, action=A.TRADE, side=side, depth=0,
                        ts_recv=ts + 500, flags=128, ts_in_delta=delta, sequence=seq)


def bar(iid: int, t_sec: int, o: float, h: float, l: float, c: float, v: int) -> dbn.OHLCVMsg:
    return dbn.OHLCVMsg(rtype=dbn.RType.OHLCV_1M, publisher_id=1, instrument_id=iid, ts_event=t_sec * P, open=round(o * P), high=round(h * P), low=round(l * P), close=round(c * P), volume=v)


def heartbeat(ts: int) -> dbn.SystemMsg:
    return dbn.SystemMsg(ts_event=ts, msg="Heartbeat")


class FakeLive:
    """Scripted stand-in for databento.Live with the same session interface (TEST DATA)."""

    instances: list = []

    def __init__(self, records=(), start_error: str | None = None, close_error: str | None = None, hold: bool = False) -> None:
        self.records = list(records)
        self.start_error = start_error
        self.close_error = close_error
        self.hold = hold
        self.cb = None
        self.subs: list = []
        self.started = False
        self.terminated = threading.Event()
        FakeLive.instances.append(self)

    def add_callback(self, cb, exc_cb=None):
        self.cb = cb

    def subscribe(self, **kw):
        self.subs.append(kw)

    def start(self):
        if self.start_error:
            raise RuntimeError(self.start_error)
        self.started = True

    def block_for_close(self, timeout=None):
        for r in self.records:
            self.cb(r)
        if self.hold:
            self.terminated.wait(10)
        if self.close_error:
            raise RuntimeError(self.close_error)

    def terminate(self):
        self.terminated.set()


def factory_from(scripts: list):
    """Each connection attempt takes the next FakeLive from `scripts` (then idle held sessions)."""
    it = iter(scripts)

    def f(key: Secret, hb: int):
        assert isinstance(key, Secret)
        try:
            return next(it)
        except StopIteration:
            return FakeLive(hold=True)

    return f
