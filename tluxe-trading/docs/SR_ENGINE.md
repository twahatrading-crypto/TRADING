# Support & Resistance Engine #1 — rules

Source: `src/engines/sr/` (pure TypeScript, no React). All constants live in
`settings.ts`. Distances are ATR multiples of the zone's own timeframe
(Wilder ATR, `atrPeriod` = 14), so the same rules apply to GC, EURUSD, BTCUSD…
The only absolute distance is `minZoneTicks` × instrument tick size.

Pipeline: candles → closed bars → ATR → confirmed pivots → zone (frozen) or
cluster → per-bar interaction episodes → state machine → score → per-TF
snapshot → MTF confluence → UI.

## Bars
Only **closed** bars are analysed. By default the newest candle is treated as
forming and only sets `currentPrice`. If already-analysed history changes the
engine rebuilds from scratch (deterministic). Gaps > `gapToleranceBars` bar
lengths are reported in `snapshot.gaps`, never filled.

## Pivots (default L = 3, R = 3)
Swing low at bar c: `low[c] < low[j]` for the L bars before and `low[c] ≤ low[j]`
for the R bars after. Swing high mirrors. Confirmed on the close of bar c + R;
`pivotTime` = time of c, `confirmedAt` = time of c + R.

## Zone boundaries (frozen at confirmation)
`minW = max(zoneMinAtr·ATR, minZoneTicks·tick)`, ATR = ATR at confirmation.
- wickBody (default): support `width = clamp(min(open,close)[c] − low[c], minW, max(minW, zoneMaxAtr·ATR))`,
  `zoneLow = low[c]`, `zoneHigh = low[c] + width`. Resistance: `zoneHigh = high[c]`, `zoneLow = high[c] − width`
  (body edge = max(open,close)).
- atr: `width = max(minW, zoneAtrMultiplier·ATR)` from the extreme.
Definition objects are `Object.freeze`d.

## Clustering
A new pivot joins an existing **holding** zone of the same current role if the
gap between the candidate zone and that zone ≤ `clusterToleranceAtr`·ATR
(overlap = gap 0). Closest midpoint wins (ties → older). The existing zone's
boundaries do not change; the pivot is added to `sourcePivotIds`.

## Interactions (support frame; resistance is mirrored)
F = facing edge (support: zoneHigh), L = far edge (support: zoneLow), ATR = this bar.
- **Touch episode** starts when `low ≤ F + touchToleranceAtr·ATR` and ends when
  `low > F + touchSeparationAtr·ATR`. One episode = one touch, however many bars.
- **Rejection**: within `rejectionWindowBars` of the start, a **close** ≥ F +
  `rejectionMinAtr`·ATR(start). Otherwise resolved as not rejected (also if a new
  episode starts first). Recorded: penetration, close location, bars to rejection,
  close-based rejection distance, high-based max excursion.
- **Sweep**: wick below `L − sweepMinAtr·ATR`, then a close ≥ L within
  `sweepReclaimBars` (same bar allowed), with no close beyond the break
  threshold in the episode.
- **Close-through**: a close < `L − breakToleranceAtr·ATR` later followed by a
  close back above that threshold before a break confirms.
- **Break**: `breakConfirmCloses` consecutive closes < `L − breakToleranceAtr·ATR`,
  or one close < `L − breakDisplacementAtr·ATR`. A wick alone never breaks.
  `brokenAt` + `breakEvidence` (rule, closes, times, threshold, ATR) recorded.
- Outcome precedence: break > closeThrough > sweep > rejection > touch (pending until resolved).

## Flip
After a break the zone is evaluated in the opposite role. The retest is
**armed** only after price moves ≥ `touchSeparationAtr`·ATR away on the new side.
The next episode that is a rejection (same rule) within `flipWindowBars`
flips the role (`FLIPPED`, `flippedAt`, `roleHistory`); the zone id and full
history are kept. A confirmed break back through cancels the flip candidacy.

## States
| From | Allowed to |
| --- | --- |
| FRESH | ACTIVE, BROKEN, EXPIRED |
| ACTIVE | TESTED, WEAKENING, BROKEN |
| TESTED | ACTIVE, WEAKENING, BROKEN, EXPIRED |
| WEAKENING | ACTIVE, BROKEN, EXPIRED |
| BROKEN | FLIPPED, EXPIRED |
| FLIPPED | BROKEN, EXPIRED |
| EXPIRED | — |

ACTIVE = episode open. WEAKENING (sticky while holding) = resolved touches ≥
`weakeningTouches`, or any close-through, or the last two resolved touches not
rejections. EXPIRED = holding and idle > `expiryBars`, or broken and not flipped
within `flipWindowBars`. Enforced at runtime (`assertTransition`).

## Score (0–100)
Components (each 0–100):
- timeframe: M1 20, M5 35, M15 50, M30 60, H1 70, H4 85, D1 100
- reaction: `100·min(1, mean(formation excursions + resolved rejection distances, ATR) / reactionFullAtr)`
- touchQuality: 50 if untested; else `100·(rejections/resolved)·(1 − 0.5·mean penetration ratio) − 15·close-throughs`
- freshness: `100·freshnessDecay^resolved·(1 − 0.5·min(1, barsSinceLast/expiryBars))`
- structure: `100·(0.6·min(1, prominence/structureFullAtr) + 0.4·min(1, (pivots − 1)/2))`
- confluence: `min(100, 50·(timeframes − 1))`

Weights: timeframe 0.20, reaction 0.25, touchQuality 0.15, freshness 0.15,
structure 0.15, confluence 0.10. `total = round(clamp(Σ w·c × statusFactor))`,
statusFactor: FRESH/ACTIVE/TESTED 1, FLIPPED 0.9, WEAKENING 0.8, BROKEN 0.3, EXPIRED 0.2.

## Multi-timeframe confluence
Each timeframe is analysed independently first. Holding zones are taken as
anchors (higher TF, then score, then id). For each other timeframe the best
same-role zone whose overlap with the running intersection ≥
`confluenceMinOverlap` × min(widths) joins; the intersection narrows. ≥ 2
timeframes → confluence (`zoneIds`, `timeframes`, `overlapLow/High`,
`score = min(100, round(mean member base score + 10·(TFs − 1)))`). A zone joins at most one.

## Display (UI only)
ALL TF / chart: drop EXPIRED (and BROKEN unless filtered for), drop score <
`minDisplayScore`, rank by `score − 4·min(distanceAtr, 10)`, skip zones
overlapping a shown same-role zone by ≥ 60 %, keep `maxDisplayedZones`.
Engine state is never modified.

## Anti-repaint
`replaySR()` feeds candles one at a time and fails on any change to a
confirmed zone's frozen fields, disappearing zones, events dated after the
newest closed bar, or illegal transitions. Tests also prove incremental ==
batch and that different futures agree on everything confirmed before them.

No BUY/SELL/LONG/SHORT output exists anywhere in the engine.
