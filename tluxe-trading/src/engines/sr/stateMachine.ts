import type { ZoneStatus } from './types';

/**
 * Zone lifecycle. Every status change the engine makes must be listed here;
 * `assertTransition` enforces it at runtime and tests verify it on replays.
 *
 * FRESH      confirmed, never interacted with since confirmation
 * ACTIVE     price is interacting with the zone right now (episode open)
 * TESTED     interacted ≥ 1 time, holding, not weakened
 * WEAKENING  holding but degraded: resolved interactions ≥ weakeningTouches,
 *            OR any close-through, OR the last two resolved interactions were
 *            not rejections. Sticky while the zone holds.
 * BROKEN     break confirmed (see engine break rule); awaiting a possible flip
 * FLIPPED    after a break, a retest from the other side was rejected → role reversed
 * EXPIRED    holding zone untouched for expiryBars, or broken zone not flipped
 *            within flipWindowBars. Terminal.
 */
export const ZONE_TRANSITIONS: Readonly<Record<ZoneStatus, readonly ZoneStatus[]>> = Object.freeze({
  FRESH: ['ACTIVE', 'BROKEN', 'EXPIRED'],
  ACTIVE: ['TESTED', 'WEAKENING', 'BROKEN'],
  TESTED: ['ACTIVE', 'WEAKENING', 'BROKEN', 'EXPIRED'],
  WEAKENING: ['ACTIVE', 'BROKEN', 'EXPIRED'],
  BROKEN: ['FLIPPED', 'EXPIRED'],
  FLIPPED: ['BROKEN', 'EXPIRED'],
  EXPIRED: [],
});

export function canTransition(from: ZoneStatus, to: ZoneStatus): boolean {
  return from === to || ZONE_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {}

export function assertTransition(from: ZoneStatus, to: ZoneStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(`Illegal zone transition ${from} → ${to}`);
}

/** Statuses in which the zone still acts in its current role. */
export const HOLDING_STATUSES: readonly ZoneStatus[] = ['FRESH', 'ACTIVE', 'TESTED', 'WEAKENING', 'FLIPPED'];

export const isHolding = (s: ZoneStatus) => HOLDING_STATUSES.includes(s);
