/**
 * Session key levels for GC on CME trading days (see cmeCalendar.ts):
 *   PDH / PDL   previous CME trading day (18:00 ET D-1 → 17:00 ET D), holidays skipped
 *   PWH / PWL   previous CME week (its trading days)
 *   ASIA H / L  the latest Asia window that has started (configurable; exact boundaries labelled)
 *   day open / day high / day low (current session, forming) · ADR(14) over complete CME days
 *
 * Levels come ONLY from real closed candles. A window is measured from the finest
 * timeframe whose bars cover it, and its coverage is checked on boundaries and
 * contiguity (never by counting bars): first bar near the window start, at most
 * the scheduled maintenance breaks as gaps. A level whose window fails that check
 * is INCOMPLETE_DATA — shown, flagged, and never used for zone evidence.
 */
import type { Candle, Timeframe } from '../../types/market';
import { addDays, dayBounds, dayInfo, NY, previousTradingDate, previousWeekDates, sessionDate, utcHm, zonedParts, zonedToUtc } from './cmeCalendar';

export type AsiaSessionId = 'cme-asia' | 'tokyo';

export const ASIA_SESSIONS: Record<AsiaSessionId, { label: string; rule: string }> = {
  'cme-asia': { label: 'Asia (CME desk)', rule: '18:00–03:00 New York' },
  tokyo: { label: 'Asia (Tokyo)', rule: '09:00–18:00 Tokyo' },
};

export const TF_SECONDS: Record<Timeframe, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14_400, D1: 86_400 } as Record<Timeframe, number>;
/** Finest first. H4 / D1 are never used: their buckets do not align with CME session boundaries. */
const SOURCE_TFS: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1'];

export type LevelKind = 'PDH' | 'PDL' | 'PWH' | 'PWL' | 'ASIA_HIGH' | 'ASIA_LOW';
export type LevelStatus = 'COMPLETE' | 'FORMING' | 'INCOMPLETE_DATA' | 'UNAVAILABLE' | 'CALENDAR_EXPIRED';

export interface KeyLevel {
  kind: LevelKind;
  label: string;
  price: number | null;
  /** Bar (open time, s) that set the extreme. */
  time: number | null;
  windowFrom: number | null;
  windowTo: number | null;
  /** Human window, e.g. "Thu 29 Oct 18:00 ET → Fri 30 Oct 03:00 ET (22:00–07:00 UTC)". */
  windowLabel: string;
  sourceTf: Timeframe | null;
  status: LevelStatus;
  note: string;
}

export interface SessionStats {
  sessionDate: string | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  /** Mean (high − low) over the last `adrDays` complete CME trading days. */
  adr: number | null;
  adrDays: number;
  adrNote: string;
}

export interface KeyLevelsResult {
  asia: AsiaSessionId;
  asiaRule: string;
  /** Knowledge time: open time of the newest bar used. */
  asOf: number | null;
  levels: KeyLevel[];
  stats: SessionStats;
}

export type BarsByTf = Partial<Record<Timeframe, readonly Candle[]>>;

