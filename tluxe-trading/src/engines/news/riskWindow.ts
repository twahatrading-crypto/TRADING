import { ASSET_DIMENSION, HEADLINE_WINDOWS, RISK_IMPACTS, SCHEDULED_WINDOWS } from './config';
import type { InstrumentRisk, NewsEventView, RiskReason, RiskState } from './types';

/*
 * NEWS RISK WINDOWS (HIGH impact only, config RISK_IMPACTS):
 *   scheduled release r:  PRE_NEWS [r − 30 min, r) · NEWS_LIVE [r, r + 15 min) · POST_NEWS [r + 15 min, r + 90 min)
 *   HIGH headline at p:   NEWS_LIVE [p, p + 15 min) · POST_NEWS [p + 15 min, p + 60 min)
 * An instrument's state is the most severe active window of the events that affect it
 * (NEWS_LIVE > PRE_NEWS > POST_NEWS > NORMAL); every active window is listed as a reason, so
 * overlapping events are all visible. Cancelled events never create windows. This module only
 * EXPOSES the state — it never blocks trading.
 */
const SEVERITY: Record<RiskState, number> = { NORMAL: 0, POST_NEWS: 1, PRE_NEWS: 2, NEWS_LIVE: 3 };
const WORD: Record<Exclude<RiskState, 'NORMAL'>, string> = { PRE_NEWS: 'PRE-NEWS', NEWS_LIVE: 'NEWS LIVE', POST_NEWS: 'POST-NEWS VOLATILITY' };

export function windowsOf(e: NewsEventView): RiskReason[] {
  if (e.cancelled || e.duplicateOf || !RISK_IMPACTS.includes(e.impact)) return [];
  const anchor = e.kind === 'SCHEDULED' ? e.scheduledAt : e.publishedAt;
  if (anchor === null) return [];
  const w = (e.kind === 'SCHEDULED' ? SCHEDULED_WINDOWS : HEADLINE_WINDOWS)[e.impact];
  const out: RiskReason[] = [];
  const add = (state: Exclude<RiskState, 'NORMAL'>, from: number, to: number) => {
    if (to > from) out.push({ eventKey: e.key, title: e.title, state, from, to, text: `${WORD[state]}: ${e.impact} ${e.title}${e.currency ? ` (${e.currency})` : ''}` });
  };
  add('PRE_NEWS', anchor - w.preMs, anchor);
  add('NEWS_LIVE', anchor, anchor + w.liveMs);
  add('POST_NEWS', anchor + w.liveMs, anchor + w.postMs);
  return out;
}

export function riskFor(asset: string, events: readonly NewsEventView[], T: number): InstrumentRisk {
  const active: RiskReason[] = [];
  for (const e of events) {
    if (!e.affected.includes(asset)) continue;
    for (const r of windowsOf(e)) if (r.from <= T && T < r.to) active.push(r);
  }
  active.sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state] || a.from - b.from || (a.eventKey < b.eventKey ? -1 : 1));
  const state: RiskState = active[0]?.state ?? 'NORMAL';
  const until = active.filter((r) => r.state === state).reduce<number | null>((m, r) => (m === null || r.to > m ? r.to : m), null);
  return { instrumentId: asset, state, reasons: active, until };
}

export const knownAsset = (a: string) => a in ASSET_DIMENSION || /^[A-Z]{6}$/.test(a);
