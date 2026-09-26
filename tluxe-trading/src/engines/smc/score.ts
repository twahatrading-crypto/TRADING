import type { Timeframe } from '../../types/market';
import { SMC_SCORE_CAP_MISSING, SMC_SCORE_WEIGHTS, type SmcScoreKey } from './config';
import type { MtfSummary, SmcDirection, SmcScore, SmcTimeframeSnapshot } from './types';

type ByTf = Partial<Record<Timeframe, SmcTimeframeSnapshot>>;

/*
 * SMC CONFLUENCE SCORE (0–100) = Σ weight × component / 100, weights in SMC_SCORE_WEIGHTS (total 100):
 *   HTF Structure 15   H4 and H1 in the direction: 2 → 100, 1 → 50, 0 → 0; D1 opposite −25
 *   Liquidity 10       +50 opposite-side liquidity PRESENT ahead of price (bullish: BSL above) on H1 / M15;
 *                      +50 same-side liquidity swept within the lookback on M15 / H1 (bullish: SSL)
 *   Sweep 10           that sweep on M15 (else H1): followed by a CHOCH (reversal) 100, reclaimed 80,
 *                      returned 60, pending 40, accepted (continuation) 0
 *   BOS / CHOCH 15     last M15 break in the direction 60; last H1 break in the direction +40
 *   Displacement 10    M15 displacement in the direction since the anchor: used by a break 100, else 60;
 *                      only on H1: 50
 *   Order Block 10     live OB in the direction on M15 / H1: price inside or ≤ 1 ATR away 100, else 60
 *   FVG 10             open FVG in the direction on M15 / H1: price inside or ≤ 1 ATR away 100, else 60
 *   Premium/Disc. 10   H1 range (else H4): bullish DISCOUNT 100, EQUILIBRIUM 50, BELOW RANGE 30,
 *                      PREMIUM / ABOVE 0 (bearish mirrors); no valid dealing range → 0
 *   MTF Alignment 10   ALIGNMENT in the direction 100; WAIT with this bias 50; otherwise 0
 * Mandatory structural evidence: HTF Structure > 0 AND BOS / CHOCH > 0. If either is missing the score
 * is CAPPED at 40 and the missing evidence is listed. No score without H4 / H1 / M15 data.
 * It is a confluence / analysis measure — NOT a probability of winning, expected profit or a signal.
 */
export const SMC_SCORE_NOTE = 'Confluence / analysis score — not a probability of winning, not expected profit, not a trade signal.';

const OPEN_FVG = new Set(['FRESH', 'ACTIVE', 'PARTIALLY_FILLED']);

export function smcScore(byTf: ByTf, summary: MtfSummary): SmcScore {
  const empty = Object.fromEntries(Object.keys(SMC_SCORE_WEIGHTS).map((k) => [k, 0])) as Record<SmcScoreKey, number>;
  const noEv = Object.fromEntries(Object.keys(SMC_SCORE_WEIGHTS).map((k) => [k, '—'])) as Record<SmcScoreKey, string>;
  if (summary.verdict === 'INSUFFICIENT DATA' || summary.verdict === 'DATA UNAVAILABLE')
    return { direction: null, components: empty, evidence: noEv, weights: SMC_SCORE_WEIGHTS, total: null, uncapped: null, missing: [], note: `${summary.verdict} — no score. ${SMC_SCORE_NOTE}` };
  const dirs: SmcDirection[] = summary.bias ? [summary.bias] : ['bullish', 'bearish'];
  const scored = dirs.map((d) => scoreFor(byTf, summary, d));
  return scored.sort((a, b) => (b.total ?? 0) - (a.total ?? 0))[0]!;
}

