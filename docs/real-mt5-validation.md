# Real MT5 validation – evidence

Generated 2026-10-04T10:19:20Z by `python -m xau.validate report` · commit `3c78e0af1eb5a70fa57c20bdbfcc855bb4e06d26`

Every section states its **data source**. Only evidence produced by the real `MetaTrader5` package on the user's Windows PC counts as **REAL MT5 DATA**. Anything from the automated test-suite is **TEST/SYNTHETIC DATA** (hand-built candles through an MT5 test double) and never ticks a gate item.

## Completion gate

- [ ] Real MT5 connection
- [ ] Real XAUUSD ticks
- [ ] Real broker specifications
- [ ] M1 verified
- [ ] M5 verified
- [ ] M15 verified
- [ ] H1 verified
- [ ] H4 verified
- [ ] D1 verified
- [ ] Broker timezone verified
- [ ] Asian High/Low verified
- [ ] PDH/PDL verified
- [ ] Live candle close processing verified
- [ ] No duplicate candle processing
- [ ] STALE protection verified
- [ ] Disconnect/reconnect verified
- [ ] Same live/backtest engine confirmed
- [ ] Baseline backtest completed
- [x] 81+ existing tests still pass

**1/19 proven.** Phase NOT complete – see the PENDING/FAIL items.

## 1. MT5 connection, symbol and broker specification
**PENDING** – run `python -m xau.validate preflight` on the Windows PC.

## 2. Broker server time
**PENDING** – run `python -m xau.validate timezone` on the Windows PC.

## 3. OHLC: dashboard vs MT5
**PENDING** – run `python -m xau.validate ohlc` on the Windows PC.

## 4. Liquidity levels
**PENDING** – run `python -m xau.validate levels` on the Windows PC.

## 5. State machine on real data (progressions and rejections)
**PENDING** – run `python -m xau.validate statemachine` on the Windows PC.

## 6. Live updates and exactly-once candle processing
**PENDING** – run `python -m xau.validate live` on the Windows PC.

## 7. Stale / disconnect / reconnect
**PENDING** – run `python -m xau.validate disconnect` on the Windows PC.

## 8. BASELINE backtest (frozen, default rules)
**PENDING** – run `python -m xau.validate baseline` on the Windows PC.

## 9. Automated tests

`93 passed, 1 skipped in 35.89s` on Linux 6.18.44-fc-v64 (commit `3c78e0af1eb5a70fa57c20bdbfcc855bb4e06d26`), real-history replay: skipped (no export)

These tests use **TEST/SYNTHETIC DATA** (hand-built candles, MT5 test double). They prove rule logic, no look-ahead, live/backtest parity and stale handling in code; they are not market evidence.

## 10. Screenshots

Save real screenshots (Win+Shift+S) to `docs/validation/screenshots/` with the time in the file name:
`live-dashboard.png`, `mt5-vs-dashboard-M5.png`, `stale.png`, `offline.png`, `reconnected.png`, `levels-chart.png`.

**PENDING** – no screenshots yet.
