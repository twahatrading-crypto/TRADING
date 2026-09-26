import type { Timeframe } from '../../types/market';
import { SMC_CORE_TFS, SMC_TIMEFRAMES } from './config';
import type { MatrixRow, MtfSummary, SmcConflict, SmcDirection, SmcFeed, SmcStructureState, SmcTimeframeSnapshot } from './types';

type ByTf = Partial<Record<Timeframe, SmcTimeframeSnapshot>>;
const dirOf = (s: SmcStructureState | undefined): SmcDirection | null => (s === 'BULLISH' ? 'bullish' : s === 'BEARISH' ? 'bearish' : null);
const cap = (d: SmcDirection) => (d === 'bullish' ? 'Bullish' : 'Bearish');
const OPEN_FVG = new Set(['FRESH', 'ACTIVE', 'PARTIALLY_FILLED']);

export function matrixRows(byTf: ByTf, fmt: (p: number) => string): MatrixRow[] {
  return SMC_TIMEFRAMES.map((tf) => {
    const s = byTf[tf];
    if (!s || s.dataState !== 'READY')
      return { timeframe: tf, dataState: s?.dataState ?? 'NO_DATA', state: 'UNDEFINED', lastSwing: '—', liquidity: '—', sweep: '—', bos: '—', choch: '—', displacement: '—', ob: '—', fvg: '—', premiumDiscount: '—' };
    const lastSwing = [s.lastHigh, s.lastLow].filter((x) => !!x).sort((a, b) => b!.confirmedAt - a!.confirmedAt)[0] ?? null;
    const price = s.price;
    const present = s.liquidity.filter((p) => p.status === 'LIQUIDITY PRESENT');
    const above = price === null ? null : present.filter((p) => p.side === 'BSL' && p.level > price).sort((a, b) => a.level - b.level)[0];
    const below = price === null ? null : present.filter((p) => p.side === 'SSL' && p.level < price).sort((a, b) => b.level - a.level)[0];
    const sweep = s.sweeps[s.sweeps.length - 1];
    const bos = [...s.breaks].reverse().find((b) => b.kind === 'BOS');
    const choch = [...s.breaks].reverse().find((b) => b.kind === 'CHOCH');
    const disp = s.displacements[s.displacements.length - 1];
    const liveOb = s.orderBlocks.filter((b) => b.live);
    const openF = s.fvgs.filter((f) => OPEN_FVG.has(f.state));
    const count = <T extends { direction: SmcDirection }>(xs: T[]) => {
      const b = xs.filter((x) => x.direction === 'bullish').length;
      const r = xs.length - b;
      return xs.length ? `${b} bull · ${r} bear` : '—';
    };
    return {
      timeframe: tf,
      dataState: s.dataState,
      state: s.state,
      lastSwing: lastSwing ? `${lastSwing.label ?? (lastSwing.kind === 'high' ? 'SH' : 'SL')} ${fmt(lastSwing.price)}` : '—',
      liquidity: [above ? `${above.kind} ${fmt(above.level)}` : null, below ? `${below.kind} ${fmt(below.level)}` : null].filter(Boolean).join(' · ') || '—',
      sweep: sweep ? `${sweep.side} ${fmt(sweep.level)}${sweep.reversalBreakId ? ' → reversal' : ''}` : '—',
      bos: bos ? `${cap(bos.direction)} ${fmt(bos.level)}` : '—',
      choch: choch ? `${cap(choch.direction)} ${fmt(choch.level)}` : '—',
      displacement: disp ? `${cap(disp.direction)} ${disp.netMoveAtr.toFixed(1)} ATR` : '—',
      ob: count(liveOb),
      fvg: count(openF),
      premiumDiscount: s.location ? s.location.zone.replace('_', ' ') : 'UNAVAILABLE',
    };
  });
}

/*
 * MTF aggregation — NO majority voting. Evaluated in order:
 *  DATA UNAVAILABLE   feed disconnected and no timeframe has data
 *  DATA STALE         the price feed is stale (analysis frozen at its last closed bars)
 *  INSUFFICIENT DATA  H4, H1 or M15 is not READY
 *  BULLISH ALIGNMENT  H4, H1 and M15 all BULLISH, and neither D1 nor M5 BEARISH (bearish mirrors)
 *  MIXED              a BULLISH and a BEARISH state both exist among H4 / H1 / M15
 *  WAIT               H4 and H1 agree on a direction but the lower timeframes do not confirm it,
 *                     or some core timeframe is directional with no opposite core timeframe
 *  NEUTRAL            none of D1 / H4 / H1 / M15 / M5 is directional
 * Conflicts are always listed, whatever the verdict.
 */
