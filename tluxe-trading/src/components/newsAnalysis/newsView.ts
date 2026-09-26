import { HEADLINE_WINDOWS, SCHEDULED_WINDOWS } from '../../engines/news/config';
import { DENVER_TZ, dayKey, sameWeek, zoneParts } from '../../engines/news/time';
import type { EventStatus, NewsEventView, Pressure, ReactionResult, RiskState } from '../../engines/news/types';
import { formatPrice } from '../../utils/format';

/* Pure display helpers for the News Analysis page (no analysis formulas — those live in engines/news). */

export const localTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export type RangeFilter = 'TODAY' | 'TOMORROW' | 'WEEK' | 'ALL';
export type ImpactFilter = 'ALL' | 'HIGH' | 'MEDIUM' | 'LOW';
export const CURRENCY_FILTERS = ['ALL', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD'] as const;
export type CurrencyFilter = (typeof CURRENCY_FILTERS)[number];

export function filterCalendar(events: readonly NewsEventView[], o: { range: RangeFilter; impact: ImpactFilter; currency: CurrencyFilter; now: number; tz: string }): NewsEventView[] {
  const today = dayKey(o.now, o.tz);
  const tomorrow = dayKey(o.now + 86_400_000, o.tz);
  return events.filter((e) => {
    if (e.kind !== 'SCHEDULED' || e.duplicateOf || e.scheduledAt === null) return false;
    if (o.impact !== 'ALL' && e.impact !== o.impact) return false;
    if (o.currency !== 'ALL' && e.currency !== o.currency) return false;
    const d = dayKey(e.scheduledAt, o.tz);
    if (o.range === 'TODAY') return d === today;
    if (o.range === 'TOMORROW') return d === tomorrow;
    if (o.range === 'WEEK') return sameWeek(e.scheduledAt, o.now, o.tz);
    return true;
  });
}

export function times(ms: number, tz = localTz()) {
  return { local: zoneParts(ms, tz), denver: zoneParts(ms, DENVER_TZ), utc: zoneParts(ms, 'UTC') };
}

export const STATUS_LABEL: Record<EventStatus, string> = { UPCOMING: 'UPCOMING', PRE_NEWS: 'PRE-NEWS', LIVE: 'LIVE', POST_NEWS: 'POST-NEWS', RELEASED: 'RELEASED', STALE: 'STALE', CANCELLED: 'CANCELLED' };
export const RISK_LABEL: Record<RiskState, string> = { NORMAL: 'NORMAL', PRE_NEWS: 'PRE-NEWS RISK', NEWS_LIVE: 'NEWS LIVE', POST_NEWS: 'POST-NEWS VOLATILITY' };
export const tone = (p: Pressure | string) => (p === 'BULLISH PRESSURE' ? 'bull' : p === 'BEARISH PRESSURE' ? 'bear' : p === 'MIXED' ? 'warn' : p === 'NEUTRAL' ? 'muted' : 'dim');
export const arrow = (p: Pressure) => (p === 'BULLISH PRESSURE' ? '▲' : p === 'BEARISH PRESSURE' ? '▼' : p === 'MIXED' ? '◆' : p === 'NEUTRAL' ? '–' : '·');
export const riskTone = (r: RiskState) => (r === 'NEWS_LIVE' ? 'bear' : r === 'PRE_NEWS' || r === 'POST_NEWS' ? 'warn' : 'bull');
export const surpriseText = (e: NewsEventView) => {
  const s = e.surprise;
  if (!s || !e.actual) return '—';
  if (s.deltaForecast === null) return s.vsForecast;
  return `${s.deltaForecast > 0 ? '+' : ''}${s.deltaForecast}${e.actual.unit === '%' ? '%' : e.actual.unit ?? ''} · ${s.vsForecast}`;
};

export interface TimelineStep {
  label: string;
  time: number | null;
  done: boolean;
  detail?: string;
}
/** Chronological life of an event (only times that exist; future steps are shown as pending). */
export function timelineOf(e: NewsEventView, r: ReactionResult | null, now: number): TimelineStep[] {
  const t0 = e.kind === 'SCHEDULED' ? e.scheduledAt : e.publishedAt;
  if (t0 === null) return [];
  const w = (e.kind === 'SCHEDULED' ? SCHEDULED_WINDOWS : HEADLINE_WINDOWS)[e.impact];
  const steps: TimelineStep[] = [];
  steps.push({ label: e.kind === 'SCHEDULED' ? 'Scheduled (first known)' : 'First received', time: e.firstReceivedAt, done: true });
  if (w.preMs) steps.push({ label: 'Pre-news window starts', time: t0 - w.preMs, done: now >= t0 - w.preMs });
  steps.push({ label: e.kind === 'SCHEDULED' ? 'Release' : 'Published', time: t0, done: now >= t0 });
  if (e.kind === 'SCHEDULED') steps.push({ label: 'Actual received', time: e.actualReceivedAt, done: e.actualKnownAt !== null, detail: e.actual ? e.actual.raw : undefined });
  for (const h of r?.horizons ?? []) steps.push({ label: h.minutes === 1 ? 'First reaction (+1 m)' : `+${h.minutes} m reaction`, time: h.time, done: h.state === 'OK', detail: h.state === 'MISSING' ? 'candle missing' : h.change === null ? undefined : `${h.change >= 0 ? '+' : ''}${h.change.toFixed(2)}` });
  if (w.postMs) steps.push({ label: 'Post-news window ends', time: t0 + w.postMs, done: now >= t0 + w.postMs });
  return steps.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
}

/** Reaction-chart markers / lines (only from a real measured reaction). */
export function reactionOverlay(r: ReactionResult | null, releaseMs: number | null, decimals: number) {
  const markers: { time: number; position: 'aboveBar' | 'belowBar'; shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square'; color: string; text: string }[] = [];
  const lines: { price: number; title: string; color: string }[] = [];
  if (!r || releaseMs === null || r.status === 'UNAVAILABLE') return { markers, lines };
  const r0 = Math.ceil(releaseMs / 60_000) * 60;
  markers.push({ time: r0, position: 'aboveBar', shape: 'arrowDown', color: '#d4a94f', text: 'RELEASE' });
  if (r.prePrice !== null) lines.push({ price: r.prePrice, title: `Pre-event ${formatPrice(r.prePrice, decimals)}`, color: '#8a93a3' });
  for (const h of r.horizons)
    if (h.state === 'OK' && h.change !== null)
      markers.push({ time: h.time / 1000 - 60, position: h.change >= 0 ? 'belowBar' : 'aboveBar', shape: 'circle', color: h.change >= 0 ? '#3cc9a0' : '#ef5d5d', text: `+${h.minutes}m ${h.change >= 0 ? '+' : ''}${formatPrice(h.change, decimals)}` });
  return { markers, lines };
}
