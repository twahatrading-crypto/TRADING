import type { NewsProviderInfo, RawCalendarEvent, RawHeadline } from '../../providers/news/types';
import { INDICATORS, type IndicatorMeta } from './config';
import type { NewsCategory, NewsImpact, NewsUpdate } from './types';
import { parseTime, parseValue } from './values';

/* Provider payload → point-in-time NewsUpdate. Invalid rows are dropped (returned null), never
 * repaired with guessed values. knownAt = the moment TLUXE RECEIVED the information: a replay to T
 * then contains exactly what the live system had at T (provider timestamps are kept as metadata —
 * scheduledAt / publishedAt — but never make information known earlier than it arrived). */

const CATEGORY_ALIASES: Record<string, NewsCategory> = {
  'central bank': 'CENTRAL_BANK', centralbank: 'CENTRAL_BANK', central_bank: 'CENTRAL_BANK', fed: 'CENTRAL_BANK', monetary: 'CENTRAL_BANK',
  inflation: 'INFLATION', prices: 'INFLATION',
  employment: 'EMPLOYMENT', labor: 'EMPLOYMENT', labour: 'EMPLOYMENT', jobs: 'EMPLOYMENT',
  growth: 'GROWTH', economy: 'GROWTH', economic: 'GROWTH', gdp: 'GROWTH',
  rates: 'RATES', bonds: 'RATES', yields: 'RATES', treasury: 'RATES',
  usd: 'USD_FX', fx: 'USD_FX', forex: 'USD_FX', currency: 'USD_FX',
  geopolitical: 'GEOPOLITICAL', geopolitics: 'GEOPOLITICAL', politics: 'GEOPOLITICAL', war: 'GEOPOLITICAL', sanctions: 'GEOPOLITICAL',
  metals: 'METALS', gold: 'METALS', silver: 'METALS', comex: 'METALS',
  crypto: 'CRYPTO', cryptocurrency: 'CRYPTO', bitcoin: 'CRYPTO',
};
export function categoryOf(raw: string | null | undefined, fallback: NewsCategory): NewsCategory {
  if (!raw) return fallback;
  return CATEGORY_ALIASES[raw.trim().toLowerCase()] ?? fallback;
}
export function impactOf(raw: RawCalendarEvent['impact']): NewsImpact | null {
  if (!raw) return null;
  const u = String(raw).toUpperCase();
  return u === 'HIGH' || u === 'MEDIUM' || u === 'LOW' ? u : null;
}
export function indicatorOf(title: string): IndicatorMeta | null {
  return INDICATORS.find((m) => m.patterns.some((p) => p.test(title))) ?? null;
}
const cur = (c: string | null | undefined) => (c && /^[A-Za-z]{3}$/.test(c.trim()) ? c.trim().toUpperCase() : null);
const ctry = (c: string | null | undefined) => (c && c.trim() ? c.trim().toUpperCase() : null);

export function normalizeCalendar(e: RawCalendarEvent, info: NewsProviderInfo, receivedAt: number): NewsUpdate | null {
  if (!e || !e.id || !e.title?.trim()) return null;
  const scheduledAt = parseTime(e.time);
  if (scheduledAt === null) return null;
  const title = e.title.trim();
  const meta = indicatorOf(title);
  const updated = parseTime(e.updatedAt ?? null);
  const u: NewsUpdate = {
    key: `${info.id}:${e.id}`,
    provider: info.id,
    providerKind: info.kind,
    providerEventId: String(e.id),
    kind: 'SCHEDULED',
    title,
    country: ctry(e.country),
    currency: cur(e.currency),
    category: categoryOf(e.category, meta?.category ?? 'OTHER'),
    indicator: meta?.key ?? null,
    providerImpact: impactOf(e.impact),
    scheduledAt,
    publishedAt: updated,
    receivedAt,
    knownAt: receivedAt,
    sourceUrl: e.url ?? null,
    instruments: [...new Set((e.instruments ?? []).map((x) => x.toUpperCase()))],
    latency: info.latency,
  };
  // Only fields the provider actually sent are part of this update.
  if ('forecast' in e) u.forecast = parseValue(e.forecast);
  if ('previous' in e) u.previous = parseValue(e.previous);
  if ('actual' in e) u.actual = parseValue(e.actual);
  if (e.cancelled) u.cancelled = true;
  return u;
}

export function normalizeHeadline(h: RawHeadline, info: NewsProviderInfo, receivedAt: number): NewsUpdate | null {
  if (!h || !h.id || !h.headline?.trim()) return null;
  const publishedAt = parseTime(h.publishedAt);
  if (publishedAt === null) return null;
  const title = h.headline.trim();
  return {
    key: `${info.id}:${h.id}`,
    provider: info.id,
    providerKind: info.kind,
    providerEventId: String(h.id),
    kind: 'HEADLINE',
    title,
    country: ctry(h.country),
    currency: cur(h.currency),
    category: categoryOf(h.category, 'OTHER'),
    indicator: null,
    providerImpact: impactOf(h.impact),
    scheduledAt: null,
    publishedAt,
    receivedAt,
    // Known when received — and never before its publication time.
    knownAt: Math.max(receivedAt, publishedAt),
    sourceUrl: h.url ?? null,
    instruments: [...new Set((h.instruments ?? []).map((x) => x.toUpperCase()))],
    latency: info.latency,
  };
}
