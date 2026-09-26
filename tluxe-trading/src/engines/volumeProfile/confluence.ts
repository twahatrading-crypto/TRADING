import type { SRZone } from '../sr/types';
import type { SmcSnapshot } from '../smc/types';
import type { ConfluenceItem, KeyLevel, VPSnapshot } from './types';

/*
 * READ-ONLY CONFLUENCE between Volume Profile levels and OTHER engines' existing output (never
 * mutated, never re-detected here). A level and another engine's object are confluent when the
 * object's price is within confluenceAtr × ATR of the level, or the level lies inside the object's zone.
 * Sources: SMC snapshot (its Liquidity-engine pools / sweeps, Order-Block-engine blocks, FVG, BOS /
 * CHOCH, premium / discount) and the S&R engine's zones. Timeframes used: M15 and H1.
 * Confluence is information — never a BUY / SELL signal.
 */
export function confluence(vp: VPSnapshot, smc: SmcSnapshot | null, srZones: readonly SRZone[] | null, tolAtr: number): ConfluenceItem[] {
  const atr = vp.atr;
  if (!atr || !vp.keyLevels.length) return [];
  const tol = tolAtr * atr;
  const levels: KeyLevel[] = vp.keyLevels.filter((l) => l.kind === 'POC' || l.kind === 'VAH' || l.kind === 'VAL' || l.state === 'ACTIVE' || l.state === 'TESTED');
  const near = (p: number, lvl: number) => Math.abs(p - lvl) <= tol;
  const inZone = (lo: number, hi: number, lvl: number) => lvl >= lo - tol && lvl <= hi + tol;
  const out: ConfluenceItem[] = [];
  const add = (l: KeyLevel, withWhat: string, engine: string, detail: string, strength: ConfluenceItem['strength']) => out.push({ id: `${l.id}|${withWhat}|${detail}`, level: l.label, price: l.price, with: withWhat, engine, detail, strength });
  for (const l of levels) {
    for (const tf of ['H1', 'M15'] as const) {
      const s = smc?.byTimeframe[tf];
      if (!s || s.dataState !== 'READY') continue;
      for (const p of s.liquidity)
        if (p.status === 'LIQUIDITY PRESENT' && near(p.level, l.price)) add(l, `${p.kind} ${tf}`, 'Liquidity engine (via SMC)', `${p.kind} pool ${p.level} (score ${p.score})`, l.kind === 'VAH' && p.side === 'BSL' ? 'High' : l.kind === 'VAL' && p.side === 'SSL' ? 'High' : 'Medium');
      for (const w of s.sweeps.slice(-6)) if (near(w.level, l.price)) add(l, `${w.side} sweep ${tf}`, 'Liquidity engine (via SMC)', `${w.side} ${w.level} swept (${w.outcome})${w.reversalBreakId ? ' → CHOCH' : ''}`, w.reversalBreakId ? 'High' : 'Medium');
      for (const b of s.orderBlocks) if (b.live && inZone(b.low, b.high, l.price)) add(l, `${b.direction === 'bullish' ? 'Bullish' : 'Bearish'} OB ${tf}`, 'Order Block engine (via SMC)', `OB ${b.low}–${b.high} ${b.state}`, 'Medium');
      for (const g of s.fvgs) if ((g.state === 'FRESH' || g.state === 'ACTIVE' || g.state === 'PARTIALLY_FILLED') && inZone(g.lower, g.upper, l.price)) add(l, `${g.direction} FVG ${tf}`, 'SMC engine', `FVG ${g.lower}–${g.upper} (${Math.round(g.fillPct)}% filled)`, 'Medium');
      const lastBreak = s.breaks[s.breaks.length - 1];
      if (lastBreak && near(lastBreak.level, l.price)) add(l, `${lastBreak.direction} ${lastBreak.kind} ${tf}`, 'SMC engine', lastBreak.evidence, lastBreak.kind === 'CHOCH' ? 'High' : 'Medium');
      if (s.location && s.range && (l.kind === 'VAH' || l.kind === 'VAL') && near(l.kind === 'VAH' ? s.range.high : s.range.low, l.price)) add(l, `dealing range ${l.kind === 'VAH' ? 'high' : 'low'} ${tf}`, 'SMC engine', `${s.range.direction} dealing range ${s.range.low}–${s.range.high}`, 'Medium');
    }
    for (const z of srZones ?? []) if (z.status !== 'BROKEN' && z.status !== 'EXPIRED' && inZone(z.zoneLow, z.zoneHigh, l.price)) add(l, `${z.role} ${z.timeframe}`, 'S&R engine', `${z.role} zone ${z.zoneLow}–${z.zoneHigh} (${z.status}, score ${z.score.total})`, z.score.total >= 70 ? 'High' : 'Medium');
  }
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))).sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'High' ? -1 : 1) || a.price - b.price);
}
