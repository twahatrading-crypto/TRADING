import { HEAT_STOPS } from '../../engines/orderFlowPro/config';
import type { ScheduleState } from '../../engines/orderFlowPro/nyTime';
import type { FeedState, SourceStatus } from '../../engines/orderFlowPro/types';

export const fmtNum = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 10_000) return `${(v / 1000).toFixed(1)}K`;
  if (a >= 1000) return `${(v / 1000).toFixed(2)}K`;
  return String(Math.round(v));
};
export const fmtSigned = (v: number) => `${v > 0 ? '+' : ''}${fmtNum(v)}`;
export const fmtUtcTime = (t: number, ms = false) => new Date(t).toISOString().slice(11, ms ? 23 : 19);
export const fmtExpiry = (yyyymmdd: string) => (/^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` : yyyymmdd || '—');

export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'demo';

export interface DepthFreshness {
  /** The displayed book may be presented as CURRENT liquidity. */
  current: boolean;
  /** LIVE · QUIET · STALE · DISCONNECTED · UNAVAILABLE · CONTRACT_MISMATCH · NO_BOOK · RECORDED (replay). */
  state: string;
  label: string;
  tone: Tone;
  detail: string | null;
}

/**
 * ONE rule for every depth view (chart liquidity overlay, Order Book panel, Liquidity Strength panel): the book is
 * current only while it is valid AND the depth stream is LIVE / QUIET (gateway source) and the feed has no contract
 * mismatch. Anything else is labelled with its state and is never shown as current liquidity.
 */
export function depthFreshness(s: SourceStatus, bookValid: boolean, replay = false): DepthFreshness {
  if (replay) return { current: false, state: 'RECORDED', label: 'RECORDED (replay)', tone: 'muted', detail: 'Recorded IBKR depth bucket averages - not the live book' };
  const d = s.provenance?.depth;
  if (s.feed === 'CONTRACT_MISMATCH') return { current: false, state: 'CONTRACT_MISMATCH', label: 'DEPTH CONTRACT MISMATCH', tone: 'bad', detail: 'Depth withheld: contracts are never mixed' };
  if (d) {
    const live = d.state === 'LIVE' || d.state === 'QUIET';
    if (live && bookValid) return { current: true, state: d.state, label: d.state === 'QUIET' ? 'DEPTH LIVE · QUIET' : 'DEPTH LIVE', tone: 'ok', detail: d.detail };
    if (live) return { current: false, state: 'NO_BOOK', label: 'DEPTH RE-SYNCING', tone: 'warn', detail: d.detail ?? 'waiting for a fresh IBKR snapshot' };
    return { current: false, state: d.state, label: `DEPTH ${d.state.replace('_', ' ')}`, tone: d.state === 'STALE' ? 'warn' : 'bad', detail: d.detail };
  }
  return bookValid
    ? { current: true, state: 'LIVE', label: 'DEPTH LIVE', tone: 'ok', detail: null }
    : { current: false, state: 'NO_BOOK', label: 'NO VALID BOOK', tone: 'muted', detail: null };
}

/** Label + tone for a feed state. Only LIVE + REALTIME ever gets the green LIVE label. */
export function feedLabel(s: SourceStatus): { text: string; tone: Tone; detail: string } {
  const f: FeedState = s.feed;
  switch (f) {
    case 'LIVE': {
      if (s.marketDataType !== 'REALTIME') return { text: s.marketDataType ?? 'UNKNOWN TYPE', tone: 'warn', detail: 'Not real-time market data' };
      const p = s.provenance;
      if (p) {
        // Gateway source: trades decide LIVE; depth is reported separately and never upgrades the label.
        const depthOk = p.depth.state === 'LIVE' || p.depth.state === 'QUIET';
        const depthNote = depthOk ? '' : ` · DEPTH ${p.depth.state.replace('_', ' ')}`;
        if (p.trades.state === 'QUIET')
          return { text: `LIVE · QUIET${depthNote}`, tone: depthOk ? 'ok' : 'warn', detail: `Databento reports live; no CME trade for ${Math.round((p.trades.ageMs ?? 0) / 1000)} s (quiet market - not a gap)${depthOk ? '' : ` · depth: ${p.depth.detail ?? p.depth.state}`}` };
        return { text: `LIVE${depthNote}`, tone: depthOk ? 'ok' : 'warn', detail: `Databento CME trades (exchange time) via the TLUXE gateway${depthOk ? ' · IBKR price-level depth' : ` · depth: ${p.depth.detail ?? p.depth.state}`}` };
      }
      if (s.health?.activity === 'QUIET')
        return { text: 'LIVE · QUIET', tone: 'ok', detail: `Connected and subscribed; no market-data change for ${Math.round((s.health.quietForMs ?? 0) / 1000)} s (quiet market - not a gap)` };
      return { text: 'LIVE', tone: 'ok', detail: 'IBKR real-time market data' };
    }
    case 'DELAYED':
      return { text: 'DELAYED', tone: 'warn', detail: 'IBKR delayed market data (type 3) - not real-time' };
    case 'FROZEN':
      return { text: 'FROZEN', tone: 'warn', detail: 'IBKR frozen market data (type 2) - last values, not streaming' };
    case 'DELAYED_FROZEN':
      return { text: 'DELAYED FROZEN', tone: 'warn', detail: 'IBKR delayed-frozen market data (type 4)' };
    case 'STALE':
      return { text: 'STALE', tone: 'warn', detail: s.provenance ? (s.provenance.trades.detail ?? 'No fresh gateway data') : 'Subscribed, but no events within the stale window' };
    case 'CONNECTING':
      return { text: 'CONNECTING', tone: 'muted', detail: s.provenance ? 'Connecting to the TLUXE gateway market data' : 'Connecting to IB Gateway' };
    case 'DISCONNECTED':
      return { text: 'DISCONNECTED', tone: 'bad', detail: s.provenance?.trades.detail ?? 'Gateway market data not reachable' };
    case 'UNAVAILABLE':
      return { text: 'DATA UNAVAILABLE', tone: 'bad', detail: s.provenance?.trades.detail ?? 'No usable market data from the gateway' };
    case 'CONTRACT_MISMATCH':
      return { text: 'CONTRACT MISMATCH', tone: 'bad', detail: s.provenance?.trades.detail ?? 'Sources report different contracts - nothing combined' };
    case 'AUTH_REQUIRED':
      return { text: 'GATEWAY LOGIN REQUIRED', tone: 'bad', detail: 'IB Gateway is running but its API refuses connections' };
    case 'NOT_ENTITLED':
      return { text: 'NOT ENTITLED', tone: 'bad', detail: 'IBKR reports no market-data permission for this request' };
    case 'IDENTITY_UNCONFIRMED':
      return { text: 'IBKR IDENTITY NOT CONFIRMED', tone: 'bad', detail: 'Backend will not connect until TLUXE_OFP_IB_IDENTITY_ACK confirms a separate IBKR username from the production VPS' };
    case 'ACCOUNT_UNVERIFIED':
      return { text: 'ACCOUNT NOT VERIFIED', tone: 'bad', detail: 'IB Gateway did not report its account(s) in time - paper/live cannot be verified, disconnected (retrying)' };
    case 'COMPETING_SESSION':
      return { text: 'COMPETING IBKR SESSION', tone: 'bad', detail: 'IBKR 10197: this IBKR username is receiving market data in another session - Order Flow Pro stopped requesting and will not retry by itself' };
    case 'MODE_MISMATCH':
      return { text: 'PAPER / LIVE MISMATCH', tone: 'bad', detail: 'IB Gateway is logged in to a different account mode than configured - disconnected, not retried' };
    case 'GATEWAY_OFFLINE':
      return { text: 'GATEWAY OFFLINE', tone: 'bad', detail: 'IB Gateway API socket not reachable' };
    case 'DISABLED':
      return { text: 'IBKR CONNECTION DISABLED', tone: 'muted', detail: 'The backend is configured not to connect to IB Gateway' };
    case 'DEMO':
      return { text: 'DEMO · NOT LIVE', tone: 'demo', detail: 'Synthetic fixture for visual testing - not market data' };
    case 'BACKEND_OFFLINE':
    default:
      return { text: 'BACKEND OFFLINE', tone: 'muted', detail: 'Order Flow Pro backend not reachable' };
  }
}

/** CSS gradient of the heatmap intensity palette (legend). */
export const HEAT_LEGEND = HEAT_STOPS.map(([s, r, g, b]) => `rgb(${r},${g},${b}) ${s * 100}%`).join(', ');

/** Schedule-only wording: never "market open" (holidays, early closes and halts are not known). */
export function scheduleLabel(s: ScheduleState): { text: string; tone: Tone } {
  if (s === 'IN_SCHEDULE') return { text: 'inside scheduled Globex hours', tone: 'muted' };
  if (s === 'DAILY_BREAK') return { text: 'scheduled daily break (17:00–18:00 ET)', tone: 'warn' };
  return { text: 'outside scheduled hours (weekend)', tone: 'warn' };
}
