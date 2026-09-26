import { ACTUAL_TIMEOUT_MS, ASSET_DIMENSION, CATEGORY_ASSETS, CURRENCY_ASSETS, DUPLICATE_WINDOW_MS, HEADLINE_WINDOWS, INDICATORS, MATRIX_ASSETS, NEWS_ASSETS, SCHEDULED_WINDOWS } from './config';
import { aggregates, conflictList, groupAggregates } from './conflicts';
import { classifyImpact, implications } from './impact';
import { riskFor } from './riskWindow';
import { surprise } from './surprise';
import type { EventStatus, MatrixColumn, MatrixRow, NewsCategory, NewsEventView, NewsSnapshot, NewsUpdate, NewsValue, Revision } from './types';
import { sameValue } from './values';

/* ============================================================================
 * NEWS ENGINE — POINT-IN-TIME. It stores every normalized update (never merged destructively) and
 * derives the state at any time T only from updates with knownAt ≤ T:
 *   - news published after T does not exist at T
 *   - an Actual is absent until the update carrying it is known
 *   - a revision (new Previous / Actual) applies only from its own knownAt; the original is kept
 * snapshot(T) is a pure function of (updates known by T, T) → re-running history to T gives the
 * same result as the live state at T (audited in audit.ts).
 * ========================================================================== */

const signature = (u: NewsUpdate) =>
  JSON.stringify([u.key, u.knownAt, u.title, u.scheduledAt, u.publishedAt, u.providerImpact, u.category, u.currency, u.forecast?.raw, u.previous?.raw, u.actual?.raw, u.cancelled ?? false]);

export function affectedOf(currency: string | null, category: NewsCategory, tagged: readonly string[]): string[] {
  const set = new Set<string>([...(currency ? (CURRENCY_ASSETS[currency] ?? []) : []), ...(CATEGORY_ASSETS[category] ?? []), ...tagged]);
  const order = NEWS_ASSETS as readonly string[];
  return [...set].sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)) || (a < b ? -1 : 1));
}

export function statusOf(e: Pick<NewsEventView, 'kind' | 'cancelled' | 'impact' | 'scheduledAt' | 'publishedAt' | 'actual' | 'forecast' | 'previous' | 'indicator'>, T: number): EventStatus {
  if (e.cancelled) return 'CANCELLED';
  if (e.kind === 'HEADLINE') {
    const w = HEADLINE_WINDOWS[e.impact];
    const d = T - (e.publishedAt ?? T);
    return d < w.liveMs ? 'LIVE' : d < w.postMs ? 'POST_NEWS' : 'RELEASED';
  }
  const r = e.scheduledAt!;
  const w = SCHEDULED_WINDOWS[e.impact];
  if (T < r - w.preMs) return 'UPCOMING';
  if (T < r) return 'PRE_NEWS';
  const meta = e.indicator ? INDICATORS.find((m) => m.key === e.indicator) : undefined;
  const numeric = !!(e.forecast || e.previous) && meta?.direction !== 'NONE';
  if (numeric && !e.actual && T >= r + ACTUAL_TIMEOUT_MS) return 'STALE';
  if (T < r + w.liveMs) return 'LIVE';
  if (T < r + w.postMs) return 'POST_NEWS';
  return 'RELEASED';
}

const dupKey = (e: NewsEventView) => `${e.currency ?? '-'}|${e.title.toLowerCase().replace(/\s+/g, ' ')}|${Math.round((e.scheduledAt ?? 0) / DUPLICATE_WINDOW_MS)}`;

export class NewsEngine {
  private updates: NewsUpdate[] = [];
  private readonly seen = new Set<string>();
  /** Exact duplicate deliveries dropped (same provider event, same content, same knownAt). */
  duplicatesDropped = 0;

  ingest(u: NewsUpdate): boolean {
    const s = signature(u);
    if (this.seen.has(s)) {
      this.duplicatesDropped += 1;
      return false;
    }
    this.seen.add(s);
    this.updates.push(u);
    return true;
  }
  ingestAll(us: readonly NewsUpdate[]): void {
    for (const u of us) this.ingest(u);
  }
  allUpdates(): readonly NewsUpdate[] {
    return this.updates;
  }

  /** The updates visible at T (point-in-time filter). */
  protected visible(T: number): NewsUpdate[] {
    return this.updates.filter((u) => u.knownAt <= T);
  }

