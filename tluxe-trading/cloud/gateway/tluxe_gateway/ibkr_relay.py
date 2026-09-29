"""IBKR COMEX Level-2 depth relay (MARKET DATA ONLY).

  cloud Windows VPS: IB Gateway (127.0.0.1) -> TLUXE IBKR depth bridge -- OUTBOUND wss --> /bridge/ibkr (this module)
  browsers (any device): GET /api/ibkr/status | /api/ibkr/book?root= | /api/ibkr/updates?root=&epoch=&after=

The home PC is never involved: the VPS link connects out to this gateway, browsers only talk to this gateway.

Book rules (never relaxed):
  * the book of a root is built ONLY from the bridge's normalized IBKR messages (`book` snapshot, sequenced `depth`
    price-level changes, `reset`); nothing is inferred from trades or anything else;
  * a depth sequence gap, a reset, a link loss, a stale link or a contract change invalidates the book: it is cleared,
    a new epoch starts and browsers resync - depth of uncertain continuity is never served as current;
  * `valid` is true only while the VPS link is live, IBKR reports that root LIVE and no gap is open.
Security: the link authenticates with a bridge token (only SHA-256 hashes live in the cloud: TLUXE_IBKR_BRIDGE_TOKEN_SHA256),
every message is sequenced + time-checked (replay / skew rejected), and no path from the browser reaches the VPS.
"""
from __future__ import annotations

import collections
import json
import logging
import math
import re
import time
from datetime import datetime
from typing import Callable

log = logging.getLogger("tluxe.gateway.ibkr")
MAX_SKEW_MS = 30_000
STALE_AFTER_S = 30
RING = 20_000  # recent price-level changes kept per root for incremental browser polling
MAX_MESSAGE = 4_000_000
ROOTS = ("GC", "SI")
# ---- pull mode (TLUXE_IBKR_DEPTH_URL / TOKEN): the VPS depth service is polled server-side ----
PULL_STALE_S = 10.0  # lastUpdate (bridge receive time) older than this -> STALE: depth withheld, never shown as live
PULL_OFFLINE_AFTER = 3  # consecutive failed polls -> OFFLINE (before that RECONNECTING)
UPSTREAM_STATES = {"LIVE": "LIVE", "STALE": "STALE", "RECONNECTING": "RECONNECTING", "OFFLINE": "OFFLINE",
                   "NOT_ENTITLED": "NOT_ENTITLED", "NOT ENTITLED": "NOT_ENTITLED", "UNSUPPORTED": "UNSUPPORTED"}
CONTRACT_KEYS = {"conId": ("conId", "con_id", "conid"), "localSymbol": ("localSymbol", "local_symbol"), "symbol": ("symbol",),
                 "exchange": ("exchange",), "currency": ("currency",), "expiry": ("expiry", "lastTradeDateOrContractMonth", "last_trade_date"),
                 "multiplier": ("multiplier",), "minTick": ("minTick", "min_tick"), "tradingClass": ("tradingClass", "trading_class"), "secType": ("secType", "sec_type")}


class Malformed(ValueError):
    pass


def _iso_ms(v) -> int:
    if not isinstance(v, str) or not v:
        raise Malformed("lastUpdate missing")
    try:
        d = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        raise Malformed("lastUpdate is not ISO-8601") from None
    if d.tzinfo is None:
        raise Malformed("lastUpdate has no timezone")
    return int(d.timestamp() * 1000)


def _rows(v, side: str) -> list[tuple[int, float, float, str | None]]:
    if not isinstance(v, list):
        raise Malformed(f"{side} is not a list")
    out = []
    for i, r in enumerate(v):
        if not isinstance(r, dict):
            raise Malformed(f"{side}[{i}] is not an object")
        price, size, pos = r.get("price"), r.get("size"), r.get("position", i)
        if isinstance(price, bool) or isinstance(size, bool) or not isinstance(price, (int, float)) or not isinstance(size, (int, float)):
            raise Malformed(f"{side}[{i}] price/size not numeric")
        if not (math.isfinite(price) and math.isfinite(size)) or price <= 0 or size < 0:
            raise Malformed(f"{side}[{i}] price/size out of range")
        if isinstance(pos, bool) or not isinstance(pos, int) or pos < 0:
            raise Malformed(f"{side}[{i}] position invalid")
        mm = r.get("marketMaker")
        out.append((pos, float(price), float(size), mm if isinstance(mm, str) and mm else None))  # null stays null - never inferred
    return out


