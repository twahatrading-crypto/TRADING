# XAUUSD Liquidity-Sweep Strategy Dashboard (local, MT5-only)

A local Windows application that reads **only** live data from your running
MetaTrader 5 terminal, runs a deterministic *Liquidity Sweep → MSS →
Displacement → FVG Retracement → Entry* state machine, and shows the result in
a dark trading-terminal dashboard.

```
MT5 terminal ──► MetaTrader5 Python pkg ──► normalized UTC candles ──► strategy engine ──► FastAPI + WebSocket ──► browser dashboard
                 (xau/mt5_client.py)         (xau/strategy/market.py)  (xau/strategy/*)     (xau/live.py, server.py)  (frontend/)
```

> **Version 1 = ANALYSIS + SIGNALS ONLY.** The code never calls `order_send()`
> and cannot open, modify or close positions. MT5 is wrapped in a read-only
> whitelist proxy (`ReadOnlyMT5`), and a unit test scans the source to prove it.
> Entry, SL, TP and lot size are suggestions; you execute manually.

> **A working dashboard is not a profitable strategy.** Use the backtest (below)
> and judge the numbers before you risk money.

---

## 1. Start it

1. Install **64-bit Python 3.10+** from python.org and tick *Add python.exe to PATH*.
2. Start **MetaTrader 5**, log in to your broker, and make sure gold is in Market Watch.
3. Double-click **`start.bat`**. It will:
   1. check Python;
   2. create `.venv` and install `requirements.txt` the first time;
   3. run `python -m xau.doctor`, which checks dependencies, connects to MT5, detects the gold symbol and prints the contract spec;
   4. start the backend, which connects to MT5 and keeps reconnecting;
   5. open `http://127.0.0.1:8765/`.

Clear errors are printed if Python, a dependency or the MT5 terminal is missing.
If MT5 is closed, the dashboard still opens, shows **MT5 OFFLINE** and connects
as soon as the terminal is running.

Settings are stored in `config/settings.json`, which is created on the first run.
You can edit most of them in the dashboard's **Settings** dialog.

### Broker server time (important)
MT5 timestamps are in broker *server* time. `feed.server_timezone` defines the rule explicitly:

| value | meaning |
|---|---|
| `NY+7` (default) | server = New York time + 7h → GMT+2 winter / GMT+3 summer, switching on **US** DST dates (most MT5 brokers; D1 candle opens at the 17:00 NY close) |
| `Europe/Athens` (any IANA zone) | server follows that zone's DST rules |
| `UTC`, `fixed:+2` | constant offset, no DST |

While ticks arrive, the backend measures the real offset. If it disagrees with
the rule, the dashboard shows a warning banner. Sessions are defined in their
own markets' time zones (Tokyo, London, New York) through `zoneinfo`, so no
UTC offsets are hard-coded.

### Symbol
The symbol is auto-detected from the broker list: `XAUUSD`, `XAUUSDm`,
`XAUUSD.a`, `XAUUSD#`, `GOLD`, `GOLDm`, and so on. `XAUEUR`, `XAUUSDT` and
`GOLDEUR` are rejected. The exact broker symbol in use is shown under the title.
To force one, set *Broker symbol* in Settings.

---

## 2. Feed integrity

| status | meaning | signals |
|---|---|---|
| **MT5 LIVE** | terminal connected, new ticks within `feed.stale_seconds` (default 30s) | evaluated |
| **DATA STALE** | connected, market should be open, but no new tick | **paused**; bid/ask blanked |
| **MARKET CLOSED** | weekend or daily break (defined in New York time) | closed candles only |
| **MT5 RECONNECTING** | terminal lost its broker connection, or a call failed | paused |
| **MT5 OFFLINE** | terminal not running, `initialize()` failed, or package missing | paused |

Freshness is measured with the local monotonic clock: it is the time since the
tick *changed*, so a wrong timezone setting cannot fake freshness. When the
feed comes back, candles that closed in the meantime are processed in order
from MT5 history, so no candle is skipped. When the feed is not live, the chart
is covered by a banner and no value is shown as a live quote.

---

## 3. Strategy rules (all thresholds are in `strategy.*` settings)

All decisions are made on **closed M5 candles**. Tick data only drives the
display, for example the "price in entry zone" hint.

1. **Liquidity** (`xau/strategy/liquidity.py`). Only these count:
   - PDH/PDL: the last closed broker D1 candle.
   - Asia High/Low: the last *completed* Asian session (Tokyo 09:00–15:00).
   - Equal highs/lows: two confirmed M5 fractal swings within `max(0.1×ATR, 10 pts)`, at least 6 bars apart, with nothing beyond them in between.
   - Confirmed M15 and H1 fractal swings.

   A level is liquidity only from the moment it became knowable (`formed_at`) until price trades through it. Levels within 0.15×ATR of each other are merged as confluence.