function scoreFor(byTf: ByTf, summary: MtfSummary, dir: SmcDirection): SmcScore {
  const c = {} as Record<SmcScoreKey, number>;
  const e = {} as Record<SmcScoreKey, string>;
  const bullS = dir === 'bullish' ? 'BULLISH' : 'BEARISH';
  const oppS = dir === 'bullish' ? 'BEARISH' : 'BULLISH';
  const R = (tf: Timeframe) => (byTf[tf]?.dataState === 'READY' ? byTf[tf]! : null);
  const h4 = R('H4');
  const h1 = R('H1');
  const m15 = R('M15');
  const d1 = R('D1');

  const n = [h4, h1].filter((s) => s?.state === bullS).length;
  c.htfStructure = Math.max(0, (n === 2 ? 100 : n === 1 ? 50 : 0) - (d1?.state === oppS ? 25 : 0));
  e.htfStructure = `H4 ${h4?.state ?? '—'} · H1 ${h1?.state ?? '—'}${d1?.state === oppS ? ` · D1 ${oppS} (−25)` : ''}`;

  const ahead = [h1, m15].some((s) => s && s.price !== null && s.liquidity.some((p) => p.status === 'LIQUIDITY PRESENT' && (dir === 'bullish' ? p.side === 'BSL' && p.level > s.price! : p.side === 'SSL' && p.level < s.price!)));
  const seqOf = (s: SmcTimeframeSnapshot | null) => (s ? s.sequences[dir] : null);
  const swept = [m15, h1].map((s) => seqOf(s)).find((q) => q && q.anchorTime !== null) ?? null;
  c.liquidity = (ahead ? 50 : 0) + (swept ? 50 : 0);
  e.liquidity = `${ahead ? `${dir === 'bullish' ? 'BSL above' : 'SSL below'} present` : 'no target liquidity ahead'} · ${swept ? `${dir === 'bullish' ? 'SSL' : 'BSL'} swept (${swept.timeframe})` : 'no recent sweep'}`;

  const sweepSrc = [m15, h1].find((s) => s && s.sequences[dir].anchorTime !== null) ?? null;
  const sw = sweepSrc ? [...sweepSrc.sweeps].reverse().find((w) => w.time === sweepSrc.sequences[dir].anchorTime && w.side === (dir === 'bullish' ? 'SSL' : 'BSL')) : undefined;
  c.sweep = !sw ? 0 : sw.reversalBreakId ? 100 : sw.reclaimed ? 80 : sw.outcome === 'returned' ? 60 : sw.outcome === 'pending' ? 40 : 0;
  e.sweep = sw ? `${sweepSrc!.timeframe} ${sw.side} ${sw.outcome}${sw.reversalBreakId ? ' → CHOCH' : ''}` : 'no sweep';

  const lastBreak = (s: SmcTimeframeSnapshot | null) => (s ? s.breaks[s.breaks.length - 1] : undefined);
  const b15 = lastBreak(m15);
  const b1 = lastBreak(h1);
  c.bosChoch = (b15?.direction === dir ? 60 : 0) + (b1?.direction === dir ? 40 : 0);
  e.bosChoch = `M15 ${b15 ? `${b15.direction} ${b15.kind}` : '—'} · H1 ${b1 ? `${b1.direction} ${b1.kind}` : '—'}`;

  const since = (s: SmcTimeframeSnapshot | null) => (s ? (s.sequences[dir].anchorTime ?? -Infinity) : -Infinity);
  const d15 = m15 ? [...m15.displacements].reverse().find((d) => d.direction === dir && d.confirmedAt >= since(m15)) : undefined;
  const dH1 = h1 ? [...h1.displacements].reverse().find((d) => d.direction === dir && d.confirmedAt >= since(h1)) : undefined;
  c.displacement = d15 ? (d15.breakId ? 100 : 60) : dH1 ? 50 : 0;
  e.displacement = d15 ? `M15 ${d15.netMoveAtr.toFixed(2)} ATR${d15.breakId ? ' with break' : ''}` : dH1 ? `H1 ${dH1.netMoveAtr.toFixed(2)} ATR` : 'none';

  const near = (s: SmcTimeframeSnapshot, lo: number, hi: number) => s.price !== null && s.atr !== null && s.price >= lo - s.atr && s.price <= hi + s.atr;
  let ob = 0;
  let obTxt = 'none';
  let fv = 0;
  let fvTxt = 'none';
  for (const s of [m15, h1]) {
    if (!s) continue;
    for (const b of s.orderBlocks)
      if (b.live && b.direction === dir) {
        const v = near(s, b.low, b.high) ? 100 : 60;
        if (v > ob) [ob, obTxt] = [v, `${s.timeframe} ${b.state} ${v === 100 ? '(price at / near)' : ''}`.trim()];
      }
    for (const f of s.fvgs)
      if (OPEN_FVG.has(f.state) && f.direction === dir) {
        const v = near(s, f.lower, f.upper) ? 100 : 60;
        if (v > fv) [fv, fvTxt] = [v, `${s.timeframe} ${f.state.replace('_', ' ')} ${v === 100 ? '(price at / near)' : ''}`.trim()];
      }
  }
  c.orderBlock = ob;
  e.orderBlock = obTxt;
  c.fvg = fv;
  e.fvg = fvTxt;

  const locSrc = h1?.location ? h1 : h4?.location ? h4 : null;
  const z = locSrc?.location?.zone;
  const good = dir === 'bullish' ? 'DISCOUNT' : 'PREMIUM';
  const beyondGood = dir === 'bullish' ? 'BELOW_RANGE' : 'ABOVE_RANGE';
  c.premiumDiscount = !z ? 0 : z === good ? 100 : z === 'EQUILIBRIUM' ? 50 : z === beyondGood ? 30 : 0;
  e.premiumDiscount = locSrc ? `${locSrc.timeframe} ${z!.replace('_', ' ')} (${locSrc.location!.pct.toFixed(0)}%)` : 'DEALING RANGE UNAVAILABLE';

  const aligned = summary.verdict === (dir === 'bullish' ? 'BULLISH ALIGNMENT' : 'BEARISH ALIGNMENT');
  c.mtfAlignment = aligned ? 100 : summary.verdict === 'WAIT' && summary.bias === dir ? 50 : 0;
  e.mtfAlignment = summary.verdict;

  let raw = 0;
  for (const k of Object.keys(SMC_SCORE_WEIGHTS) as SmcScoreKey[]) raw += (SMC_SCORE_WEIGHTS[k] * c[k]) / 100;
  const uncapped = Math.round(raw);
  const missing: string[] = [];
  if (c.htfStructure === 0) missing.push(`HTF structure (H4 / H1) is not ${bullS}`);
  if (c.bosChoch === 0) missing.push(`no ${dir} BOS / CHOCH on M15 or H1`);
  const total = missing.length ? Math.min(uncapped, SMC_SCORE_CAP_MISSING) : uncapped;
  return {
    direction: dir,
    components: c,
    evidence: e,
    weights: SMC_SCORE_WEIGHTS,
    total,
    uncapped,
    missing,
    note: `${missing.length ? `Capped at ${SMC_SCORE_CAP_MISSING}: mandatory structural evidence missing. ` : ''}${summary.verdict === 'DATA STALE' ? 'DATA STALE — last closed candles only. ' : ''}${SMC_SCORE_NOTE}`,
  };
}
