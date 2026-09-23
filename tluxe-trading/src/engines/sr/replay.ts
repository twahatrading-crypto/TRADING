import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import { SRTimeframeEngine } from './engine';
import type { SRSettings } from './settings';
import { canTransition } from './stateMachine';
import type { SRSnapshot, SRZone, SRZoneDefinition } from './types';

export type ReplayEventType =
  | 'zoneConfirmed'
  | 'interactionStarted'
  | 'interactionResolved'
  | 'statusChanged'
  | 'broken'
  | 'flipped'
  | 'scoreChanged';

export interface ReplayEvent {
  /** Number of candles fed (the last one is forming unless lastBarClosed). */
  step: number;
  /** Newest closed bar time when the event was observed. */
  observedAt: number | null;
  type: ReplayEventType;
  zoneId: string;
  detail: string;
}

export interface ReplayResult {
  events: ReplayEvent[];
  /** Anti-repaint / no-lookahead violations. Must be empty. */
  violations: string[];
  final: SRSnapshot;
  /** Frozen definitions keyed by zone id, as first observed. */
  firstSeen: Map<string, SRZoneDefinition & { step: number }>;
}

const FROZEN: (keyof SRZoneDefinition)[] = [
  'id', 'instrumentId', 'timeframe', 'type', 'zoneLow', 'zoneHigh', 'midPrice', 'width',
  'pivotId', 'createdAt', 'confirmedAt', 'confirmedIndex', 'atrAtConfirmation',
];

/**
 * Deterministic S&R replay harness. Feeds candles one at a time, exactly as a
 * live feed would, and records what the engine knew at each step. Verifies:
 *  - zones never disappear once confirmed and their frozen fields never change;
 *  - nothing (zone confirmation, interaction start, break, flip) is dated after
 *    the newest closed bar at the time it was reported (no lookahead);
 *  - every status transition is allowed by the state machine.
 * This is not a trading backtester — it validates S&R behaviour only.
 */
export function replaySR(opts: {
  instrumentId: InstrumentId;
  timeframe: Timeframe;
  candles: readonly Candle[];
  tickSize: number;
  settings: SRSettings;
  lastBarClosed?: boolean;
}): ReplayResult {
  const engine = new SRTimeframeEngine(opts);
  const events: ReplayEvent[] = [];
  const violations: string[] = [];
  const firstSeen = new Map<string, SRZoneDefinition & { step: number }>();
  let prev = new Map<string, SRZone>();
  let snap = engine.snapshot();

  for (let n = 1; n <= opts.candles.length; n++) {
    engine.update(opts.candles.slice(0, n), { lastBarClosed: opts.lastBarClosed });
    snap = engine.snapshot();
    const now = snap.lastClosedTime;
    const cur = new Map(snap.zones.map((z) => [z.id, z]));
    const ev = (type: ReplayEventType, zoneId: string, detail: string) => events.push({ step: n, observedAt: now, type, zoneId, detail });
    const late = (t: number | null, what: string, id: string) => {
      if (t !== null && now !== null && t > now) violations.push(`step ${n}: ${id} ${what} ${t} is after newest closed bar ${now}`);
    };

    for (const id of prev.keys()) if (!cur.has(id) && snap.state === 'READY') violations.push(`step ${n}: zone ${id} disappeared`);

    for (const z of snap.zones) {
      const first = firstSeen.get(z.id);
      if (!first) {
        firstSeen.set(z.id, { ...(Object.fromEntries(FROZEN.map((k) => [k, z[k]])) as unknown as SRZoneDefinition), step: n });
        ev('zoneConfirmed', z.id, `${z.type} ${z.zoneLow}–${z.zoneHigh} confirmed ${z.confirmedAt}`);
        late(z.confirmedAt, 'confirmedAt', z.id);
      } else {
        for (const k of FROZEN) if (first[k] !== z[k]) violations.push(`step ${n}: zone ${z.id} frozen field ${k} changed ${String(first[k])} → ${String(z[k])}`);
      }
      const p = prev.get(z.id);
      for (const it of z.interactions) late(it.startTime, 'interaction start', it.id);
      late(z.brokenAt, 'brokenAt', z.id);
      late(z.flippedAt, 'flippedAt', z.id);
      if (!p) continue;
      for (let k = p.interactions.length; k < z.interactions.length; k++) ev('interactionStarted', z.id, z.interactions[k]!.id);
      z.interactions.forEach((it, k) => {
        const before = p.interactions[k];
        if (before && before.outcome === 'pending' && it.outcome !== 'pending') ev('interactionResolved', z.id, `${it.id} → ${it.outcome}`);
      });
      if (p.status !== z.status) {
        if (!canTransition(p.status, z.status)) violations.push(`step ${n}: illegal ${p.status} → ${z.status} on ${z.id}`);
        ev('statusChanged', z.id, `${p.status} → ${z.status}`);
      }
      if (p.brokenAt === null && z.brokenAt !== null) ev('broken', z.id, `${z.breakEvidence?.rule} at ${z.brokenAt}`);
      if (p.flippedAt !== z.flippedAt && z.flippedAt !== null) ev('flipped', z.id, `${p.role} → ${z.role}`);
      if (p.score.total !== z.score.total) ev('scoreChanged', z.id, `${p.score.total} → ${z.score.total}`);
    }
    prev = cur;
  }
  return { events, violations, final: snap, firstSeen };
}