2. **Sweep** (`sweep.py`). A wick beyond the level by at least `max(10 pts, 0.05×ATR)` and at most 1.5×ATR, followed by a **close back inside within 3 candles**. A bigger push is a breakout, not a sweep. The engine stores the level, extreme, time, penetration, reclaim bars and rejection wick.
3. **MSS** (`structure.py`). After the sweep, an M5 candle must **close** through the *protected swing*: the last confirmed M5 swing before the sweep extreme. This must happen within 24 bars.
4. **Displacement** (`displacement.py`), in the leg from the sweep to the MSS. Either:
   - one candle with body ≥ 1.2×ATR **and** ≥ 1.8× the median body, closing in the outer 35% of its range; or
   - ≥ 3 consecutive directional candles whose bodies total ≥ 2×ATR.
5. **FVG** (`fvg.py`). A three-candle gap created by that leg, at least `max(0.15×ATR, 20 pts)`, and not yet traded into.
6. **Retracement / entry**. The engine waits; it **never chases**. The setup is invalidated if price reaches TP1 without retracing, or expires after 36 bars. Entry modes:
   - `limit_ce`: 50% of the FVG (default).
   - `limit_edge`: the proximal edge.
   - `confirmation`: a candle trades into the zone and closes in the trade direction.
7. **SL**. Beyond the sweep extreme by `max(0.1×ATR, 20 pts)` plus the bar spread. The SL is never shrunk. The setup is rejected if the SL is wider than $12 or 3×ATR.
8. **TP**. Targets are **real opposing liquidity only**:
   - TP2 is the nearest live level at ≥ `min_rr` (default 1:3) and within 8×ATR(H1).
   - TP1 is a nearer level at ≥ 1.5R. Otherwise TP1 is a 2R partial, but only because TP2 liquidity exists beyond it.
   - If no level qualifies, the result is **NO TRADE**. A target is never invented.
