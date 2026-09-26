import { COLUMN_CATEGORIES, DIMENSIONS, DRIVER_LOOKBACK_MS } from './config';
import type { Aggregate, Dimension, Driver, MatrixColumn, NewsEventView } from './types';

/*
 * CURRENT PRESSURE / CONFLICTS (no voting, no weighting):
 *   drivers = events known at T, not cancelled / duplicate, impact HIGH or MEDIUM, whose release
 *   (scheduled) or publication (headline) lies in [T − 24 h, T], with a BULLISH or BEARISH
 *   expected effect on the dimension.
 *   none → NEUTRAL · all bullish → BULLISH PRESSURE · all bearish → BEARISH PRESSURE ·
 *   both present → MIXED with CONFLICTING DRIVERS (every driver listed). A single MIXED driver → MIXED.
 */
export function driversOf(events: readonly NewsEventView[], T: number, dim: Dimension, cats?: readonly string[]): Driver[] {
  const out: Driver[] = [];
  for (const e of events) {
    if (e.cancelled || e.duplicateOf || e.impact === 'LOW') continue;
    if (cats && !cats.includes(e.category)) continue;
    const t = e.kind === 'SCHEDULED' ? e.scheduledAt : e.publishedAt;
    if (t === null || t > T || t < T - DRIVER_LOOKBACK_MS) continue;
    const imp = e.implications[dim];
    if (imp.state !== 'BULLISH PRESSURE' && imp.state !== 'BEARISH PRESSURE' && imp.state !== 'MIXED') continue;
    out.push({ eventKey: e.key, title: e.title, category: e.category, impact: e.impact, time: t, state: imp.state, evidence: imp.evidence });
  }
  return out.sort((a, b) => b.time - a.time || (a.eventKey < b.eventKey ? -1 : 1));
}

export function aggregate(drivers: Driver[]): Aggregate {
  if (!drivers.length) return { state: 'NEUTRAL', drivers, conflict: false, evidence: 'No qualifying HIGH / MEDIUM driver in the last 24 h.' };
  const bull = drivers.filter((d) => d.state === 'BULLISH PRESSURE');
  const bear = drivers.filter((d) => d.state === 'BEARISH PRESSURE');
  if (bull.length && bear.length)
    return { state: 'MIXED', drivers, conflict: true, evidence: `CONFLICTING DRIVERS — bullish: ${bull.map((d) => d.title).join(', ')}; bearish: ${bear.map((d) => d.title).join(', ')}.` };
  if (bull.length && !drivers.some((d) => d.state === 'MIXED')) return { state: 'BULLISH PRESSURE', drivers, conflict: false, evidence: bull.map((d) => d.title).join(', ') };
  if (bear.length && !drivers.some((d) => d.state === 'MIXED')) return { state: 'BEARISH PRESSURE', drivers, conflict: false, evidence: bear.map((d) => d.title).join(', ') };
  return { state: 'MIXED', drivers, conflict: false, evidence: `Competing effects within: ${drivers.map((d) => d.title).join(', ')}.` };
}

export function aggregates(events: readonly NewsEventView[], T: number): Record<Dimension, Aggregate> {
  return Object.fromEntries(DIMENSIONS.map((d) => [d, aggregate(driversOf(events, T, d))])) as Record<Dimension, Aggregate>;
}

export function groupAggregates(events: readonly NewsEventView[], T: number): Record<Exclude<MatrixColumn, 'current'>, Record<Dimension, Aggregate>> {
  const out = {} as Record<Exclude<MatrixColumn, 'current'>, Record<Dimension, Aggregate>>;
  for (const [col, cats] of Object.entries(COLUMN_CATEGORIES) as [Exclude<MatrixColumn, 'current'>, readonly string[]][])
    out[col] = Object.fromEntries(DIMENSIONS.map((d) => [d, aggregate(driversOf(events, T, d, cats))])) as Record<Dimension, Aggregate>;
  return out;
}

/** Human-readable cross-dimension conflicts (e.g. inflation supports USD while jobs weaken it). */
export function conflictList(aggs: Record<Dimension, Aggregate>): string[] {
  return DIMENSIONS.filter((d) => aggs[d].conflict).map((d) => `${d}: ${aggs[d].evidence}`);
}
