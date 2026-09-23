# MT5 market data — pipeline and guarantees

```
MT5 terminal → TLUXE MT5 bridge (Windows, 127.0.0.1, Bearer token)
            → Mt5Provider (src/services/mt5)          symbol discovery · polling · freshness
            → integrity layer (services/market/integrity.ts)  quarantine · dedupe · order · gaps
            → MarketDataService                        one store per instrument, route-owned
            → SRService                                closed bars only
            → UI                                       Market bar · Chart · S&R · Settings
```

## Routing

Only instruments that declare an `mt5` price mapping can receive MT5 data
(XAUUSD, XAGUSD, FX pairs, crypto/DXY/Nasdaq CFDs *if the broker offers them*).
**GC and SI are COMEX futures and have no MT5 mapping**: XAUUSD is never mapped
onto GC and XAGUSD never onto SI. Futures-like broker symbols are only listed in
Settings.

## Symbol discovery (per instrument, stops on ambiguity)

1. user override (Settings) → 2. exact canonical name → 3. safe alias (e.g. `GOLD`, `SILVER`)
→ 4. broker suffix/prefix variant (`XAUUSD.m`, `m.XAUUSD`, `EURUSDpro`) → reciprocal pair
(inverted, e.g. `CADUSD` for USDCAD). Two or more matches within one tier → **AMBIGUOUS SYMBOL**,
no data until an override is set.

## Candles

`{ instrumentId, providerSymbol, timeframe, time (UTC s), open, high, low, close,
tickVolume, realVolume (null if none), spread, source: 'mt5', isClosed, sourceTime }`.
Missing values are `null`, never `0`. Tick volume is never shown as real volume.

- Native timeframes M1, M5, M15, M30, H1, H4, D1 (no resampling).
- Configurable history (default 5000 bars/timeframe, up to 50000); the broker's limit is reported.
- The newest bar is `isClosed: false` until its period ends. **S&R only receives closed bars**;
  the forming bar only supplies the current price.
- Live: last 3 bars per timeframe are polled and upserted by time (no duplicates on rollover).
- Reconnect/restart: rediscover symbols, then resync the last `resyncBars` bars to fill gaps.

## Time

MT5 times are broker server wall-time. The bridge converts with the configured IANA zone
(DST-correct), else a tick-detected offset, else refuses (`TIMEZONE_UNRESOLVED`). The app
stores UTC only; weekend gaps are expected and flagged, other gaps are counted.

## Status codes

| Code | Meaning |
| --- | --- |
| MT5 CONNECTING | first bridge contact / discovery pending |
| MT5 BRIDGE OFFLINE | bridge unreachable or no heartbeat for 15 s |
| MT5 NOT RUNNING | bridge up, terminal closed |
| MT5 CONNECTED | terminal connected, no tick yet |
| SYMBOL NOT FOUND / AMBIGUOUS SYMBOL | discovery failed / needs an override |
| MARKET CLOSED | outside the instrument's regular hours |
| INSUFFICIENT HISTORY | fewer closed bars than the minimum |
| STALE | no tick for 60 s or bars stopped while open |
| LIVE | heartbeat, ticks and bars all fresh |
| ERROR | e.g. token rejected, broker link down, timezone unresolved |

Only LIVE and INSUFFICIENT HISTORY count as a live connection; everything else is never shown as live.