9. **Filters at entry**: R still valid against levels that are still live, entry session (default London / New York), H1 structure not opposed, manual news blackout list (MT5's Python API has no calendar), live feed, and no other A+ trade open.

**A+ BUY / A+ SELL** appears only when every mandatory item passes **and** the
score is ≥ the threshold (default 80). Otherwise the dashboard shows WAITING,
SETUP FORMING, WAITING FOR RETRACEMENT, NO TRADE (with the reason) or INVALIDATED.

### Score (0–100, `scoring.py`)
Every point comes from an explicit rule, so a score can be reproduced from its
components. The breakdown is shown in the dashboard and stored in the log.

| component | max | rules |
|---|---|---|
| Liquidity | 20 | base by type (PDH/PDL 14, Asia 13, EQ/H1 11, M15 8) + 3 per confluent level |
| Sweep | 15 | same-candle reclaim 6 (≤ 3 bars: 3) · penetration 0.1–1.0×ATR 5 (else 2) · rejection wick ≥ 40% 4 (≥ 20%: 2) |
| MSS | 15 | close ≥ 0.1×ATR beyond 5 (else 2) · within 6 bars 5 (12 bars: 3) · MSS candle is displacement 5 |
| Displacement | 15 | body ≥ 2×ATR 8 (≥ 1.5: 6, min: 4) · close in outer 20% 4 (else 2) · follow-through 3 |
| FVG | 10 | gap ≥ 0.5×ATR 5 (else 3) · first touch 3 · CE reached 2 |
| H1/M15 alignment | 10 | 5 each: aligned 5, neutral 2, opposed 0 |
| R | 10 | TP2 ≥ 4R 10, ≥ 3R 7 |
| Session | 5 | entry in London/NY 5 |

Before entry, the score is marked *provisional*. The final score is fixed at entry.

### Position size
Lot size is `balance × risk% / (SL distance / tick_size × tick_value_loss)`.
It is rounded **down** to the broker's `volume_step` and clamped to
`volume_max`. If even `volume_min` would exceed the risk, the dashboard says so
instead of rounding up. All contract values are read from MT5 `symbol_info`.
The balance comes from MT5 `account_info`, or a manual value. Default risk is 0.5%.

---

## 4. Signal log
Every setup, including rejected and invalidated ones, is upserted into SQLite
at `data/signals.db`. Each row holds: time, symbol, direction, liquidity level,
sweep, MSS, displacement metrics, FVG, entry, SL, TP1, TP2, R, score breakdown,
filters, session, result, R result, MFE/MAE in price and R, and the reasons.
Open it in the dashboard with **Log**, or with any SQLite tool.

---

## 5. Backtesting (same engine)

```
backtest.bat 2024-01-01 2024-12-31
backtest.bat 2024-01-01 2024-12-31 --entry-mode confirmation
python -m xau.backtest --source csv --csv-dir data/history --from 2024-01-01 --to 2024-06-30
```

The backtester fetches M5, M15, H1, H4 and D1 history from MT5 and caches it as
CSV in `data/history/`. It then feeds `MarketStore.snapshot_at(close)` to the
**same `StrategyEngine`** the live server uses. It reports:

- total trades, wins, losses, timeouts, win rate;
- average R, expectancy, profit factor, max drawdown (R), max consecutive losses;
- results by session, direction, year, month and liquidity type;
- exits compared: structural TP1, TP2, and fixed 1:2 / 1:3 / 1:4;
- a funnel showing why setups did or did not become trades.

Results are saved to `data/backtests/*.json|txt`.

Fill model: chart candles are bid prices. Sell SL and TP are checked against
ask (bid + bar spread), and buy entries against ask. If SL and target are both
inside one candle, **SL is assumed first**. Targets are not counted on the fill candle.

> To backtest more than a few months, raise *Tools → Options → Charts → Max bars
> in chart* in MT5, because history requests are limited by it.

Do not judge suitability on one period. At minimum, check sample size,
drawdown, behaviour per year and session, and an out-of-sample period you did
not tune on.

---

## 6. Tests

```
pip install -r requirements-dev.txt
python -m pytest
```

| area | tests |
|---|---|
| time / DST / sessions | NY+7 vs EU DST weeks, server↔UTC round-trip, D1 boundary = NY close, London/NY/Asia windows winter vs summer, market hours |
| liquidity | PDH/PDL, Asia range only after the session closes, equal highs, confluence merge, taken levels removed |
| detectors | swings need confirmed right-hand bars, sweep reclaim / breakout / tiny poke / both sides, MSS needs a close, displacement accepts and rejects, FVG |
| plan / risk | SL buffer, TP from liquidity only, rejection when no ≥ 3R target, too-far target, oversized SL, buy mirror, lot sizing for 3 different contract specs, below-minimum handling |
| engine | full SELL and mirrored BUY chain to TP2, stop-out, *no chasing*, R rejection, score threshold, session / news / feed filters, confirmation mode, idempotency |
| **no look-ahead** | snapshots contain only closed candles (all TFs); **truncation invariance** (engine state at T is identical whether future data exists or not); **future perturbation** (randomising every candle after T changes nothing up to T) |
| MT5 adapter (test double) | symbol ranking, read-only proxy blocks `order_send`, source scan, server→UTC conversion for all 6 TFs, spec reading |
| live service (test double) | LIVE → DATA STALE (no evaluation, no quote) → catch-up → RECONNECTING → OFFLINE → reconnect → LIVE, MARKET CLOSED, offset measurement |
| live ↔ backtest parity | the live service driven bar by bar logs exactly the same setups as `run_backtest` on the same data |
| replay / API | CSV replay reproduces identical setups, SQLite log, REST validation, WebSocket snapshot |

The candle sequences in `tests/` are **hand-built test fixtures** for the rule
tests. The application itself never generates or uses synthetic data.
`tests/fake_mt5.py` is a test double of the MetaTrader5 package; it lets the
adapter, reconnect and stale logic be tested without Windows.

**Replay on real data:** export history on your MT5 PC with
`python -m xau.backtest --from 2025-01-01 --to 2025-01-31 --csv-dir tests/data/real`.
After that, `test_replay_real_mt5_history` runs automatically on those candles.

### Manual live checklist (needs your Windows PC + MT5)
These cannot be verified without a real terminal:

1. `start.bat` → doctor prints your terminal, account, symbol and contract spec.
2. Badge shows **MT5 LIVE**, bid/ask/spread match Market Watch, and the forming candle moves.
3. Switch M1, M5, M15, H1, H4 and D1. The candles match the MT5 charts, and times are shown in server time like MT5.
4. No offset warning banner is shown. If one is, set `feed.server_timezone` correctly.
5. Close MT5 → RECONNECTING, then OFFLINE. Reopen it → LIVE again.
6. Disconnect the internet → DATA STALE after 30s during market hours.
7. Compare PDH/PDL and the Asia range with your own chart.

---

## 7. Layout
```
xau/models.py, timeutil.py, sessions.py, config.py
xau/strategy/   market (snapshots) · swings · liquidity · sweep · structure · displacement · fvg · plan · scoring · engine
xau/mt5_client.py   read-only MT5 adapter        xau/live.py   live service (feed status, catch-up, broadcast)
xau/server.py       FastAPI REST + WebSocket     xau/backtest.py   backtester + statistics
xau/signal_log.py   SQLite                       xau/doctor.py     pre-flight checks
frontend/           dashboard (vendored TradingView Lightweight Charts, Apache-2.0; works offline)
```
