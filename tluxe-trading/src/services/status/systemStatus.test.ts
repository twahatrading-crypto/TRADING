import { describe, expect, it } from 'vitest';
import { ENGINES } from '../../config/engines';
import { buildSystemStatus, marketStatusValue, STATUS_TONE, type StatusInputs } from './systemStatus';

const phase1: StatusInputs = {
  browserOnline: true,
  market: { connection: 'UNAVAILABLE', error: null },
  ai: 'NOT_CONNECTED',
  database: 'NOT_CONNECTED',
  news: 'NOT_CONNECTED',
  calendar: 'NOT_CONNECTED',
  engines: ENGINES,
};

const byLabel = (inputs: StatusInputs) => Object.fromEntries(buildSystemStatus(inputs).map((i) => [i.label, i.value]));

describe('buildSystemStatus — Phase 1 defaults', () => {
  it('matches the truthful Phase 1 state', () => {
    expect(byLabel(phase1)).toEqual({
      Application: 'ONLINE',
      'Market Data': 'NOT CONNECTED',
      AI: 'NOT CONNECTED',
      Database: 'NOT CONNECTED',
      News: 'NOT CONNECTED',
      'Economic Calendar': 'NOT CONNECTED',
      'Order Block Engine': 'DISABLED',
      'Liquidity Engine': 'DISABLED',
      'Support & Resistance Engine': 'DISABLED',
      'Sweep/Reversal Engine': 'DISABLED',
    });
  });

  it('never reports CONNECTED or ONLINE for any provider or engine', () => {
    const items = buildSystemStatus(phase1).filter((i) => i.id !== 'app');
    expect(items.some((i) => i.value === 'CONNECTED' || i.value === 'ONLINE')).toBe(false);
  });
});

describe('status mapping', () => {
  it('application follows browser connectivity', () => {
    expect(byLabel({ ...phase1, browserOnline: false }).Application).toBe('OFFLINE');
  });

  it.each([
    ['LIVE', null, 'CONNECTED'],
    ['DELAYED', null, 'CONNECTED'],
    ['CONNECTING', null, 'NOT CONNECTED'],
    ['DISCONNECTED', null, 'NOT CONNECTED'],
    ['UNAVAILABLE', null, 'NOT CONNECTED'],
    ['LIVE', 'auth failed', 'ERROR'],
  ] as const)('market %s / error=%s → %s', (conn, err, out) => {
    expect(marketStatusValue(conn, err)).toBe(out);
  });

  it('provider errors surface as ERROR', () => {
    expect(byLabel({ ...phase1, news: 'ERROR' }).News).toBe('ERROR');
  });

  it('an enabled engine without an implementation is an ERROR, not ONLINE', () => {
    const items = buildSystemStatus({ ...phase1, engines: [{ id: 'x', label: 'X', enabled: true }] });
    expect(items.find((i) => i.id === 'engine-x')?.value).toBe('ERROR');
  });

  it('maps every value to a tone', () => {
    expect(STATUS_TONE['NOT CONNECTED']).toBe('warn');
    expect(STATUS_TONE.DISABLED).toBe('off');
    expect(STATUS_TONE.CONNECTED).toBe('ok');
  });
});