  eventsAt(T: number): NewsEventView[] {
    const groups = new Map<string, { u: NewsUpdate; i: number }[]>();
    this.visible(T).forEach((u, i) => {
      let g = groups.get(u.key);
      if (!g) groups.set(u.key, (g = []));
      g.push({ u, i });
    });
    const views: NewsEventView[] = [];
    for (const g of groups.values()) {
      g.sort((a, b) => a.u.knownAt - b.u.knownAt || a.i - b.i);
      views.push(this.merge(g.map((x) => x.u), T));
    }
    // Cross-provider duplicates of the same scheduled release: the first provider (by id) is kept.
    const byDup = new Map<string, NewsEventView>();
    for (const v of [...views].sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.key < b.key ? -1 : 1))) {
      if (v.kind !== 'SCHEDULED') continue;
      const k = dupKey(v);
      const first = byDup.get(k);
      if (first) v.duplicateOf = first.key;
      else byDup.set(k, v);
    }
    return views.sort((a, b) => (a.scheduledAt ?? a.publishedAt ?? 0) - (b.scheduledAt ?? b.publishedAt ?? 0) || (a.key < b.key ? -1 : 1));
  }

  private merge(us: NewsUpdate[], T: number): NewsEventView {
    const first = us[0]!;
    const last = us[us.length - 1]!;
    let forecast: NewsValue | null = null;
    let previous: NewsValue | null = null;
    let actual: NewsValue | null = null;
    let actualKnownAt: number | null = null;
    let actualReceivedAt: number | null = null;
    let cancelled = false;
    const revisions: Revision[] = [];
    let origPrev: NewsValue | null = null;
    let origActual: NewsValue | null = null;
    const tagged = new Set<string>();
    const lastDefined = <K extends keyof NewsUpdate>(k: K) => {
      for (let j = us.length - 1; j >= 0; j--) if (us[j]![k] !== null && us[j]![k] !== undefined) return us[j]![k];
      return null;
    };
    for (const u of us) {
      u.instruments.forEach((x) => tagged.add(x));
      if (u.cancelled) cancelled = true;
      if (u.forecast) forecast = u.forecast;
      if (u.previous) {
        if (previous && !sameValue(previous, u.previous)) revisions.push({ field: 'previous', original: origPrev ?? previous, revised: u.previous, revisedAt: u.knownAt });
        if (!origPrev) origPrev = u.previous;
        previous = u.previous;
      }
      if (u.actual) {
        if (actual && !sameValue(actual, u.actual)) revisions.push({ field: 'actual', original: origActual ?? actual, revised: u.actual, revisedAt: u.knownAt });
        if (!actual) {
          actualKnownAt = u.knownAt;
          actualReceivedAt = u.receivedAt;
          origActual = u.actual;
        }
        actual = u.actual;
      }
    }
    const category = (lastDefined('category') as NewsCategory | null) ?? first.category;
    const indicator = (lastDefined('indicator') as string | null) ?? null;
    const imp = classifyImpact({ providerImpact: (lastDefined('providerImpact') as NewsUpdate['providerImpact']) ?? null, indicator, category });
    const currency = (lastDefined('currency') as string | null) ?? null;
    const base = {
      kind: first.kind,
      cancelled,
      impact: imp.impact,
      scheduledAt: (lastDefined('scheduledAt') as number | null) ?? null,
      publishedAt: (lastDefined('publishedAt') as number | null) ?? null,
      actual,
      forecast,
      previous,
      indicator,
    };
    const sur = first.kind === 'SCHEDULED' ? surprise(indicator, actual, forecast, previous) : null;
    return {
      key: first.key,
      provider: first.provider,
      providerKind: first.providerKind,
      providerEventId: first.providerEventId,
      kind: first.kind,
      title: last.title,
      country: us.map((u) => u.country).filter(Boolean).pop() ?? null,
      currency,
      category,
      indicator,
      impact: imp.impact,
      impactSource: imp.source,
      impactRule: imp.rule,
      scheduledAt: base.scheduledAt,
      publishedAt: base.publishedAt,
      firstKnownAt: first.knownAt,
      firstReceivedAt: Math.min(...us.map((u) => u.receivedAt)),
      lastKnownAt: last.knownAt,
      sourceUrl: us.map((u) => u.sourceUrl).filter(Boolean).pop() ?? null,
      forecast,
      previous,
      actual,
      actualKnownAt,
      actualReceivedAt,
      revisions,
      cancelled,
      affected: affectedOf(currency, category, [...tagged].sort()),
      status: statusOf(base, T),
      latency: last.latency,
      duplicateOf: null,
      updates: us.length,
      surprise: sur,
      implications: implications({ kind: first.kind, currency, category, indicator, impact: imp.impact, interpretation: sur?.interpretation ?? null, hasActual: !!actual }),
    };
  }

  snapshot(T: number): NewsSnapshot {
    const events = this.eventsAt(T);
    const live = events.filter((e) => !e.duplicateOf);
    const calendar = events.filter((e) => e.kind === 'SCHEDULED');
    const headlines = events.filter((e) => e.kind === 'HEADLINE').sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0) || (a.key < b.key ? -1 : 1));
    const nextHigh =
      live
        .filter((e) => e.kind === 'SCHEDULED' && e.impact === 'HIGH' && !e.cancelled && e.scheduledAt! + SCHEDULED_WINDOWS.HIGH.liveMs > T)
        .sort((a, b) => a.scheduledAt! - b.scheduledAt! || (a.key < b.key ? -1 : 1))[0] ?? null;
    const risk = Object.fromEntries((NEWS_ASSETS as readonly string[]).map((a) => [a, riskFor(a, live, T)]));
    const aggs = aggregates(live, T);
    const byGroup = groupAggregates(live, T);
    const matrix: MatrixRow[] = MATRIX_ASSETS.map((asset) => {
      const dim = ASSET_DIMENSION[asset]!;
      const cells = { current: aggs[dim] } as MatrixRow['cells'];
      for (const col of Object.keys(byGroup) as Exclude<MatrixColumn, 'current'>[]) cells[col] = byGroup[col][dim];
      return { asset, dimension: dim, cells };
    });
    return { time: T, events, calendar, headlines, nextHigh, risk, aggregates: aggs, byGroup, matrix, conflicts: conflictList(aggs), duplicates: events.filter((e) => e.duplicateOf).length };
  }
}
