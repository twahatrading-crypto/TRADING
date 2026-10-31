import { SESSIONS } from '../../config/sessions';
import { meaningfulZones, tierOf, TIER_LABEL, tfRank, type AnalysisInput, type Tier } from '../../engines/srPro/analysis';
import { addDays, sessionDate, zonedToUtc } from '../../engines/srPro/cmeCalendar';
import { asiaWindow, levelUsable, type AsiaSessionId, type KeyLevel } from '../../engines/srPro/keyLevels';
import type { SRZone } from '../../engines/sr/types';
import type { Timeframe } from '../../types/market';
import type { ZoneDrawable } from '../chart/ZonesPrimitive';
import type { TimeBand } from '../chart/TimeBandsPrimitive';
import { DEFAULT_SMC_TOGGLES, type SmcDrawable, type SmcToggles } from '../smc/smcView';

export type OverlayKey = 'zones' | 'unrated' | 'levels' | 'sessions' | 'bos' | 'choch' | 'fvg' | 'orderBlocks' | 'liquidity' | 'sweeps';
export type Overlays = Record<OverlayKey, boolean>;
export const OVERLAY_LABELS: [OverlayKey, string, string][] = [
  ['zones', 'S&R zones', 'Rated zones on this timeframe and higher, nearest first'],
  ['levels', 'Key levels', 'Prev day / prev week / Asia highs and lows (CME sessions)'],
  ['sessions', 'Sessions', 'Asia / London / New York bands (timeframes up to H1)'],
  ['bos', 'BOS', 'Break of structure — SMC engine, closed candles'],
  ['choch', 'CHOCH', 'Change of character — SMC engine, closed candles'],
  ['fvg', 'FVG', 'Fair value gaps — SMC engine'],
  ['orderBlocks', 'Order blocks', 'SMC engine order blocks'],
  ['liquidity', 'Liquidity', 'Buy-/sell-side liquidity INFERRED from swings'],
  ['sweeps', 'Sweeps', 'Liquidity sweeps — SMC engine'],
  ['unrated', 'Unrated zones', 'Zones from thin contract history (not rated)'],
];
export const DEFAULT_OVERLAYS: Overlays = { zones: true, levels: true, sessions: true, bos: true, choch: true, fvg: false, orderBlocks: false, liquidity: true, sweeps: false, unrated: false };
export const isOverlays = (v: unknown): v is Overlays => !!v && typeof v === 'object' && OVERLAY_LABELS.every(([k]) => typeof (v as Record<string, unknown>)[k] === 'boolean');

