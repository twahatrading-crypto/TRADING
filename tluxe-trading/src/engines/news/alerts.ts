import { ACTUAL_TIMEOUT_MS, ALERT_FRESH_MS } from './config';
import type { NewsAlert, NewsAlertType, NewsEventView } from './types';

/*
 * ALERTS (alert-READY events; delivery channels are separate and optional):
 *   HIGH_IMPACT_IN_30 / _15 / _5  a HIGH scheduled event's release − 30 / 15 / 5 min is crossed
 *   NEWS_RELEASED                 a HIGH scheduled event's release time is crossed
 *   ACTUAL_AVAILABLE              an Actual (HIGH / MEDIUM) becomes known
 *   BREAKING_HIGH_IMPACT          a HIGH headline is published
 * A condition's effective moment is c = max(condition time, time the event became known to TLUXE).
 * The first evaluation marks every condition already true as seen (recovered, never alerted). After
 * that, an unseen condition with c ≤ now fires once when c is at most 2 min old AND
 * the data proving it arrived at most 2 min after c (recovered history / late backfill never fires —
 * it is recorded as suppressed). ACTUAL_AVAILABLE additionally requires that the event was known
 * BEFORE its release (tracked live) and that the Actual arrived within 15 min of the release. The first evaluation after start only establishes the baseline.
 * Dedupe key: provider:providerEventId:type — each alert fires at most once, ever.
 */
export class NewsAlertTracker {
  private started = false;
  private readonly fired = new Set<string>();
  readonly suppressed: { id: string; reason: string }[] = [];

  evaluate(events: readonly NewsEventView[], now: number): NewsAlert[] {
    const baseline = !this.started;
    this.started = true;
    const out: NewsAlert[] = [];
    for (const e of events) {
      if (e.cancelled || e.duplicateOf) continue;
      const conds: [NewsAlertType, number | null, number, string][] = [];
      if (e.kind === 'SCHEDULED' && e.scheduledAt !== null && e.impact === 'HIGH') {
        for (const m of [30, 15, 5] as const) conds.push([`HIGH_IMPACT_IN_${m}` as NewsAlertType, e.scheduledAt - m * 60_000, e.firstReceivedAt, `HIGH IMPACT IN ${m} MIN: ${e.title}`]);
        conds.push(['NEWS_RELEASED', e.scheduledAt, e.firstReceivedAt, `NEWS RELEASED: ${e.title}`]);
      }
      if (e.kind === 'SCHEDULED' && e.actual && e.actualKnownAt !== null && e.impact !== 'LOW')
        conds.push(['ACTUAL_AVAILABLE', e.actualKnownAt, e.actualReceivedAt ?? e.actualKnownAt, `ACTUAL AVAILABLE: ${e.title} ${e.actual.raw}${e.surprise ? ` (${e.surprise.vsForecast})` : ''}`]);
      if (e.kind === 'HEADLINE' && e.impact === 'HIGH' && e.publishedAt !== null) conds.push(['BREAKING_HIGH_IMPACT', e.publishedAt, e.firstReceivedAt, `BREAKING HIGH-IMPACT NEWS: ${e.title}`]);
      for (const [type, cond, arrived, message] of conds) {
        if (cond === null) continue;
        const at = Math.max(cond, e.firstKnownAt);
        if (at > now) continue;
        const id = `${e.provider}:${e.providerEventId}:${type}`;
        if (this.fired.has(id)) continue;
        this.fired.add(id);
        if (baseline) {
          this.suppressed.push({ id, reason: 'already true when TLUXE started — recovered history' });
          continue;
        }
        const recoveredActual = type === 'ACTUAL_AVAILABLE' && (e.scheduledAt === null || e.firstReceivedAt > e.scheduledAt || at - e.scheduledAt > ACTUAL_TIMEOUT_MS);
        if (now - at > ALERT_FRESH_MS || arrived - cond > ALERT_FRESH_MS || recoveredActual) {
          this.suppressed.push({ id, reason: 'recovered / late data — not a live alert' });
          continue;
        }
        out.push({ id, type, eventKey: e.key, title: e.title, at, raisedAt: now, message });
      }
    }
    return out;
  }
}