def parse_depth(root: str, body) -> dict:
    """Validate + sanitize one upstream depth snapshot. Only known fields survive (nothing else reaches browsers)."""
    if not isinstance(body, dict):
        raise Malformed("not a JSON object")
    if body.get("symbol") != root:
        raise Malformed(f"symbol {str(body.get('symbol'))[:8]!r} != requested {root}")  # never cross GC / SI
    if body.get("depthType") != "PRICE_LEVEL":
        raise Malformed("depthType is not PRICE_LEVEL")
    if body.get("mbo") is not False:
        raise Malformed("mbo is not false")  # price-level depth only - never treated as order-by-order
    status = UPSTREAM_STATES.get(str(body.get("status") or "").upper())
    if status is None:
        raise Malformed("unknown status")
    c = body.get("contract") if isinstance(body.get("contract"), dict) else {}
    contract = {}
    for k, names in CONTRACT_KEYS.items():
        for n in names:
            v = c.get(n)
            if isinstance(v, (str, int, float)) and not isinstance(v, bool) and v != "":
                contract[k] = v
                break
    bids = sorted(_rows(body.get("bids"), "bids"), key=lambda r: (r[0], -r[1]))
    asks = sorted(_rows(body.get("asks"), "asks"), key=lambda r: (r[0], r[1]))
    return {"status": status, "lastUpdateMs": _iso_ms(body.get("lastUpdate")), "contract": contract, "bids": bids, "asks": asks}


class PullState:
    def __init__(self) -> None:
        self.state = "RECONNECTING"
        self.detail: str | None = "waiting for the first IBKR depth snapshot"
        self.last_update_ms: int | None = None
        self.last_ok_s: float | None = None
        self.errors = 0
        self.polls = 0
        self.out_of_order = 0
        self.malformed = 0
        self.rows: dict = {"bids": [], "asks": []}


ACCOUNT_ID = re.compile(r"\b(?:DU|DF|DI|U|F|I)\d{5,10}\b")


def redact(v):
    if isinstance(v, str):
        return ACCOUNT_ID.sub("[account]", v)
    if isinstance(v, dict):
        return {k: redact(x) for k, x in v.items()}
    if isinstance(v, list):
        return [redact(x) for x in v]
    return v


class RootBook:
    def __init__(self, root: str) -> None:
        self.root = root
        self.epoch = 0
        self.seq = 0  # last applied depth sequence
        self.bids: dict[float, float] = {}
        self.asks: dict[float, float] = {}
        self.ring: collections.deque = collections.deque(maxlen=RING)
        self.in_sync = False  # the bridge book baseline is known (snapshot / reset received, no open gap)
        self.contract: dict | None = None
        self.last_depth_ms: int | None = None
        self.reason: str | None = None

    def invalidate(self, reason: str) -> None:
        self.bids.clear()
        self.asks.clear()
        self.ring.clear()
        self.epoch += 1
        self.in_sync = False
        self.reason = reason


