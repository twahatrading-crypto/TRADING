import type { SequenceStage, SmcDirection, SmcSequence, SmcTimeframeSnapshot } from './types';

type Base = Omit<SmcTimeframeSnapshot, 'sequences'>;

/*
 * SMC sequence (per timeframe) — shows which stages are ACTUALLY confirmed; unconfirmed stages stay
 * WAITING. The market is never required to follow it.
 *   anchor   the most recent sweep of the stage-1 side (bullish: SSL, bearish: BSL) within the lookback
 *            whose outcome is not 'accepted' (an accepted close-through is continuation, not a sweep);
 *            without one, stages 3–7 are searched from the start of the lookback window.
 *   1 liquidity     a SSL (BSL) pool exists — the swept pool when anchored
 *   2 sweep         the anchoring sweep (Liquidity engine)
 *   3 displacement  first same-direction displacement at / after the anchor
 *   4 CHOCH         first same-direction CHOCH at / after the anchor
 *   5 BOS           first same-direction BOS at / after the CHOCH (or the anchor)
 *   6 FVG / OB      first same-direction FVG (not invalidated) or OB at / after the anchor
 *   7 mitigation    price came back into that FVG / OB (first touch)
 */
export function buildSequences(s: Base, kt: number | null, windowSec: number): { bullish: SmcSequence; bearish: SmcSequence } {
  return { bullish: sequence(s, 'bullish', kt, windowSec), bearish: sequence(s, 'bearish', kt, windowSec) };
}

function sequence(s: Base, dir: SmcDirection, kt: number | null, windowSec: number): SmcSequence {
  const bull = dir === 'bullish';
  const side = bull ? 'SSL' : 'BSL';
  const start = kt === null ? -Infinity : kt - windowSec;
  const sweep = [...s.sweeps].reverse().find((w) => w.side === side && w.time >= start && w.outcome !== 'accepted') ?? null;
  const t0 = sweep ? sweep.time : start;
  const stage = (key: SequenceStage['key'], label: string, time: number | null, evidence: string | null): SequenceStage => ({ key, label, state: time === null ? 'WAITING' : 'CONFIRMED', time, evidence: time === null ? null : evidence });
  const pool = sweep ? s.liquidity.find((p) => p.id === sweep.poolId) : s.liquidity.find((p) => p.side === side && p.status !== 'LIQUIDITY CONSUMED');
  const disp = s.displacements.find((d) => d.direction === dir && d.confirmedAt >= t0);
  const choch = s.breaks.find((b) => b.kind === 'CHOCH' && b.direction === dir && b.confirmedAt >= t0);
  const bos = s.breaks.find((b) => b.kind === 'BOS' && b.direction === dir && b.confirmedAt >= (choch ? choch.confirmedAt : t0) && b !== choch);
  const fvg = s.fvgs.find((f) => f.direction === dir && f.state !== 'INVALIDATED' && f.confirmedAt >= t0);
  const ob = s.orderBlocks.find((b) => b.direction === dir && b.state !== 'INVALIDATED' && b.confirmedAt >= t0);
  const poi = fvg && (!ob || fvg.confirmedAt <= ob.confirmedAt) ? { t: fvg.confirmedAt, touch: fvg.firstTouchAt, text: `${dir} FVG ${fvg.lower} – ${fvg.upper}` } : ob ? { t: ob.confirmedAt, touch: ob.firstTestAt, text: `${dir} OB ${ob.low} – ${ob.high}` } : null;
  const stages: SequenceStage[] = [
    stage('liquidity', bull ? 'Sell-side liquidity' : 'Buy-side liquidity', pool ? pool.confirmedAt : null, pool ? `${pool.kind} ${pool.level} (${pool.status})` : null),
    stage('sweep', bull ? 'SSL sweep' : 'BSL sweep', sweep ? sweep.time : null, sweep ? `${sweep.side} ${sweep.level} swept by ${sweep.penetrationAtr.toFixed(2)} ATR (${sweep.kind}, ${sweep.outcome})` : null),
    stage('displacement', bull ? 'Bullish displacement' : 'Bearish displacement', disp ? disp.confirmedAt : null, disp?.evidence ?? null),
    stage('choch', bull ? 'Bullish CHOCH' : 'Bearish CHOCH', choch ? choch.confirmedAt : null, choch?.evidence ?? null),
    stage('bos', bull ? 'Bullish BOS' : 'Bearish BOS', bos ? bos.confirmedAt : null, bos?.evidence ?? null),
    stage('poi', 'FVG / Order Block', poi ? poi.t : null, poi?.text ?? null),
    stage('mitigation', 'Pullback / mitigation', poi && poi.touch !== null ? poi.touch : null, poi && poi.touch !== null ? `price returned into the ${poi.text}` : null),
  ];
  const times = stages.filter((x) => x.state === 'CONFIRMED' && x.key !== 'liquidity').map((x) => x.time!);
  return { direction: dir, timeframe: s.timeframe, stages, confirmed: stages.filter((x) => x.state === 'CONFIRMED').length, inOrder: times.every((t, k) => k === 0 || t >= times[k - 1]!), anchorTime: sweep?.time ?? null };
}
