/**
 * Institutional-style S&R analysis — an EXPLANATION layer over the existing engines.
 *
 * It never recalculates or re-scores anything the engines own:
 *   zones, scores, statuses, interactions ......... S&R engine (engines/sr, unchanged)
 *   BOS / CHOCH / structure state ................. SMC engine (engines/smc, unchanged)
 *   buy-/sell-side liquidity pools (INFERRED) ..... Liquidity engine (engines/liquidity, unchanged)
 *   order blocks .................................. Order Block engine (engines/orderBlocks, unchanged)
 *   POC / VAH / VAL / HVN / LVN ................... Volume Profile engine (engines/volumeProfile, unchanged)
 * It adds: strength tiers, the contract-liquidity gate (dataQuality), measured volume on
 * reaction bars, key-level proximity, plain-language reasons, confirmation / invalidation
 * rules quoted from the engine settings, and Bullish / Bearish / No-Trade checklists.
 *
 * NO PROBABILITIES. Scenarios are lists of verifiable conditions (MET / NOT MET / UNKNOWN).
 * No BUY / SELL signal is ever emitted, no confidence percentage, no projected path.
 */
import type { LiquidityPool } from '../liquidity/types';
import type { OrderBlock } from '../orderBlocks/types';
import type { SRSettings } from '../sr/settings';
import { SCORE_WEIGHTS } from '../sr/settings';
import type { ScoreComponentKey, SRConfluence, SRSnapshot, SRZone } from '../sr/types';
import type { SmcSnapshot, SmcTimeframeSnapshot } from '../smc/types';
import type { VPSnapshot } from '../volumeProfile/types';
import type { Candle, Timeframe } from '../../types/market';
import type { FeedStatus } from './feedState';
import { levelUsable, TF_SECONDS, type KeyLevel } from './keyLevels';
import type { QualityResult } from './dataQuality';

export const TF_ORDER: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
export const tfRank = (tf: Timeframe) => TF_ORDER.indexOf(tf);

// ─────────────────────────────────────────────────────────────── tiers
export type Tier = 'STRONG' | 'MEDIUM' | 'WEAK' | 'MINOR' | 'INACTIVE' | 'UNRATED';
export const TIER_LABEL: Record<Tier, string> = { STRONG: 'Strong', MEDIUM: 'Medium', WEAK: 'Weak', MINOR: 'Minor', INACTIVE: 'Inactive', UNRATED: 'Unrated' };
export const TIER_RULE: Record<Tier, string> = {
  STRONG: 'Score ≥ 80',
  MEDIUM: 'Score 60–79',
  WEAK: 'Score 40–59',
  MINOR: 'Score < 40 (hidden from the chart)',
  INACTIVE: 'Broken or expired',
  UNRATED: 'Formed in thin contract history',
};

export const isThin = (z: SRZone, q: QualityResult | null) => !!q && q.activeSince !== null && z.createdAt < q.activeSince;

export function tierOf(z: SRZone, q: QualityResult | null): Tier {
  if (z.status === 'BROKEN' || z.status === 'EXPIRED') return 'INACTIVE';
  if (isThin(z, q)) return 'UNRATED';
  const s = z.score.total;
  return s >= 80 ? 'STRONG' : s >= 60 ? 'MEDIUM' : s >= 40 ? 'WEAK' : 'MINOR';
}

/** Rated = may support a scenario. */
export const isRated = (t: Tier) => t === 'STRONG' || t === 'MEDIUM' || t === 'WEAK';

export function tierCounts(zones: readonly SRZone[], q: QualityResult | null): Record<Tier, number> {
  const c: Record<Tier, number> = { STRONG: 0, MEDIUM: 0, WEAK: 0, MINOR: 0, INACTIVE: 0, UNRATED: 0 };
  for (const z of zones) c[tierOf(z, q)]++;
  return c;
}

// ─────────────────────────────────────────────────────────────── evidence
export const COMPONENT_LABEL: Record<ScoreComponentKey, string> = {
  timeframe: 'Timeframe significance',
  reaction: 'Reaction strength',
  touchQuality: 'Touch quality',
  freshness: 'Freshness',
  structure: 'Structure',
  confluence: 'Multi-TF confluence',
};

export interface ScoreLine {
  key: ScoreComponentKey;
  label: string;
  value: number;
  weight: number;
  contribution: number;
  explain: string;
}