class IbkrRelay:
    def __init__(self, keys: tuple = (), clock: Callable[[], float] = time.time, pull: bool = False) -> None:
        self.keys = keys
        self.pull = pull  # server-side polling of the VPS depth service (TLUXE_IBKR_DEPTH_URL / TOKEN)
        self.pulls = {r: PullState() for r in ROOTS}
        self.clock = clock
        self.ws = None
        self.bridge_id: str | None = None
        self.connected_at: float | None = None
        self.last_rx: float | None = None
        self.rx_seq = 0
        self.tx_seq = 0
        self.health: dict = {}
        self.books = {r: RootBook(r) for r in ROOTS}
        self.targets: dict[str, str] = {}
        self.sent_targets: dict[str, str] = {}
        self.counts = {"rejectedSkew": 0, "rejectedReplay": 0, "linkGaps": 0, "depthGaps": 0, "authRejected": 0, "resets": 0, "snapshots": 0, "changes": 0}
        self.last_detail: str | None = None

    @property
    def configured(self) -> bool:
        return bool(self.keys) or self.pull

    def now_ms(self) -> int:
        return int(self.clock() * 1000)

    # ------------------------------------------------------------------ link
    def envelope(self, body: dict) -> str:
        self.tx_seq += 1
        return json.dumps({**body, "seq": self.tx_seq, "ts": self.now_ms()}, separators=(",", ":"))

    def validate(self, msg: dict) -> str | None:
        seq, ts = msg.get("seq"), msg.get("ts")
        if not isinstance(seq, int) or not isinstance(ts, int):
            return "MALFORMED"
        if abs(ts - self.now_ms()) > MAX_SKEW_MS:
            self.counts["rejectedSkew"] += 1
            return "TIMESTAMP_SKEW"
        if seq <= self.rx_seq:
            self.counts["rejectedReplay"] += 1
            return "REPLAY_OR_OUT_OF_ORDER"
        if self.rx_seq and seq != self.rx_seq + 1:
            self.counts["linkGaps"] += 1  # link messages lost: every book's continuity is unknown
            for b in self.books.values():
                b.invalidate(f"link sequence gap {self.rx_seq} -> {seq}")
        self.rx_seq = seq
        return None

    async def attach(self, ws, bridge_id: str) -> None:
        if self.ws is not None:
            try:
                await self.ws.close(code=4000, message=b"replaced")
            except Exception:
                pass
        self.ws, self.bridge_id = ws, bridge_id[:64]
        self.connected_at = self.last_rx = self.clock()
        self.rx_seq = self.tx_seq = 0
        self.sent_targets = {}
        self.last_detail = None
        for b in self.books.values():
            b.invalidate("VPS link (re)connected - waiting for the bridge snapshot")

    def detach(self, ws, why: str) -> None:
        if self.ws is ws:
            self.ws = None
            self.last_detail = why
            self.health = {}
            for b in self.books.values():
                b.invalidate(f"VPS link closed ({why})")

    async def send(self, body: dict) -> None:
        if self.ws is not None:
            await self.ws.send_str(self.envelope(body))

    async def on_message(self, raw: str) -> None:
        if len(raw) > MAX_MESSAGE:
            return
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        if not isinstance(msg, dict) or self.validate(msg):
            return
        self.last_rx = self.clock()
        kind = msg.get("type")
        root = msg.get("root")
        b = self.books.get(root) if isinstance(root, str) else None
        if kind == "health" and isinstance(msg.get("session"), dict):
            self.health = redact({"session": msg["session"], "roots": msg.get("roots") if isinstance(msg.get("roots"), dict) else {}})
        elif kind == "contract" and b and isinstance(msg.get("contract"), dict):
            if b.contract and b.contract.get("conId") != msg["contract"].get("conId"):
                b.invalidate("contract changed")
            b.contract = msg["contract"]
        elif kind == "reset" and b and isinstance(msg.get("depthSeq"), int):
            b.invalidate(str(msg.get("reason") or "reset")[:200])
            self.counts["resets"] += 1
            b.seq, b.in_sync = msg["depthSeq"], True  # known baseline: the book is empty; IBKR re-sends rows
        elif kind == "book" and b and isinstance(msg.get("depthSeq"), int):
            b.invalidate("snapshot")
            self.counts["snapshots"] += 1
            if msg.get("valid"):
                b.bids = {float(p): float(s) for p, s in msg.get("bids") or [] if s > 0}
                b.asks = {float(p): float(s) for p, s in msg.get("asks") or [] if s > 0}
            if isinstance(msg.get("contract"), dict):
                b.contract = msg["contract"]
            b.seq, b.in_sync, b.reason = msg["depthSeq"], True, None
        elif kind == "depth" and b and isinstance(msg.get("changes"), list):
            await self._apply(b, msg["changes"])

    async def _apply(self, b: RootBook, changes: list) -> None:
        for c in changes:
            if not isinstance(c, list) or len(c) < 7:
                continue
            seq, side, price, size, _op, _pos, recv = c[:7]
            if not b.in_sync:
                continue  # waiting for a snapshot: never apply onto an unknown book
            if seq != b.seq + 1:
                self.counts["depthGaps"] += 1
                b.invalidate(f"depth sequence gap {b.seq} -> {seq}")
                await self.send({"type": "snapshot", "root": b.root})
                return
            book = b.bids if side == "bid" else b.asks if side == "ask" else None
            if book is None:
                continue
            if size > 0:
                book[float(price)] = float(size)
            else:
                book.pop(float(price), None)
            b.seq = seq
            b.last_depth_ms = int(recv)
            b.ring.append([seq, side, float(price), float(size), int(recv)])
            self.counts["changes"] += 1

    async def tick(self, targets: dict[str, str]) -> None:
        """Every few seconds: stale link check, heartbeat, target contracts (the active Databento contract per root)."""
        ws = self.ws
        if ws is None:
            return
        if self.last_rx is not None and self.clock() - self.last_rx > STALE_AFTER_S:
            log.warning("IBKR bridge link stale (%d s) - closing", STALE_AFTER_S)
            await ws.close(code=4001, message=b"stale")
            self.detach(ws, "stale")
            return
        self.targets = {r: t for r, t in targets.items() if r in ROOTS and t}
        if self.targets and self.targets != self.sent_targets:
            await self.send({"type": "targets", "roots": self.targets})
            self.sent_targets = dict(self.targets)
        await self.send({"type": "heartbeat"})

    # ------------------------------------------------------------------ pull mode
    def ingest_error(self, root: str, kind: str, http_status: int | None = None) -> None:
        """A failed poll. The reason is sanitized (no URL, header, token or upstream body ever kept)."""
        p = self.pulls[root]
        p.polls += 1
        p.errors += 1
        if kind == "malformed":
            p.malformed += 1
        why = {"timeout": "IBKR depth service timed out", "offline": "IBKR depth service unreachable",
               "malformed": "IBKR depth service returned an invalid response"}.get(kind, f"IBKR depth service answered HTTP {http_status}")
        if http_status in (401, 403):
            why = f"IBKR depth service rejected the server credential (HTTP {http_status})"
        p.state = "OFFLINE" if p.errors >= PULL_OFFLINE_AFTER or http_status in (401, 403) else "RECONNECTING"
        p.detail = why
        self.books[root].invalidate(why)

    async def ingest(self, root: str, body) -> None:
        p, b = self.pulls[root], self.books[root]
        p.polls += 1
        try:
            d = parse_depth(root, body)
        except Malformed as e:
            self.ingest_error(root, "malformed")
            p.detail = f"IBKR depth service returned an invalid response ({e})"
            return
        if p.last_update_ms is not None and d["lastUpdateMs"] < p.last_update_ms:
            p.out_of_order += 1  # an older snapshot never overwrites a newer book
            return
        p.errors, p.last_ok_s, p.last_update_ms = 0, self.clock(), d["lastUpdateMs"]
        p.state, p.detail = d["status"], None
        c = d["contract"]
        if b.contract and c.get("localSymbol") != b.contract.get("localSymbol"):
            b.invalidate("contract changed")
        b.contract = c or None
        p.rows = {"bids": [{"position": r[0], "price": r[1], "size": r[2], "marketMaker": r[3]} for r in d["bids"]],
                  "asks": [{"position": r[0], "price": r[1], "size": r[2], "marketMaker": r[3]} for r in d["asks"]]}
        fresh = self.now_ms() - d["lastUpdateMs"] <= PULL_STALE_S * 1000
        if d["status"] != "LIVE" or not fresh or not (d["bids"] or d["asks"]):
            if d["status"] == "LIVE":
                p.state = "STALE"
                p.detail = "IBKR returned an empty book" if not (d["bids"] or d["asks"]) else f"no IBKR depth update for > {int(PULL_STALE_S)} s"
            b.invalidate(p.detail or d["status"])
            return
        bids = {}
        for _pos, price, size, _mm in d["bids"]:
            if size > 0:
                bids.setdefault(price, size)
        asks = {}
        for _pos, price, size, _mm in d["asks"]:
            if size > 0:
                asks.setdefault(price, size)
        if not b.in_sync:
            b.invalidate("snapshot")
            b.bids, b.asks, b.in_sync, b.reason = bids, asks, True, None
            b.last_depth_ms = d["lastUpdateMs"]
            self.counts["snapshots"] += 1
            return
        # Genuine change between two real consecutive snapshots (net change at poll granularity - never interpolated).
        changes = []
        for side, new, old in (("bid", bids, b.bids), ("ask", asks, b.asks)):
            for price in sorted(set(new) | set(old)):
                if new.get(price) != old.get(price):
                    changes.append([0, side, price, new.get(price, 0.0), "set" if price in new else "delete", 0, d["lastUpdateMs"]])
        for ch in changes:
            ch[0] = b.seq + 1
            await self._apply(b, [ch])
        b.last_depth_ms = d["lastUpdateMs"]

    # ------------------------------------------------------------------ browser views (read-only, no account data)
    def root_state(self, root: str) -> tuple[str, str | None]:
        if not self.configured:
            return "NOT_CONFIGURED", "IBKR depth bridge not configured (TLUXE_IBKR_BRIDGE_TOKEN_SHA256 unset)"
        if self.pull and not self.keys:
            p = self.pulls[root]
            st, detail = p.state, p.detail
            now = self.clock()
            if st == "LIVE" and p.last_update_ms is not None and now * 1000 - p.last_update_ms > PULL_STALE_S * 1000:
                st, detail = "STALE", f"no IBKR depth update for > {int(PULL_STALE_S)} s (last {p.last_update_ms})"
            if st == "LIVE" and (p.last_ok_s is None or now - p.last_ok_s > PULL_STALE_S):
                st, detail = "RECONNECTING", "IBKR depth service not answering"
            tgt, c = self.targets.get(root), self.books[root].contract
            if st == "LIVE" and tgt and c and c.get("localSymbol") and c.get("localSymbol") != tgt:
                return "CONTRACT_MISMATCH", f"IBKR {c.get('localSymbol')} != Databento {tgt} - depth withheld (contracts are never mixed)"
            return st, detail
        if self.ws is None:
            return "OFFLINE", "IBKR VPS bridge link offline" + (f" ({self.last_detail})" if self.last_detail else "")
        s = (self.health.get("session") or {})
        if s.get("state") == "AUTH_REQUIRED":
            return "AUTH_REQUIRED", s.get("detail") or "IB Gateway login / 2FA required on the VPS"
        if s.get("state") in ("OFFLINE", "RECONNECTING", "CONNECTING"):
            return s["state"], s.get("detail")
        r = (self.health.get("roots") or {}).get(root) or {}
        st = r.get("state") or "CONNECTING"
        tgt, c = self.targets.get(root), self.books[root].contract
        if st == "LIVE" and tgt and c and c.get("localSymbol") != tgt:
            return "CONTRACT_MISMATCH", f"IBKR {c.get('localSymbol')} != Databento {tgt} - depth withheld (contracts are never mixed)"
        return {"SUBSCRIBING": "CONNECTING", "RESOLVING": "CONNECTING", "WAITING_TARGET": "CONNECTING", "UNRESOLVED": "CONTRACT_UNRESOLVED"}.get(st, st), r.get("detail")

    def valid(self, root: str) -> bool:
        b = self.books[root]
        return self.root_state(root)[0] == "LIVE" and b.in_sync

    def status(self) -> dict:
        s = self.health.get("session") or {}
        link_stale = self.ws is not None and self.last_rx is not None and self.clock() - self.last_rx > STALE_AFTER_S
        if self.pull and not self.keys:
            ok = [p.last_ok_s for p in self.pulls.values() if p.last_ok_s]
            s = {"state": "LIVE" if any(self.root_state(r)[0] == "LIVE" for r in ROOTS) else self.root_state("GC")[0],
                 "apiConnected": bool(ok) and self.clock() - max(ok) < PULL_STALE_S, "authRequired": False, "detail": None,
                 "lastIbHeartbeatMs": None, "reconnects": sum(p.errors for p in self.pulls.values()), "nextReconnectMs": None, "lastError": None}
        out = {"provider": "IBKR", "exchange": "COMEX", "configured": self.configured, "mode": "pull" if self.pull and not self.keys else "link",
               "depthTypeCode": "PRICE_LEVEL", "mbo": False,
               "link": {"connected": self.ws is not None, "stale": link_stale, "bridgeId": self.bridge_id,
                        "connectedAtMs": int(self.connected_at * 1000) if self.connected_at else None,
                        "lastMessageMs": int(self.last_rx * 1000) if self.last_rx else None, "detail": self.last_detail},
               "session": {k: s.get(k) for k in ("state", "apiConnected", "ibServerLink", "authRequired", "detail", "lastIbHeartbeatMs", "lastConnectedMs",
                                                  "reconnects", "nextReconnectMs", "lastError")},
               "roots": {}, "counts": dict(self.counts),
               "depthType": "PRICE_LEVEL - aggregated price levels (IBKR market depth, COMEX); order-by-order (MBO) NOT provided",
               "timestampSource": "bridge receive time (lastUpdate, UTC) - not an exchange timestamp"}
        for root, b in self.books.items():
            st, detail = self.root_state(root)
            r = (self.health.get("roots") or {}).get(root) or {}
            pl = self.pulls[root]
            out["roots"][root] = {"state": st, "detail": detail, "valid": self.valid(root), "contract": b.contract, "target": self.targets.get(root),
                                  "lastUpdateMs": pl.last_update_ms, "polls": pl.polls, "outOfOrder": pl.out_of_order, "malformed": pl.malformed,
                                  "bidLevels": len(b.bids), "askLevels": len(b.asks), "depthSeq": b.seq, "epoch": b.epoch, "lastDepthMs": b.last_depth_ms,
                                  "rowsRequested": r.get("rowsRequested"), "ops": r.get("ops"), "marketMakerField": r.get("marketMakerField"), "resetReason": b.reason}
        return out

    def book(self, root: str) -> dict:
        b = self.books[root]
        st, detail = self.root_state(root)
        valid = self.valid(root)
        rows = self.pulls[root].rows if (valid and self.pull and not self.keys) else {"bids": [], "asks": []}
        return {"root": root, "state": st, "detail": detail, "valid": valid, "epoch": b.epoch, "depthSeq": b.seq, "contract": b.contract,
                "source": "Interactive Brokers", "depthType": "PRICE_LEVEL", "mbo": False, "rows": rows,
                "lastDepthMs": b.last_depth_ms, "lastUpdateMs": self.pulls[root].last_update_ms, "serverMs": self.now_ms(),
                "bids": sorted(([p, s] for p, s in b.bids.items()), key=lambda x: -x[0]) if valid else [],
                "asks": sorted(([p, s] for p, s in b.asks.items()), key=lambda x: x[0]) if valid else []}

    def updates(self, root: str, epoch: int, after: int) -> dict:
        b = self.books[root]
        st, detail = self.root_state(root)
        base = {"root": root, "state": st, "detail": detail, "valid": self.valid(root), "epoch": b.epoch, "depthSeq": b.seq, "serverMs": self.now_ms()}
        if self.pull and not self.keys:  # the visible IBKR rows (position / price / size / marketMaker) for the DOM, only while valid
            base.update(lastUpdateMs=self.pulls[root].last_update_ms, rows=self.pulls[root].rows if base["valid"] else {"bids": [], "asks": []})
        if not base["valid"] or epoch != b.epoch or after > b.seq:
            return {**base, "resync": True, "changes": []}
        if after == b.seq:
            return {**base, "resync": False, "changes": []}
        oldest = b.ring[0][0] if b.ring else b.seq + 1
        if after + 1 < oldest:
            return {**base, "resync": True, "changes": []}  # older than the ring: take a fresh book
        return {**base, "resync": False, "changes": [c for c in b.ring if c[0] > after][:5000]}