export const fmtP = (v: number | null | undefined, d: number) => (v === null || v === undefined ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmtSigned = (v: number | null | undefined, d: number) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtP(Math.abs(v), d)}`);
export const fmtUtc = (s: number | null | undefined) => (s === null || s === undefined ? '—' : `${new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`);
export const tierTone = (t: Tier) => ({ STRONG: 'strong', MEDIUM: 'medium', WEAK: 'weak', MINOR: 'muted', INACTIVE: 'muted', UNRATED: 'unrated' })[t];
export const roleShort = (z: SRZone) => (z.role === 'support' ? 'Support' : 'Resistance');
const STATUS_LABEL: Record<string, string> = { FRESH: 'Fresh', ACTIVE: 'Active', TESTED: 'Tested', WEAKENING: 'Weakening', BROKEN: 'Broken', FLIPPED: 'Flipped', EXPIRED: 'Expired' };
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;

const SMC_OFF: SmcToggles = Object.fromEntries(Object.keys(DEFAULT_SMC_TOGGLES).map((k) => [k, false])) as SmcToggles;
export function smcToggles(o: Overlays): SmcToggles {
  return { ...SMC_OFF, bos: o.bos, choch: o.choch, fvg: o.fvg, orderBlocks: o.orderBlocks, liquidity: o.liquidity, sweeps: o.sweeps };
}

const EMPHASIS: Record<Tier, number> = { STRONG: 1, MEDIUM: 0.7, WEAK: 0.45, MINOR: 0.2, INACTIVE: 0.15, UNRATED: 0.15 };

/** Zones drawn on the chart: the nearest meaningful ones (+ the selection, + unrated when asked). Never all of them. */
export function zoneDrawables(a: AnalysisInput, chartTf: Timeframe, o: Overlays, selectedId: string | null, d: number, limit = 8): ZoneDrawable[] {
  if (!o.zones) return [];
  const shown = new Map<string, SRZone>();
  for (const z of meaningfulZones(a, chartTf, limit)) shown.set(z.id, z);
  if (o.unrated) for (const z of a.zones.filter((x) => tierOf(x, a.quality) === 'UNRATED' && tfRank(x.timeframe) >= tfRank(chartTf)).slice(0, 4)) shown.set(z.id, z);
  const sel = a.zones.find((z) => z.id === selectedId);
  if (sel) shown.set(sel.id, sel);
  return [...shown.values()].map((z) => {
    const t = tierOf(z, a.quality);
    return {
      id: z.id,
      role: z.role,
      low: z.zoneLow,
      high: z.zoneHigh,
      from: z.createdAt,
      emphasis: EMPHASIS[t],
      label: `${z.timeframe} ${z.role === 'support' ? 'SUPPORT' : 'RESISTANCE'} | ${t === 'UNRATED' ? 'UNRATED' : z.score.total}`,
      sublabel: `${fmtP(z.zoneLow, d)}–${fmtP(z.zoneHigh, d)} · ${TIER_LABEL[t]} · ${statusLabel(z.status)}`,
      selected: z.id === selectedId,
      highlighted: false,
      dimmed: t === 'UNRATED' || t === 'INACTIVE',
    };
  });
}

const LEVEL_STYLE: Record<string, { title: string; tone: SmcDrawable['tone'] }> = {
  PDH: { title: 'PDH', tone: 'gold' },
  PDL: { title: 'PDL', tone: 'gold' },
  PWH: { title: 'PWH', tone: 'eq' },
  PWL: { title: 'PWL', tone: 'eq' },
  ASIA_HIGH: { title: 'Asia H', tone: 'fvgBear' },
  ASIA_LOW: { title: 'Asia L', tone: 'fvgBear' },
};
/** Key levels as dashed lines from their session window onwards; labels sit ON the line (never in the zone-label column). */
export function levelDrawables(levels: readonly KeyLevel[], o: Overlays, d: number): SmcDrawable[] {
  if (!o.levels) return [];
  return levels.filter(levelUsable).map((l) => {
    const st = LEVEL_STYLE[l.kind]!;
    return { id: `lvl:${l.kind}`, kind: 'line', tone: st.tone, from: l.windowFrom, to: null, high: l.price!, low: l.price!, label: `${st.title} ${fmtP(l.price, d)}${l.status === 'FORMING' ? ' (forming)' : ''}`, labelAt: 'segment', dashed: true };
  });
}

// The theme's session tokens (--s-asia, --s-london, --s-new-york).
const SESSION_RGB: Record<string, string> = { asia: '199,125,255', london: '63,207,124', 'new-york': '91,141,239' };

/** Session bands for the recent session days (TF ≤ H1), plus the hatched thin-history region. */
export function timeBands(a: AnalysisInput, chartTf: Timeframe, asia: AsiaSessionId, o: Overlays, firstBar: number | null, lastBar: number | null): TimeBand[] {
  const bands: TimeBand[] = [];
  if (a.quality?.activeSince && firstBar !== null && firstBar < a.quality.activeSince) {
    bands.push({ id: 'thin', from: firstBar, to: a.quality.activeSince, rgb: '140,150,165', alpha: 0.06, label: `THIN CONTRACT HISTORY — zones not rated (before ${a.quality.activeSinceDay})`, hatched: true });
  }
  if (!o.sessions || lastBar === null || tfRank(chartTf) > tfRank('H1')) return bands;
  const days = chartTf === 'M1' ? 2 : chartTf === 'M5' ? 4 : 7;
  let date = sessionDate(lastBar);
  for (let i = 0; i < days; i++, date = addDays(date, -1)) {
    const w = asiaWindow(date, asia);
    bands.push({ id: `asia-${date}`, from: w.from, to: w.to, rgb: SESSION_RGB.asia!, alpha: 0.05, label: 'Asia' });
    for (const id of ['london', 'new-york'] as const) {
      const def = SESSIONS.find((s) => s.id === id);
      if (!def) continue;
      const [y, m, d] = date.split('-').map(Number) as [number, number, number];
      const from = zonedToUtc(y, m, d, def.open.hour, def.open.minute, def.timeZone);
      const to = zonedToUtc(y, m, d, def.close.hour, def.close.minute, def.timeZone);
      bands.push({ id: `${id}-${date}`, from, to, rgb: SESSION_RGB[id]!, alpha: 0.035, label: def.name });
    }
  }
  return bands.sort((x, y) => x.from - y.from);
}

/** Exact boundary label of the shared London / New York sessions (for the Key Levels tab). */
export const sessionRules = () => SESSIONS.filter((s) => s.id === 'london' || s.id === 'new-york').map((s) => ({ name: s.name, rule: s.rule }));

/**
 * The SMC overlay as the S&R page needs it — readable, not exhaustive: the 4 most recent
 * BOS / CHOCH, unswept liquidity only (2 above and 2 below price), at most 3 FVGs and 3 order
 * blocks. The SMC page itself keeps its full overlay; nothing in smcView is changed.
 */
export function declutterSmc(drawables: readonly SmcDrawable[], price: number | null): SmcDrawable[] {
  const by = (prefix: string) => drawables.filter((x) => x.id.startsWith(prefix));
  const breaks = by('smc:brk:').sort((a, b) => (b.to ?? 0) - (a.to ?? 0)).slice(0, 4);
  const live = by('smc:lq:').filter((x) => !x.dashed).map((x) => ({ ...x, label: `${x.label} (inferred)`, labelAt: 'segment' as const }));
  const liq = price === null ? [] : [...live.filter((x) => x.high >= price).sort((a, b) => a.high - b.high).slice(0, 2), ...live.filter((x) => x.high < price).sort((a, b) => b.high - a.high).slice(0, 2)];
  return [...breaks, ...liq, ...by('smc:fvg:').slice(-3), ...by('smc:ob:').slice(0, 3)];
}

/**
 * Line labels that would collide: a line inside a drawn zone keeps its line but loses its label
 * (the zone's evidence lists it), and labelled lines closer than `minGapAtr` keep only the first
 * (order = priority: key levels before inferred liquidity). Structure breaks are left alone.
 */
export function declutterLineLabels(lines: readonly SmcDrawable[], zones: readonly ZoneDrawable[], atr: number | null, minGapAtr = 0.35): SmcDrawable[] {
  const tol = (atr ?? 0) * 0.1;
  const gap = (atr ?? 0) * minGapAtr;
  const kept: number[] = [];
  return lines.map((l) => {
    if (l.kind !== 'line' || l.id.startsWith('smc:brk:') || !l.label) return l;
    const inZone = zones.some((z) => l.high >= z.low - tol && l.high <= z.high + tol);
    const crowded = kept.some((p) => Math.abs(p - l.high) < gap);
    if (inZone || crowded) return { ...l, label: '' };
    kept.push(l.high);
    return l;
  });
}