export interface EvidenceItem {
  kind: 'volume' | 'profile' | 'level' | 'liquidity' | 'orderBlock' | 'confluence';
  text: string;
  source: string;
  inferred?: boolean;
}

export interface ZoneEvidence {
  zone: SRZone;
  tier: Tier;
  tierReason: string;
  thin: boolean;
  scoreLines: ScoreLine[];
  statusFactorNote: string;
  reactions: { touches: number; rejections: number; sweeps: number; closeThroughs: number; meanRejectionAtr: number | null; lastAt: number | null };
  items: EvidenceItem[];
  /** Plain-language reasons, strongest first. */
  reasons: string[];
  confirmation: string[];
  invalidation: string[];
  invalidationPrice: number;
  structure: string;
  freshness: string;
  /** Set when price is beyond the zone but no closed candle of its timeframe has broken it. */
  beyond: string | null;
}

export interface AnalysisSources {
  feedLabel: string;
  /** e.g. "Databento · GLBX.MDP3 · GCZ6" */
  candleSource: string;
  decimals: number;
}

export interface AnalysisInput {
  zones: readonly SRZone[];
  confluences: readonly SRConfluence[];
  byTf: Partial<Record<Timeframe, SRSnapshot>>;
  candles: Partial<Record<Timeframe, readonly Candle[]>>;
  settings: SRSettings;
  quality: QualityResult | null;
  levels: readonly KeyLevel[];
  smc: SmcSnapshot | null;
  pools: readonly LiquidityPool[];
  blocks: readonly OrderBlock[];
  vp: VPSnapshot | null;
  feed: FeedStatus;
  price: number | null;
  sources: AnalysisSources;
}

