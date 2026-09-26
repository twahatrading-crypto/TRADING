import type { Candle } from '../../types/market';
import { REACTION_HORIZONS, REACTION_PRE_MAX_MS } from './config';
import type { ReactionHorizon, ReactionResult } from './types';

/*
 * OBSERVED REACTION from REAL closed M1 candles known at T (a candle is known once it CLOSED):
 *   r0         the release time rounded UP to the minute
 *   pre        close of the last M1 candle closing in [r0 − 5 min, r0]; none → REACTION DATA UNAVAILABLE
 *   +h min     close of the M1 candle closing exactly at r0 + h (h = 1, 5, 15, 30, 60);
 *              not closed yet at T → PENDING; closed time passed but candle absent → MISSING (never filled)
 *   max up / max down   highest high − pre / pre − lowest low of known candles in (r0, r0 + 60 min]
 *   volatility expansion  mean range of the first ≤ 15 post candles / mean range of ≤ 30 pre candles (≥ 10 needed)
 *   displacement          largest body of the first ≤ 15 post candles / mean true range of the 14 pre candles
 *   pattern     +5 and +60 moves same sign → CONTINUATION, opposite → REVERSAL;
 *               retrace % = (move5 − move60) / move5 × 100 when both exist
 */
const MIN = 60_000;
const closeMs = (c: Candle) => (c.time + 60) * 1000;

export function measureReaction(instrumentId: string, releaseMs: number, m1: readonly Candle[], T: number): ReactionResult {
  const r0 = Math.ceil(releaseMs / MIN) * MIN;
  const known = m1.filter((c) => closeMs(c) <= T);
  const empty = (status: ReactionResult['status'], reason: string): ReactionResult => ({ instrumentId, status, reason, preTime: null, prePrice: null, horizons: [], maxUp: null, maxDown: null, volExpansion: null, displacementAtr: null, pattern: null, retracePct: null });
  if (T < r0 - REACTION_PRE_MAX_MS) return empty('PENDING', 'Release has not happened yet.');
  let pre: Candle | null = null;
  for (const c of known) if (closeMs(c) <= r0 && closeMs(c) >= r0 - REACTION_PRE_MAX_MS) pre = c;
  if (!pre) return empty('UNAVAILABLE', 'REACTION DATA UNAVAILABLE — no M1 candle closed within 5 min before the release.');
  const byClose = new Map(known.map((c) => [closeMs(c), c]));
  const horizons: ReactionHorizon[] = REACTION_HORIZONS.map((h) => {
    const t = r0 + h * MIN;
    if (t > T) return { minutes: h, time: t, price: null, change: null, changePct: null, state: 'PENDING' };
    const c = byClose.get(t);
    if (!c) return { minutes: h, time: t, price: null, change: null, changePct: null, state: 'MISSING' };
    const change = c.close - pre!.close;
    return { minutes: h, time: t, price: c.close, change, changePct: (change / pre!.close) * 100, state: 'OK' };
  });
  const post = known.filter((c) => closeMs(c) > r0 && closeMs(c) <= r0 + 60 * MIN);
  const preSet = known.filter((c) => closeMs(c) <= r0).slice(-30);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const maxUp = post.length ? Math.max(...post.map((c) => c.high)) - pre.close : null;
  const maxDown = post.length ? pre.close - Math.min(...post.map((c) => c.low)) : null;
  const first15 = post.slice(0, 15);
  const preRange = preSet.length >= 10 ? avg(preSet.map((c) => c.high - c.low)) : null;
  const postRange = first15.length ? avg(first15.map((c) => c.high - c.low)) : null;
  const pre14 = preSet.slice(-14);
  const tr = pre14.map((c, i) => {
    const p = i ? pre14[i - 1]! : null;
    return p ? Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)) : c.high - c.low;
  });
  const atr = pre14.length >= 10 ? avg(tr) : null;
  const h5 = horizons.find((h) => h.minutes === 5)!;
  const h60 = horizons.find((h) => h.minutes === 60)!;
  const pattern = h5.change !== null && h60.change !== null && h5.change !== 0 && h60.change !== 0 ? (Math.sign(h5.change) === Math.sign(h60.change) ? 'CONTINUATION' : 'REVERSAL') : null;
  const oks = horizons.filter((h) => h.state === 'OK').length;
  const missing = horizons.some((h) => h.state === 'MISSING');
  const status: ReactionResult['status'] = oks === horizons.length ? 'COMPLETE' : oks === 0 && !missing ? 'PENDING' : 'PARTIAL';
  return {
    instrumentId,
    status,
    reason: missing ? 'Some reaction candles are missing (market closed / data gap) — never filled.' : null,
    preTime: closeMs(pre),
    prePrice: pre.close,
    horizons,
    maxUp,
    maxDown,
    volExpansion: preRange && postRange !== null && preRange > 0 ? postRange / preRange : null,
    displacementAtr: atr && first15.length ? Math.max(...first15.map((c) => Math.abs(c.close - c.open))) / atr : null,
    pattern,
    retracePct: h5.change && h60.change !== null ? ((h5.change - h60.change) / h5.change) * 100 : null,
  };
}
