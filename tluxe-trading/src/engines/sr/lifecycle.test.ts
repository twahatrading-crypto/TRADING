import { describe, expect, it } from 'vitest';
import { analyzeTimeframe } from './engine';
import * as F from './fixtures/scenarios';
import { zoneLifecycle } from './lifecycle';
import { DEFAULT_SR_SETTINGS } from './settings';

const S = { ...DEFAULT_SR_SETTINGS };

describe('zone lifecycle', () => {
  const snap = analyzeTimeframe({ instrumentId: 'XAUUSD', timeframe: 'H1', tickSize: 0.01, settings: S, candles: F.supportToResistanceFlip(), lastBarClosed: true });
  const zone = snap.zones.find((z) => z.roleHistory.length > 0)!;
  const events = zoneLifecycle(zone);

  it('lists structure, confirmation, touches, break and flip in time order', () => {
    const kinds = events.map((e) => e.kind);
    expect(kinds.slice(0, 2)).toEqual(['structure', 'confirmed']);
    expect(kinds).toContain('touch');
    expect(kinds.indexOf('break')).toBeGreaterThan(kinds.indexOf('touch'));
    expect(kinds.indexOf('flip')).toBeGreaterThan(kinds.indexOf('break'));
    for (let i = 1; i < events.length; i++) expect(events[i]!.barTime).toBeGreaterThanOrEqual(events[i - 1]!.barTime);
  });

  it('never dates knowledge earlier than it was knowable', () => {
    for (const e of events) expect(e.knownAt).toBeGreaterThan(e.barTime);
    // The swing bar is only knowable once the confirmation bar closes (pivotRight bars later).
    const structure = events.find((e) => e.kind === 'structure')!;
    expect(structure.knownAt).toBe(zone.confirmedAt + 3600);
    expect(structure.knownAt - structure.barTime).toBe((S.pivotRight + 1) * 3600);
    // Nothing after confirmation is knowable before the zone itself.
    for (const e of events.filter((x) => x.kind !== 'structure')) expect(e.knownAt).toBeGreaterThanOrEqual(structure.knownAt);
  });
});