interface Window {
  from: number;
  to: number;
  /** Scheduled maintenance breaks inside the window (allowed gaps). */
  breaks: number;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function etLabel(sec: number): string {
  const p = zonedParts(sec, NY);
  const dow = DOW[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
  return `${dow} ${p.d} ${MON[p.m - 1]} ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')} ET`;
}
export const windowLabel = (from: number, to: number) => `${etLabel(from)} → ${etLabel(to)} (${utcHm(from).slice(0, 5)}–${utcHm(to)})`;

/** Asia window belonging to session date `date`. */
export function asiaWindow(date: string, id: AsiaSessionId): { from: number; to: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  if (id === 'tokyo') return { from: zonedToUtc(y, m, d, 9, 0, 'Asia/Tokyo'), to: zonedToUtc(y, m, d, 18, 0, 'Asia/Tokyo') };
  const [py, pm, pd] = addDays(date, -1).split('-').map(Number) as [number, number, number];
  return { from: zonedToUtc(py, pm, pd, 18, 0, NY), to: zonedToUtc(y, m, d, 3, 0, NY) };
}

/** Timeframes whose bars reach back to the window start, finest first. */
function sourcesFor(bars: BarsByTf, from: number): { tf: Timeframe; bars: readonly Candle[] }[] {
  const out: { tf: Timeframe; bars: readonly Candle[] }[] = [];
  for (const tf of SOURCE_TFS) {
    const b = bars[tf];
    if (b && b.length && b[0]!.time <= from) out.push({ tf, bars: b });
  }
  return out;
}

interface Measured {
  high: number;
  highTime: number;
  low: number;
  lowTime: number;
  open: number;
  ok: boolean;
  reason: string;
  tf: Timeframe;
}

/** High / low of closed bars inside a window from ONE timeframe, with a boundary + contiguity coverage check. */
function measureTf(src: { tf: Timeframe; bars: readonly Candle[] }, w: Window, requireComplete: boolean, earlyClose: boolean): Measured | null {
  const step = TF_SECONDS[src.tf];
  const inside = src.bars.filter((c) => c.time >= w.from && c.time < w.to && c.isClosed !== false);
  if (!inside.length) return null;
  let high = -Infinity, low = Infinity, highTime = 0, lowTime = 0;
  for (const c of inside) {
    if (c.high > high) {
      high = c.high;
      highTime = c.time;
    }
    if (c.low < low) {
      low = c.low;
      lowTime = c.time;
    }
  }
  let reason = '';
  const startLag = inside[0]!.time - w.from;
  if (startLag > 2 * 3600) reason = `first ${src.tf} bar ${Math.round(startLag / 60)} min after the window start`;
  let gaps = 0, worst = 0;
  for (let i = 1; i < inside.length; i++) {
    const g = inside[i]!.time - inside[i - 1]!.time;
    if (g > step * 1.5) {
      gaps++;
      worst = Math.max(worst, g);
    }
  }
  if (!reason && (gaps > w.breaks || worst > step + 90 * 60)) reason = `${gaps} gap(s) in the ${src.tf} bars (largest ${Math.round(worst / 60)} min) — more than the scheduled maintenance breaks`;
  if (!reason && requireComplete && !earlyClose) {
    const last = inside[inside.length - 1]!;
    if (last.time + step < w.to - 2 * 3600) reason = `${src.tf} bars stop ${Math.round((w.to - last.time - step) / 60)} min before the window end`;
  }
  const ok = !reason;
  return { high, highTime, low, lowTime, open: inside[0]!.open, ok, reason, tf: src.tf };
}

/**
 * Measure a window from the finest timeframe whose coverage PASSES. A hole in fine data
 * (e.g. an M1 history/live gap) falls back to a coarser real series that covers the window;
 * when none passes, the finest attempt is returned flagged (never silently used).
 */
function measure(bars: BarsByTf, w: Window, requireComplete: boolean, earlyClose = false): Measured | null {
  let first: Measured | null = null;
  const skipped: string[] = [];
  for (const src of sourcesFor(bars, w.from)) {
    const m = measureTf(src, w, requireComplete, earlyClose);
    if (!m) continue;
    if (m.ok) return skipped.length ? { ...m, reason: `${src.tf} used — ${skipped.join('; ')}` } : m;
    skipped.push(`${src.tf}: ${m.reason}`);
    first ??= m;
  }
  if (!first) return null;
  const others = skipped.slice(1).map((x) => x.split(':')[0]);
  return { ...first, reason: `${first.reason}${others.length ? ` (also ${others.join(', ')})` : ''}` };
}

function pair(kinds: [LevelKind, LevelKind], labels: [string, string], w: { from: number; to: number } | null, m: Measured | null, status: LevelStatus, note: string): KeyLevel[] {
  const wl = w ? windowLabel(w.from, w.to) : '—';
  const st: LevelStatus = m ? (m.ok ? status : 'INCOMPLETE_DATA') : status === 'CALENDAR_EXPIRED' ? status : 'UNAVAILABLE';
  const n = m && !m.ok ? m.reason : m ? (m.reason ? `${note} · ${m.reason}` : note) : note || 'No bars cover this window';
  return [
    { kind: kinds[0], label: labels[0], price: m ? m.high : null, time: m ? m.highTime : null, windowFrom: w?.from ?? null, windowTo: w?.to ?? null, windowLabel: wl, sourceTf: m?.tf ?? null, status: st, note: n },
    { kind: kinds[1], label: labels[1], price: m ? m.low : null, time: m ? m.lowTime : null, windowFrom: w?.from ?? null, windowTo: w?.to ?? null, windowLabel: wl, sourceTf: m?.tf ?? null, status: st, note: n },
  ];
}

const newestTime = (bars: BarsByTf) => {
  let t: number | null = null;
  for (const tf of SOURCE_TFS) {
    const b = bars[tf];
    const last = b?.[b.length - 1];
    if (last && (t === null || last.time > t)) t = last.time;
  }
  return t;
};

export function computeKeyLevels(bars: BarsByTf, asia: AsiaSessionId, adrDays = 14): KeyLevelsResult {
  const asOf = newestTime(bars);
  const empty: SessionStats = { sessionDate: null, dayOpen: null, dayHigh: null, dayLow: null, adr: null, adrDays, adrNote: 'No data' };
  if (asOf === null) return { asia, asiaRule: ASIA_SESSIONS[asia].rule, asOf, levels: [], stats: empty };
  const today = sessionDate(asOf);
  const levels: KeyLevel[] = [];

  // Previous CME trading day.
  const prev = previousTradingDate(today);
  if (prev.date) {
    const b = dayBounds(prev.date);
    const m = measure(bars, { from: b.start, to: b.end, breaks: 0 }, true, dayInfo(prev.date).earlyClose);
    levels.push(...pair(['PDH', 'PDL'], ['Prev Day High', 'Prev Day Low'], { from: b.start, to: b.end }, m, 'COMPLETE', `CME trading day ${prev.date}`));
  } else levels.push(...pair(['PDH', 'PDL'], ['Prev Day High', 'Prev Day Low'], null, null, 'CALENDAR_EXPIRED', prev.reason));

  // Previous CME week.
  const pw = previousWeekDates(today);
  if (pw.dates && pw.dates.length) {
    const first = dayBounds(pw.dates[0]!), last = dayBounds(pw.dates[pw.dates.length - 1]!);
    const w = { from: first.start, to: last.end };
    // Day by day: a mid-week holiday is a scheduled closure, not a data gap.
    const days = pw.dates.map((d) => measure(bars, { from: dayBounds(d).start, to: dayBounds(d).end, breaks: 0 }, true, dayInfo(d).earlyClose));
    let m: Measured | null = null;
    if (days.every((x) => x)) {
      const ds = days as Measured[];
      const hi = ds.reduce((a, b) => (b.high > a.high ? b : a));
      const lo = ds.reduce((a, b) => (b.low < a.low ? b : a));
      const bad = ds.findIndex((x) => !x.ok);
      m = { high: hi.high, highTime: hi.highTime, low: lo.low, lowTime: lo.lowTime, open: ds[0]!.open, tf: ds[0]!.tf, ok: bad < 0, reason: bad < 0 ? '' : `${pw.dates[bad]}: ${ds[bad]!.reason}` };
    }
    levels.push(...pair(['PWH', 'PWL'], ['Prev Week High', 'Prev Week Low'], w, m, 'COMPLETE', `CME week of ${pw.monday} (${pw.dates.length} trading days)`));
  } else levels.push(...pair(['PWH', 'PWL'], ['Prev Week High', 'Prev Week Low'], null, null, pw.dates === null ? 'CALENDAR_EXPIRED' : 'UNAVAILABLE', pw.reason));

  // Latest Asia window that has started (today's, else the previous trading day's).
  const todayInfo = dayInfo(today);
  let asiaDate: string | null = todayInfo.status === 'TRADING' && asiaWindow(today, asia).from <= asOf ? today : prev.date;
  if (asiaDate && dayInfo(asiaDate).status !== 'TRADING') asiaDate = null;
  if (asiaDate) {
    const w = asiaWindow(asiaDate, asia);
    const forming = asOf < w.to;
    const m = measure(bars, { ...w, breaks: 0 }, !forming);
    levels.push(...pair(['ASIA_HIGH', 'ASIA_LOW'], ['Asia High', 'Asia Low'], w, m, forming ? 'FORMING' : 'COMPLETE', `${ASIA_SESSIONS[asia].label} · ${ASIA_SESSIONS[asia].rule}${forming ? ' · in progress' : ''}`));
  } else levels.push(...pair(['ASIA_HIGH', 'ASIA_LOW'], ['Asia High', 'Asia Low'], null, null, todayInfo.status === 'CALENDAR_EXPIRED' ? 'CALENDAR_EXPIRED' : 'UNAVAILABLE', todayInfo.reason));

  // Current session (forming) and ADR over complete days.
  const stats: SessionStats = { ...empty, sessionDate: today, adrNote: '' };
  if (todayInfo.status === 'TRADING') {
    const b = dayBounds(today);
    const m = measure(bars, { from: b.start, to: Math.min(b.end, asOf + 1), breaks: 0 }, false);
    if (m) Object.assign(stats, { dayOpen: m.open, dayHigh: m.high, dayLow: m.low });
  }
  const ranges: number[] = [];
  let d: string | null = today;
  for (let guard = 0; guard < 40 && ranges.length < adrDays && d; guard++) {
    const p = previousTradingDate(d);
    d = p.date;
    if (!d) break;
    const db = dayBounds(d);
    const m = measure(bars, { from: db.start, to: db.end, breaks: 0 }, true, dayInfo(d).earlyClose);
    if (m && m.ok) ranges.push(m.high - m.low);
  }
  if (ranges.length >= Math.ceil(adrDays * 0.7)) {
    stats.adr = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    stats.adrNote = `${ranges.length} complete CME trading days`;
  } else stats.adrNote = `Only ${ranges.length} complete CME trading days available (need ${Math.ceil(adrDays * 0.7)})`;

  return { asia, asiaRule: ASIA_SESSIONS[asia].rule, asOf, levels, stats };
}

/** Usable for analysis: complete (or forming Asia) with a price. */
export const levelUsable = (l: KeyLevel) => l.price !== null && (l.status === 'COMPLETE' || l.status === 'FORMING');
