/**
 * One truthful feed label for the S&R page.
 *
 *   NO_DATA           no candles at all
 *   OFFLINE           the provider is not connected (bars, if any, are the last received)
 *   CALENDAR_EXPIRED  the CME calendar cannot say whether the market is open — analysis withheld
 *   MARKET_CLOSED     schedule says closed (weekend, holiday, maintenance, early close) — last bar shown
 *   STALE             market scheduled open but no new bar for longer than `staleAfterSec`
 *   LIVE              market open and the newest bar is recent
 *
 * A bar arriving while the schedule says closed (e.g. a disputed early-close minute)
 * is reported as LIVE: received data outranks the calendar's assumption.
 */
import { marketClock } from './cmeCalendar';

export type FeedState = 'LIVE' | 'STALE' | 'MARKET_CLOSED' | 'OFFLINE' | 'NO_DATA' | 'CALENDAR_EXPIRED';

export const FEED_LABEL: Record<FeedState, string> = {
  LIVE: 'LIVE',
  STALE: 'STALE',
  MARKET_CLOSED: 'MARKET CLOSED',
  OFFLINE: 'OFFLINE',
  NO_DATA: 'NO DATA',
  CALENDAR_EXPIRED: 'CALENDAR EXPIRED',
};

export interface FeedInput {
  /** Wall clock (s). */
  now: number;
  /** Open time (s) of the newest bar of the finest timeframe (forming or closed). */
  newestBarTime: number | null;
  /** Its duration (s). */
  newestBarSeconds: number;
  connected: boolean;
  /** Newest bar older than this (after its own close) while the market is open = STALE. */
  staleAfterSec?: number;
}

export interface FeedStatus {
  state: FeedState;
  label: string;
  detail: string;
  /** Seconds since the newest bar closed (null without bars). */
  ageSec: number | null;
  /** Whether new structure / scenario confirmations can be evaluated against current data. */
  current: boolean;
}

const ago = (s: number) => (s < 120 ? `${Math.round(s)} s` : s < 7200 ? `${Math.round(s / 60)} min` : s < 172_800 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86_400).toFixed(1)} days`);
const utc = (s: number) => `${new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

export function feedStatus(i: FeedInput): FeedStatus {
  const staleAfter = i.staleAfterSec ?? 180;
  if (i.newestBarTime === null) return { state: 'NO_DATA', label: FEED_LABEL.NO_DATA, detail: 'No candles received', ageSec: null, current: false };
  const age = Math.max(0, i.now - (i.newestBarTime + i.newestBarSeconds));
  const last = `last bar ${utc(i.newestBarTime)} (${ago(age)} ago)`;
  if (!i.connected) return { state: 'OFFLINE', label: FEED_LABEL.OFFLINE, detail: `Provider not connected · ${last}`, ageSec: age, current: false };
  const clock = marketClock(i.now);
  if (clock.status === 'CALENDAR_EXPIRED') return { state: 'CALENDAR_EXPIRED', label: FEED_LABEL.CALENDAR_EXPIRED, detail: `${clock.reason} · ${last}`, ageSec: age, current: false };
  if (age <= staleAfter) return { state: 'LIVE', label: FEED_LABEL.LIVE, detail: last, ageSec: age, current: true };
  if (!clock.open) return { state: 'MARKET_CLOSED', label: FEED_LABEL.MARKET_CLOSED, detail: `${clock.reason || 'Outside CME trading hours'} · ${last}`, ageSec: age, current: false };
  return { state: 'STALE', label: FEED_LABEL.STALE, detail: `Market open but no new bar · ${last}`, ageSec: age, current: false };
}
