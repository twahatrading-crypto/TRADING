import type { NewsEventView, NewsSnapshot } from '../../../engines/news/types';
import type { AiField, AiNewsContext, AiNewsItem } from './types';

/*
 * Bounded, read-only NEWS context for TLUXE AI, built from the News Analysis store (which holds ONLY provider data).
 * Every item carries its evidence key (provider:eventId) and provider; values are the provider's raw text.
 * Relevance to the selected instrument uses the engine's own `affected` mapping (USD → XAUUSD / GC / SI / crypto /
 * FX pairs, EUR → EURUSD, METALS → XAU / XAG / GC / SI, CRYPTO → BTC / ETH / SOL, …) — storage is never filtered.
 * No usable calendar or headline feed → UNAVAILABLE (the AI must say so, never fill it in).
 */

export const AI_NEWS_LIMITS = { next: 5, today: 10, released: 8, headlines: 8 } as const;

interface FeedLike {
  provider: string | null;
  status: string;
  detail: string | null;
  lastMessageAt: number | null;
  test?: boolean;
}
export interface NewsStateLike {
  now: number;
  feeds: Record<'calendar' | 'breaking' | 'macro', FeedLike>;
  snapshot: NewsSnapshot;
}

const usable = (f: FeedLike | undefined) => !!f && !!f.provider && !f.test && (f.status === 'LIVE' || f.status === 'DELAYED' || f.status === 'STALE');
const rank: Record<string, number> = { LIVE: 3, DELAYED: 2, STALE: 1 };

/** Instruments without their own news mapping use their closest mapped asset (presentation only). */
const ALIAS: Record<string, string> = { XAUUSD: 'XAUUSD', GC: 'GC', XAGUSD: 'XAGUSD', SI: 'SI' };

function item(e: NewsEventView, instrument: string): AiNewsItem {
  return {
    key: e.key,
    provider: e.provider,
    title: e.title.slice(0, 160),
    kind: e.kind,
    currency: e.currency,
    country: e.country,
    impact: e.impact,
    time: e.kind === 'SCHEDULED' ? e.scheduledAt : e.publishedAt,
    status: e.status,
    actual: e.actual?.raw ?? null,
    forecast: e.forecast?.raw ?? null,
    previous: e.previous?.raw ?? null,
    surpriseVsForecast: e.actual ? (e.surprise?.vsForecast ?? null) : null,
    sourceUrl: e.sourceUrl,
    affectedSelected: e.affected.includes(ALIAS[instrument] ?? instrument),
  };
}

export function buildNewsContext(st: NewsStateLike | undefined, instrument: string): AiField<AiNewsContext> {
  const src = 'TLUXE News Analysis (provider data)';
  if (!st) return { status: 'UNAVAILABLE', source: src, asOf: null, reason: 'News Analysis not available.' };
  const feeds = st.feeds;
  const calOk = usable(feeds.calendar);
  const newsOk = usable(feeds.breaking) || usable(feeds.macro);
  const feedView = (f: FeedLike) => ({ status: f.test ? 'TEST_DATA_REFUSED' : f.status, provider: f.provider, lastMessageAt: f.lastMessageAt, detail: f.detail ? f.detail.slice(0, 160) : null });
  if (!calOk && !newsOk) {
    return { status: 'UNAVAILABLE', source: src, asOf: null, reason: `No news provider is delivering data (calendar ${feeds.calendar.status}, breaking ${feeds.breaking.status}, macro ${feeds.macro.status}).` };
  }
  const now = st.now;
  const s = st.snapshot;
  const rel = (e: NewsEventView) => e.affected.includes(ALIAS[instrument] ?? instrument);
  const calendar = calOk ? s.calendar.filter((e) => !e.cancelled && !e.duplicateOf) : [];
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const upcoming = calendar.filter((e) => e.scheduledAt !== null && e.scheduledAt >= now - 60_000).sort((a, b) => a.scheduledAt! - b.scheduledAt!);
  const nextHighImpact = upcoming.filter((e) => e.impact === 'HIGH' && rel(e)).slice(0, AI_NEWS_LIMITS.next);
  const today = calendar
    .filter((e) => e.scheduledAt !== null && e.scheduledAt >= dayStart && e.scheduledAt < dayStart + 86_400_000 && e.impact !== 'LOW' && rel(e))
    .sort((a, b) => a.scheduledAt! - b.scheduledAt!)
    .slice(0, AI_NEWS_LIMITS.today);
  const recentReleases = calendar
    .filter((e) => e.actual && e.scheduledAt !== null && e.scheduledAt <= now && rel(e))
    .sort((a, b) => b.scheduledAt! - a.scheduledAt!)
    .slice(0, AI_NEWS_LIMITS.released);
  const headlines = newsOk ? s.headlines.filter((h) => rel(h) || h.impact === 'HIGH').sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0)).slice(0, AI_NEWS_LIMITS.headlines) : [];
  const risk = calOk ? s.risk[ALIAS[instrument] ?? instrument] ?? null : null;
  const best = Math.max(calOk ? rank[feeds.calendar.status] ?? 0 : 0, usable(feeds.breaking) ? rank[feeds.breaking.status] ?? 0 : 0, usable(feeds.macro) ? rank[feeds.macro.status] ?? 0 : 0);
  return {
    status: best === 3 ? 'LIVE' : best === 2 ? 'DELAYED' : 'STALE',
    source: src,
    asOf: now,
    ...(calOk ? {} : { reason: 'Economic calendar unavailable — risk windows and scheduled events are unknown.' }),
    value: {
      label: 'OBSERVED PROVIDER DATA (not AI interpretation)',
      feeds: { calendar: feedView(feeds.calendar), breaking: feedView(feeds.breaking), macro: feedView(feeds.macro) },
      risk: risk ? { state: risk.state, reasons: risk.reasons.slice(0, 3).map((r) => ({ eventKey: r.eventKey, title: r.title.slice(0, 120), state: r.state, from: r.from, to: r.to })) } : null,
      nextHighImpact: nextHighImpact.map((e) => item(e, instrument)),
      today: today.map((e) => item(e, instrument)),
      recentReleases: recentReleases.map((e) => item(e, instrument)),
      headlines: headlines.map((e) => item(e, instrument)),
    },
  };
}
