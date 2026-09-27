# Trading by TLUXE — Databento market-data bridge (CME Globex / COMEX)

**MARKET DATA ONLY.** No order entry, no trading. Real Databento `GLBX.MDP3` data for **GC** (COMEX Gold) and **SI**
(COMEX Silver) → the TLUXE Liquidity Heatmap, Volume Footprint and Volume Profile.

```
CME / COMEX → Databento GLBX.MDP3 (MDP 3.0) → THIS bridge (official `databento` SDK, server-side key)
  → normalized frames (127.0.0.1:8766, bridge token) → ONE browser feed → Heatmap · Footprint · Volume Profile
```

## Setup (Windows)

```bat
cd C:\Users\twaha\TRADING\tluxe-trading\bridge\databento
py -3.11 -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
```

Edit `.env` (gitignored — never commit it):

- `DATABENTO_API_KEY=` your key (server-side only; never in the browser, chat, source files or Git).
- `TLUXE_DB_BRIDGE_TOKEN=` a new random secret: `.venv\Scripts\python -c "import secrets; print(secrets.token_urlsafe(32))"`.

Start: `start_bridge.cmd`. Then in TLUXE (http://localhost:5181) → **Settings → Databento Bridge**: enable, URL
`http://127.0.0.1:8766`, paste the **bridge token** (NOT the Databento key) → Save.

The bridge refuses to start without `DATABENTO_API_KEY` (fail closed), refuses a second instance, never shares its
port, binds to 127.0.0.1, checks the browser origin allowlist and the bridge token on every request.

## Live validation (your machine)

```bat
.venv\Scripts\python live_check.py --seconds 180
```

Prints PASS / FAIL / NOT OBSERVED per item for GC and SI (authentication, dataset, symbol mapping, actual contract,
MBO snapshot, snapshot valid, incremental MBO, real trades, timestamps moving, integrity, heatmap / footprint / volume
profile inputs). The key is never printed. A closed or quiet market is reported as NOT OBSERVED — never faked.

## What is subscribed

| session | schema | options | feeds |
|---|---|---|---|
| book | `mbo` | `snapshot=True`, `GC.v.0`, `SI.v.0` (continuous, volume leader) | order-level books → Liquidity Heatmap |
| tape | `trades` | intraday replay `start` (24 h window / overlap after reconnect) | Footprint, Heatmap prints, forming bar |
| tape | `ohlcv-1m` | same `start` | Volume Profile / charts (real exchange volume) |

`TLUXE_DB_CONTRACT_MODE=manual` + `TLUXE_DB_CONTRACT_GC=GCZ6` / `..._SI=SIZ6` subscribes raw contracts instead.
Every `SymbolMappingMsg` is stored; records are routed by instrument ID only. A mapping change is a **roll**:
logged (`/v1/health → rolls`), the book is rebuilt from a fresh snapshot, the trade tape and candle history restart
for the new contract (two contracts are never merged).

## Book rules (MBO)

`A` add · `C` cancel (partial or full) · `M` modify (price move / size change; unknown order → add, as in
Databento's reference book) · `R` clear · `T`/`F`/`N` do not change resting orders · side `N` ignored.
**SYNCING** until the snapshot record with `F_SNAPSHOT|F_LAST`; levels are only published at `F_LAST` event
boundaries. `F_MAYBE_BAD_BOOK`, an out-of-order channel sequence, a cancel of a missing order or a malformed record
→ **DEGRADED** + automatic snapshot resync. Databento `sequence` is the venue channel sequence (not contiguous per
instrument), so it is used for ordering checks, never to invent gaps or numbers.

## Trades / footprint classification

Databento `side` on a trade = the initiating (aggressor) side: `B` → BUY (Ask volume), `A` → SELL (Bid volume),
`N` → **UNKNOWN** (kept separate, never guessed, never split). Delta = Ask − Bid; unknown volume is excluded and
reported (CVD shows PARTIAL).

## Reconnect / recovery

- Backoff 1 s → 60 s with jitter; > 8 reconnects in 5 min → reconnect-storm hold-off (120 s, DEGRADED).
- Auth failure → `AUTH_ERROR`, retried only every 5 min. Entitlement errors → `UNAVAILABLE`.
- MBO: a new session with `snapshot=True` (SYNCING → VALID). The old book is frozen and never served as live.
- Trades: replay from 60 s before the last processed trade; replayed records are dropped exactly (de-dup key +
  occurrence index) — no double volume. An outage longer than the replay window is flagged as a **gap** (DEGRADED).

## Status / freshness

`CONNECTING · SYNCING · LIVE · DEGRADED · STALE · RECONNECTING · UNAVAILABLE · AUTH_ERROR` per instrument;
freshness `LIVE · DELAYED · STALE · OFFLINE · UNAVAILABLE`:

- **STALE** — no Databento message (data or heartbeat; heartbeat interval 10 s) for 25 s.
- **DELAYED / DEGRADED** — ingest lag (processing time − `ts_recv` of live MBO) above 5 s, backlog above 50 000
  records, book degraded, recent tape gap or reconnect storm.
- **OFFLINE** — a session is not connected (browser: bridge unreachable for 10 s → book cleared, DISCONNECTED).

## Bounded memory / backpressure

Order books (exchange-bounded) · trades ring `TLUXE_DB_MAX_TRADES` (100 000 / root) · frame ring
`TLUXE_DB_MAX_FRAMES` (1 200 × 250 ms) · M1 bars for the replay window · de-dup keys for a 3-minute window.
The SDK callback only enqueues; one worker applies records in order (queue depth reported). Above 2 000 000 queued
records the queued book records are discarded and the book is re-snapshotted (reported, never silent); trades are
never discarded. The browser receives batched frames (default 4 / s), never one message per market event.

## Tests

`.venv\Scripts\python -m unittest discover -s tests` (TEST DATA fixtures; `TLUXE_STRESS_RECORDS` scales the MBO
stress test, default 1 000 000).
