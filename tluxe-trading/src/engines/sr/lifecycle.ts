import { TIMEFRAME_SECONDS } from './settings';
import type { SRZone } from './types';

export type LifecycleKind = 'structure' | 'confirmed' | 'touch' | 'resolved' | 'break' | 'flip' | 'expired';

export interface LifecycleEvent {
  kind: LifecycleKind;
  /** Open time of the bar the event belongs to (UTC s). */
  barTime: number;
  /**
   * When the event became KNOWABLE: the close of the bar that decided it.
   * For 'structure' this is the confirmation close — a swing is not knowable
   * as a swing until pivotRight later bars have closed.
   */
  knownAt: number;
  detail: string;
}

/**
 * Deterministic lifecycle of one zone, derived only from what the engine
 * recorded (no recomputation). Every zone can break, flip and break again, so
 * all breaks and flips are listed, not just the latest.
 */
export function zoneLifecycle(z: SRZone): LifecycleEvent[] {
  const tf = TIMEFRAME_SECONDS[z.timeframe];
  const closeOf = (t: number) => t + tf;
  const events: LifecycleEvent[] = [
    { kind: 'structure', barTime: z.createdAt, knownAt: closeOf(z.confirmedAt), detail: `${z.type === 'support' ? 'swing low' : 'swing high'} bar` },
    {
      kind: 'confirmed',
      barTime: z.confirmedAt,
      knownAt: closeOf(z.confirmedAt),
      detail: `${z.type} ${z.zoneLow}–${z.zoneHigh} (bounds frozen)`,
    },
  ];
  z.interactions.forEach((it, k) => {
    events.push({ kind: 'touch', barTime: it.startTime, knownAt: closeOf(it.startTime), detail: `touch #${k + 1} as ${it.role}${it.phase === 'retest' ? ' (retest)' : ''}` });
    // A rejection is listed at the bar it was decided, even if the same episode later broke the zone.
    // Touches resolved BY the break are covered by the 'break' event.
    if (it.resolvedTime !== null && (it.rejected === true || !it.broke)) {
      events.push({
        kind: 'resolved',
        barTime: it.resolvedTime,
        knownAt: closeOf(it.resolvedTime),
        detail: `touch #${k + 1}: ${it.rejected ? `rejected (${it.rejectionAtr.toFixed(2)} ATR)` : 'no rejection'}${it.broke ? ' · later broke' : ''}`,
      });
    }
  });
  for (const h of z.statusHistory) {
    if (h.to === 'BROKEN') events.push({ kind: 'break', barTime: h.time, knownAt: closeOf(h.time), detail: h.reason });
    if (h.to === 'EXPIRED') events.push({ kind: 'expired', barTime: h.time, knownAt: closeOf(h.time), detail: h.reason });
  }
  for (const r of z.roleHistory) events.push({ kind: 'flip', barTime: r.time, knownAt: closeOf(r.time), detail: `${r.from} → ${r.to}` });

  const order: Record<LifecycleKind, number> = { structure: 0, confirmed: 1, touch: 2, resolved: 3, break: 4, flip: 5, expired: 6 };
  return events.sort((a, b) => a.barTime - b.barTime || order[a.kind] - order[b.kind]);
}