const fmt = (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const utc = (s: number | null) => (s === null ? '—' : `${new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`);

function explainComponent(k: ScoreComponentKey, z: SRZone, v: number, meanRej: number | null, confTfs: number): string {
  switch (k) {
    case 'timeframe':
      return `${z.timeframe} levels carry ${v}/100 significance`;
    case 'reaction':
      return meanRej === null ? 'Formation move only (no resolved test yet)' : `Mean reaction ${meanRej.toFixed(2)} ATR away from the zone`;
    case 'touchQuality':
      return z.rejectionCount + z.closeThroughCount === 0 && z.touchCount === 0 ? 'Untested — neutral 50' : `${z.rejectionCount} rejection(s), ${z.closeThroughCount} close-through(s)`;
    case 'freshness':
      return `${z.touchCount} resolved test(s); each lowers freshness`;
    case 'structure':
      return `Swing prominence and ${z.sourcePivotIds.length} contributing pivot(s)`;
    case 'confluence':
      return confTfs > 1 ? `Overlaps zones on ${confTfs} timeframes` : 'No overlapping zone on another timeframe';
  }
}

function medianVolume(bars: readonly Candle[], since: number | null): number | null {
  const v = bars.filter((c) => c.isClosed !== false && typeof c.volume === 'number' && (since === null || c.time >= since)).slice(-200).map((c) => c.volume as number);
  if (v.length < 20) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

const structureOf = (tf: SmcTimeframeSnapshot | undefined) => {
  if (!tf || tf.dataState !== 'READY') return 'INSUFFICIENT DATA';
  return tf.state;
};

export function zoneEvidence(z: SRZone, a: AnalysisInput): ZoneEvidence {
  const d = a.sources.decimals;
  const tier = tierOf(z, a.quality);
  const thin = isThin(z, a.quality);
  const atr = z.atrAtConfirmation;
  const s = a.settings;
  const resolved = z.interactions.filter((i) => i.rejected !== null || i.broke);
  const rejectionAtrs = resolved.filter((i) => i.rejected).map((i) => i.rejectionAtr);
  const meanRej = rejectionAtrs.length ? rejectionAtrs.reduce((x, y) => x + y, 0) / rejectionAtrs.length : null;
  const conf = a.confluences.find((c) => c.zoneIds.includes(z.id)) ?? null;

  const scoreLines: ScoreLine[] = (Object.keys(SCORE_WEIGHTS) as ScoreComponentKey[]).map((k) => {
    const value = z.score.components[k];
    const weight = SCORE_WEIGHTS[k];
    return { key: k, label: COMPONENT_LABEL[k], value, weight, contribution: Math.round(value * weight * 10) / 10, explain: explainComponent(k, z, value, meanRej, conf?.timeframes.length ?? 1) };
  });

  const items: EvidenceItem[] = [];
  // Real exchange volume on the bars where the zone rejected price (Databento OHLCV), vs the TF median.
  const bars = a.candles[z.timeframe] ?? [];
  const med = medianVolume(bars, a.quality?.activeSince ?? null);
  const byTime = new Map(bars.map((c) => [c.time, c]));
  for (const i of z.interactions.filter((x) => x.rejected).slice(-3)) {
    const bar = byTime.get(i.extremeTime);
    if (bar && typeof bar.volume === 'number' && med) {
      const ratio = bar.volume / med;
      items.push({ kind: 'volume', text: `Reaction bar ${utc(i.extremeTime)}: volume ${bar.volume.toLocaleString('en-US')} = ${ratio.toFixed(1)}× the ${z.timeframe} median`, source: `${a.sources.candleSource} · exchange volume (bar total, not order ownership)` });
    }
  }
  if (!items.length) items.push({ kind: 'volume', text: med ? 'No rejection bar inside the loaded history to measure' : 'Not enough volume history on this timeframe to compare', source: a.sources.candleSource });

  // Volume-profile levels inside / at the zone.
  const tol = 0.1 * atr;
  for (const k of a.vp?.keyLevels ?? []) {
    if (k.price >= z.zoneLow - tol && k.price <= z.zoneHigh + tol) {
      items.push({ kind: 'profile', text: `${k.kind} ${fmt(k.price, d)} (${k.profileLabel}) sits in the zone`, source: `Volume profile · ${a.vp?.source.label ?? ''} · bar volume allocated across each bar's range` });
    }
  }
  // Session / day / week levels within 0.25 ATR.
  for (const l of a.levels) {
    if (levelUsable(l) && l.price! >= z.zoneLow - 0.25 * atr && l.price! <= z.zoneHigh + 0.25 * atr) {
      items.push({ kind: 'level', text: `${l.label} ${fmt(l.price!, d)}${l.status === 'FORMING' ? ' (forming)' : ''} at the zone`, source: `CME session levels · ${l.windowLabel}` });
    }
  }
  // Inferred liquidity just beyond the far edge (stops a break would trigger).
  const role = z.role;
  for (const p of a.pools) {
    if (p.state === 'CONSUMED' || p.state === 'INVALIDATED') continue;
    const beyond = role === 'support' ? p.side === 'SSL' && p.level <= z.zoneLow && p.level >= z.zoneLow - 0.75 * atr : p.side === 'BSL' && p.level >= z.zoneHigh && p.level <= z.zoneHigh + 0.75 * atr;
    if (beyond) items.push({ kind: 'liquidity', text: `${p.side === 'BSL' ? 'Buy-side' : 'Sell-side'} liquidity ${fmt(p.level, d)} (${p.timeframe}, ${p.source === 'equal' ? 'equal ' + (role === 'support' ? 'lows' : 'highs') : 'swing'}, ${p.state.toLowerCase()}) just beyond the zone`, source: 'Liquidity engine · INFERRED from price structure, not order-book data', inferred: true });
  }
  // Order blocks overlapping the zone on the same side.
  for (const b of a.blocks) {
    if (b.state === 'INVALIDATED' || b.state === 'EXPIRED') continue;
    const sameSide = (b.type === 'bullish') === (role === 'support');
    if (sameSide && b.low <= z.zoneHigh && b.high >= z.zoneLow) items.push({ kind: 'orderBlock', text: `${b.timeframe} ${b.type} order block ${fmt(b.low, d)}–${fmt(b.high, d)} (${b.state.toLowerCase()}) overlaps`, source: 'Order Block engine · candle structure' });
  }
  if (conf && conf.timeframes.length > 1) items.push({ kind: 'confluence', text: `Confluence with ${conf.timeframes.join(' · ')} (${fmt(conf.overlapLow, d)}–${fmt(conf.overlapHigh, d)})`, source: 'S&R multi-timeframe confluence' });

  const reasons = [...scoreLines].sort((x, y) => y.contribution - x.contribution).slice(0, 3).map((l) => `${l.label} ${l.value}/100 — ${l.explain}`);
  if (thin) reasons.unshift(`Formed ${utc(z.createdAt)}, before the contract became liquid (${a.quality?.activeSinceDay}) — not rated`);

  const breakLevel = role === 'support' ? z.zoneLow - s.breakToleranceAtr * atr : z.zoneHigh + s.breakToleranceAtr * atr;
  const dispLevel = role === 'support' ? z.zoneLow - s.breakDisplacementAtr * atr : z.zoneHigh + s.breakDisplacementAtr * atr;
  const rejLevel = role === 'support' ? z.zoneHigh + s.rejectionMinAtr * atr : z.zoneLow - s.rejectionMinAtr * atr;
  const dir = role === 'support' ? 'above' : 'below';
  const opp = role === 'support' ? 'below' : 'above';
  const confirmation = [
    `${z.timeframe} rejection: a closed candle ${dir} ${fmt(rejLevel, d)} (${s.rejectionMinAtr} ATR beyond the zone) within ${s.rejectionWindowBars} bars of the touch`,
    `Structure: a confirmed ${role === 'support' ? 'bullish' : 'bearish'} CHOCH or BOS on M15 after the touch (closed candles only)`,
  ];
  const invalidation = [
    `${s.breakConfirmCloses} consecutive ${z.timeframe} closes ${opp} ${fmt(breakLevel, d)}`,
    `or one ${z.timeframe} displacement close ${opp} ${fmt(dispLevel, d)} (a wick alone never breaks the zone)`,
  ];

  return {
    zone: z,
    tier,
    tierReason: thin ? TIER_RULE.UNRATED : `${TIER_RULE[tier]} · score ${z.score.total}`,
    thin,
    scoreLines,
    statusFactorNote: z.score.statusFactor === 1 ? '' : `× ${z.score.statusFactor} status factor (${z.status})`,
    reactions: { touches: z.touchCount, rejections: z.rejectionCount, sweeps: z.sweepCount, closeThroughs: z.closeThroughCount, meanRejectionAtr: meanRej, lastAt: z.lastInteractionAt },
    items,
    reasons,
    confirmation,
    invalidation,
    invalidationPrice: breakLevel,
    structure: `${z.timeframe}: ${structureOf(a.smc?.byTimeframe[z.timeframe])}`,
    freshness: `Last closed ${z.timeframe} bar ${utc(a.byTf[z.timeframe]?.lastClosedTime ?? null)} · ${a.sources.candleSource} · feed ${a.sources.feedLabel}`,
    beyond: beyondNote(z, a.price),
  };
}

// ─────────────────────────────────────────────────────────────── selection
/** Zones worth showing for a chart TF: same or higher TF, rated and active, nearest first. */
export function meaningfulZones(a: AnalysisInput, chartTf: Timeframe, limit = 8): SRZone[] {
  return a.zones
    .filter((z) => tfRank(z.timeframe) >= tfRank(chartTf) && isRated(tierOf(z, a.quality)))
    .sort((x, y) => Math.abs(x.distanceAtr ?? 1e9) - Math.abs(y.distanceAtr ?? 1e9) || y.score.total - x.score.total)
    .slice(0, limit);
}

/**
 * Price has traded through the far side of the zone, but the engine has not broken it: a break needs
 * CLOSED candles of the zone's own timeframe (e.g. a D1 support stays intact until a D1 close).
 */
export const beyondZone = (z: SRZone, price: number | null) =>
  price !== null && z.status !== 'BROKEN' && z.status !== 'EXPIRED' && (z.role === 'support' ? price < z.zoneLow : price > z.zoneHigh);

export function beyondNote(z: SRZone, price: number | null): string | null {
  if (!beyondZone(z, price)) return null;
  return `Price is ${z.role === 'support' ? 'below' : 'above'} this ${z.timeframe} ${z.role}, but no closed ${z.timeframe} candle has broken it yet — the break is decided on ${z.timeframe} closes.`;
}

/** The zone price is in; else the nearest one on the correct side of price; else the nearest at all. */
export function currentZone(a: AnalysisInput, chartTf: Timeframe): SRZone | null {
  const rated = a.zones.filter((z) => tfRank(z.timeframe) >= tfRank(chartTf) && isRated(tierOf(z, a.quality)));
  const inside = rated.filter((z) => z.inZone).sort((x, y) => y.score.total - x.score.total);
  if (inside[0]) return inside[0];
  const dist = (x: SRZone, y: SRZone) => Math.abs(x.distanceFromPrice ?? 1e12) - Math.abs(y.distanceFromPrice ?? 1e12);
  return [...rated].filter((z) => !beyondZone(z, a.price)).sort(dist)[0] ?? [...rated].sort(dist)[0] ?? null;
}

function nearest(a: AnalysisInput, chartTf: Timeframe, role: 'support' | 'resistance'): SRZone | null {
  const p = a.price;
  if (p === null) return null;
  const cands = a.zones.filter((z) => z.role === role && tfRank(z.timeframe) >= tfRank(chartTf) && isRated(tierOf(z, a.quality)));
  const ok = role === 'support' ? cands.filter((z) => z.zoneLow <= p) : cands.filter((z) => z.zoneHigh >= p);
  return ok.sort((x, y) => (role === 'support' ? y.zoneHigh - x.zoneHigh : x.zoneLow - y.zoneLow) || y.score.total - x.score.total)[0] ?? null;
}

// ─────────────────────────────────────────────────────────────── multi-timeframe map
export interface MtfRow {
  tf: Timeframe;
  structure: string;
  trend: 'up' | 'down' | 'flat' | 'none';
  zone: SRZone | null;
  tier: Tier | null;
  lastBreak: string;
}

export function mtfMap(a: AnalysisInput): MtfRow[] {
  return TF_ORDER.map((tf) => {
    const s = a.smc?.byTimeframe[tf];
    const st = structureOf(s);
    const trend = st === 'BULLISH' ? 'up' : st === 'BEARISH' ? 'down' : st === 'INSUFFICIENT DATA' ? 'none' : 'flat';
    const zs = a.zones.filter((z) => z.timeframe === tf && isRated(tierOf(z, a.quality))).sort((x, y) => Math.abs(x.distanceAtr ?? 1e9) - Math.abs(y.distanceAtr ?? 1e9));
    const b = s?.breaks[s.breaks.length - 1];
    return { tf, structure: st, trend, zone: zs[0] ?? null, tier: zs[0] ? tierOf(zs[0], a.quality) : null, lastBreak: b ? `${b.direction === 'bullish' ? 'Bullish' : 'Bearish'} ${b.kind} ${utc(b.confirmedAt)}` : '—' };
  });
}

// ─────────────────────────────────────────────────────────────── scenarios
export type CondState = 'MET' | 'NOT_MET' | 'UNKNOWN';
export interface Condition {
  text: string;
  state: CondState;
}
export interface Scenario {
  kind: 'BULLISH' | 'BEARISH' | 'NO_TRADE';
  title: string;
  /** VALID only when every condition is MET; NO_TRADE is ACTIVE when any reason holds. */
  status: 'CONDITIONS MET' | 'WAITING' | 'NOT AVAILABLE' | 'ACTIVE' | 'NOT ACTIVE';
  conditions: Condition[];
  levels: { label: string; price: number }[];
  note: string;
}

const MIN_RR = 1.5;

function latestBreak(s: SmcTimeframeSnapshot | undefined, dir: 'bullish' | 'bearish', since: number | null) {
  return [...(s?.breaks ?? [])].reverse().find((b) => b.direction === dir && (since === null || b.confirmedAt >= since)) ?? null;
}

function sideScenario(a: AnalysisInput, chartTf: Timeframe, kind: 'BULLISH' | 'BEARISH'): Scenario {
  const d = a.sources.decimals;
  const bull = kind === 'BULLISH';
  const zone = nearest(a, chartTf, bull ? 'support' : 'resistance');
  const target = nearest(a, chartTf, bull ? 'resistance' : 'support');
  const title = bull ? 'Bullish reaction at support' : 'Bearish reaction at resistance';
  if (!zone || a.price === null) return { kind, title, status: 'NOT AVAILABLE', conditions: [], levels: [], note: `No rated ${bull ? 'support below' : 'resistance above'} price on ${chartTf} or higher.` };
  const ev = zoneEvidence(zone, a);
  const atr = a.byTf[chartTf]?.atr ?? zone.atrAtConfirmation;
  const facing = bull ? zone.zoneHigh : zone.zoneLow;
  const near = bull ? a.price <= facing + 0.5 * atr : a.price >= facing - 0.5 * atr;
  const lastTest = zone.interactions[zone.interactions.length - 1] ?? null;
  const rejected = !!lastTest && lastTest.rejected === true && !lastTest.broke;
  const brk = latestBreak(a.smc?.byTimeframe.M15, bull ? 'bullish' : 'bearish', lastTest?.startTime ?? null);
  const htf = structureOf(a.smc?.byTimeframe.H1);
  const htfOk: CondState = htf === 'INSUFFICIENT DATA' ? 'UNKNOWN' : htf === (bull ? 'BEARISH' : 'BULLISH') ? 'NOT_MET' : 'MET';
  const risk = Math.abs(facing - ev.invalidationPrice);
  const reward = target ? Math.abs((bull ? target.zoneLow : target.zoneHigh) - facing) : null;
  const rr = reward !== null && risk > 0 ? reward / risk : null;
  const conditions: Condition[] = [
    { text: `Feed current (${a.feed.label})`, state: a.feed.current ? 'MET' : 'NOT_MET' },
    { text: `Price at ${zone.timeframe} ${bull ? 'support' : 'resistance'} ${fmt(zone.zoneLow, d)}–${fmt(zone.zoneHigh, d)} (within 0.5 ATR)`, state: near ? 'MET' : 'NOT_MET' },
    { text: `Latest test of the zone resolved as a rejection (${zone.timeframe}, closed bars)`, state: lastTest ? (rejected ? 'MET' : 'NOT_MET') : 'NOT_MET' },
    // "After that test" needs a test: with none, no structure break can confirm a reaction.
    { text: `Confirmed ${bull ? 'bullish' : 'bearish'} CHOCH / BOS on M15 after that test`, state: !a.smc?.byTimeframe.M15 ? 'UNKNOWN' : lastTest && brk ? 'MET' : 'NOT_MET' },
    { text: `H1 structure not ${bull ? 'bearish' : 'bullish'} (H1: ${htf})`, state: htfOk },
    { text: rr === null ? `Room to the next ${bull ? 'resistance' : 'support'}: none rated` : `Room to the next zone ≥ ${MIN_RR}× the risk to invalidation (${rr.toFixed(1)}×)`, state: rr === null ? 'UNKNOWN' : rr >= MIN_RR ? 'MET' : 'NOT_MET' },
  ];
  const levels = [
    { label: 'Zone', price: facing },
    { label: 'Invalidation (engine break level)', price: ev.invalidationPrice },
    ...(target ? [{ label: `Next opposing ${target.timeframe} zone`, price: bull ? target.zoneLow : target.zoneHigh }] : []),
  ];
  const all = conditions.every((c) => c.state === 'MET');
  return { kind, title, status: all ? 'CONDITIONS MET' : 'WAITING', conditions, levels, note: all ? 'All listed conditions hold on closed candles. This is not an order or a signal.' : 'Waiting — unmet conditions are listed. No action is implied.' };
}

function noTrade(a: AnalysisInput, bull: Scenario, bear: Scenario): Scenario {
  const h1 = structureOf(a.smc?.byTimeframe.H1);
  const h4 = structureOf(a.smc?.byTimeframe.H4);
  const conflict = (h1 === 'BULLISH' && h4 === 'BEARISH') || (h1 === 'BEARISH' && h4 === 'BULLISH');
  const near = (s: Scenario) => s.conditions[1]?.state === 'MET';
  const rr = (s: Scenario) => s.conditions[5]?.state === 'MET';
  const conditions: Condition[] = [
    { text: `Data not current (${a.feed.label})`, state: a.feed.current ? 'NOT_MET' : 'MET' },
    { text: `H1 (${h1}) and H4 (${h4}) structures conflict`, state: conflict ? 'MET' : 'NOT_MET' },
    { text: 'Price between zones — no rated zone within 0.5 ATR', state: !near(bull) && !near(bear) ? 'MET' : 'NOT_MET' },
    { text: `Room to the next zone below ${MIN_RR}× the risk on both sides`, state: !rr(bull) && !rr(bear) ? 'MET' : 'NOT_MET' },
    { text: 'Insufficient rated zones', state: bull.status === 'NOT AVAILABLE' && bear.status === 'NOT AVAILABLE' ? 'MET' : 'NOT_MET' },
  ];
  const active = conditions.some((c) => c.state === 'MET');
  return { kind: 'NO_TRADE', title: 'No trade', status: active ? 'ACTIVE' : 'NOT ACTIVE', conditions, levels: [], note: active ? 'At least one reason to stand aside holds.' : 'None of the stand-aside reasons hold right now.' };
}

export function scenarios(a: AnalysisInput, chartTf: Timeframe): Scenario[] {
  const bull = sideScenario(a, chartTf, 'BULLISH');
  const bear = sideScenario(a, chartTf, 'BEARISH');
  return [bull, bear, noTrade(a, bull, bear)];
}

/** Seconds per timeframe (re-exported for the UI). */
export { TF_SECONDS };