export function summarize(byTf: ByTf, feed: SmcFeed): MtfSummary {
  const st = (tf: Timeframe) => byTf[tf]?.dataState === 'READY' ? byTf[tf]!.state : undefined;
  const conflicts = conflictsOf(byTf);
  const any = SMC_TIMEFRAMES.some((tf) => (byTf[tf]?.barsProcessed ?? 0) > 0);
  if (!any && feed === 'DISCONNECTED') return { verdict: 'DATA UNAVAILABLE', bias: null, reason: 'No candles: the MT5 feed is not connected.', conflicts };
  if (feed === 'STALE') return { verdict: 'DATA STALE', bias: biasOf(byTf), reason: 'The price feed is stale — analysis reflects the last closed candles only.', conflicts };
  const missing = SMC_CORE_TFS.filter((tf) => byTf[tf]?.dataState !== 'READY');
  if (missing.length) return { verdict: 'INSUFFICIENT DATA', bias: null, reason: `${missing.join(', ')} ${missing.length > 1 ? 'do' : 'does'} not have enough closed candles.`, conflicts };
  const h4 = dirOf(st('H4'));
  const h1 = dirOf(st('H1'));
  const m15 = dirOf(st('M15'));
  const d1 = dirOf(st('D1'));
  const m5 = dirOf(st('M5'));
  const opp = (d: SmcDirection) => (d === 'bullish' ? 'bearish' : 'bullish');
  for (const d of ['bullish', 'bearish'] as const)
    if (h4 === d && h1 === d && m15 === d && d1 !== opp(d) && m5 !== opp(d))
      return { verdict: d === 'bullish' ? 'BULLISH ALIGNMENT' : 'BEARISH ALIGNMENT', bias: d, reason: `H4, H1 and M15 are ${d.toUpperCase()}; D1 and M5 do not oppose.`, conflicts };
  const core = [h4, h1, m15];
  if (core.includes('bullish') && core.includes('bearish')) return { verdict: 'MIXED', bias: biasOf(byTf), reason: 'Core timeframes disagree (see conflicts).', conflicts };
  if (h4 && h4 === h1) return { verdict: 'WAIT', bias: h4, reason: `H4 and H1 are ${h4.toUpperCase()}, but ${m15 !== h4 ? 'M15 has not confirmed' : d1 === opp(h4) ? 'D1 opposes' : 'M5 opposes'}.`, conflicts };
  if ([d1, h4, h1, m15, m5].every((x) => x === null)) return { verdict: 'NEUTRAL', bias: null, reason: 'No timeframe from D1 to M5 has a directional structure.', conflicts };
  return { verdict: 'WAIT', bias: biasOf(byTf), reason: 'Directional structure on some timeframes without HTF agreement.', conflicts };
}

export function biasOf(byTf: ByTf): SmcDirection | null {
  const ok = (tf: Timeframe) => (byTf[tf]?.dataState === 'READY' ? dirOf(byTf[tf]!.state) : null);
  return ok('H4') ?? ok('H1');
}

/** Explicit conflicts: opposite structure between timeframes, LTF breaks against HTF, premium / discount against the bias. */
export function conflictsOf(byTf: ByTf): SmcConflict[] {
  const out: SmcConflict[] = [];
  const ready = SMC_TIMEFRAMES.filter((tf) => byTf[tf]?.dataState === 'READY');
  for (let k = 1; k < ready.length; k++) {
    const lo = byTf[ready[k]!]!;
    const ld = dirOf(lo.state);
    if (!ld) continue;
    for (let h = k - 1; h >= 0; h--) {
      const hi = byTf[ready[h]!]!;
      const hd = dirOf(hi.state);
      if (!hd) continue;
      if (hd !== ld) out.push({ id: `struct:${hi.timeframe}:${lo.timeframe}`, severity: 'conflict', text: `${hi.timeframe} ${hi.state} vs ${lo.timeframe} ${lo.state} structure.` });
      break;
    }
  }
  for (const tf of ['M15', 'M5', 'M1'] as const) {
    const s = byTf[tf];
    if (!s || s.dataState !== 'READY') continue;
    // The latest CHOCH while the timeframe's break-trend still follows it (a later same-direction BOS keeps it).
    const last = [...s.breaks].reverse().find((b) => b.kind === 'CHOCH');
    if (!last || s.trend !== last.direction) continue;
    for (const htf of ['H4', 'H1'] as const) {
      const h = byTf[htf];
      const hd = h && h.dataState === 'READY' ? dirOf(h.state) : null;
      if (hd && hd !== last.direction) {
        out.push({ id: `choch:${tf}:${htf}`, severity: 'conflict', text: `${tf} ${last.direction} CHOCH against ${htf} ${h!.state} structure.` });
        break;
      }
    }
  }
  const bias = biasOf(byTf);
  if (bias)
    for (const tf of ['H4', 'H1'] as const) {
      const loc = byTf[tf]?.location;
      if (!loc) continue;
      if (bias === 'bullish' && (loc.zone === 'PREMIUM' || loc.zone === 'ABOVE_RANGE')) out.push({ id: `pd:${tf}`, severity: 'warning', text: `${tf} ${loc.zone.replace('_', ' ')}: price is in the upper part of the ${tf} dealing range against a bullish bias.` });
      if (bias === 'bearish' && (loc.zone === 'DISCOUNT' || loc.zone === 'BELOW_RANGE')) out.push({ id: `pd:${tf}`, severity: 'warning', text: `${tf} ${loc.zone.replace('_', ' ')}: price is in the lower part of the ${tf} dealing range against a bearish bias.` });
    }
  for (const tf of SMC_TIMEFRAMES) {
    const s = byTf[tf];
    if (!s || s.dataState !== 'READY') out.push({ id: `data:${tf}`, severity: 'info', text: `${tf}: ${s?.dataState === 'INSUFFICIENT_DATA' ? `INSUFFICIENT DATA (${s.barsProcessed}/${s.requiredBars} closed bars)` : 'no data'}.` });
    else if (s.state === 'RANGING') out.push({ id: `range:${tf}`, severity: 'info', text: `${tf} is RANGING — ${s.stateEvidence}` });
  }
  return out;
}
