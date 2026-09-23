import { describe, expect, it } from 'vitest';
import { ENGINES } from '../../config/engines';
import { buildSystemStatus, feedStatusValue, STATUS_TONE, type StatusInputs } from './systemStatus';

const phase1: StatusInputs = {
  browserOnline: true,
  instrument: 'GC',
  price: { connection: 'UNAVAILABLE', error: null, supported: true },
  depth: { connection: 'UNAVAILABLE', error: null, supported: true },
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
      'Price Data · GC': 'NOT CONNECTED',
      'Depth Data · GC': 'NOT CONNECTED',
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

describe('price and depth are reported independently per instrument', () => {
  it('MT5-style price connected does not imply depth', () => {
    const v = byLabel({ ...phase1, instrument: 'GC', price: { connection: 'LIVE', error: null, supported: true } });
    expect(v['Price Data · GC']).toBe('CONNECTED');
    expect(v['Depth Data · GC']).toBe('NOT CONNECTED');
  });

  it('instruments without any depth source report UNSUPPORTED, not NOT CONNECTED', () => {
    const v = byLabel({ ...phase1, instrument: 'EURUSD', depth: { connection: 'UNAVAILABLE', error: null, supported: false } });
    expect(v['Depth Data · EURUSD']).toBe('UNSUPPORTED');
  });

  it('labels rows with the active instrument', () => {
    expect(Object.keys(byLabel({ ...phase1, instrument: 'XAUUSD' }))).toContain('Price Data · XAUUSD');
  });
});

describe('status mapping', () => {
  it('application follows browser connectivity', () => {
    expect(byLabel({ ...phase1, browserOnline: false }).Application).toBe('OFFLINE');
  });

  it.each([
    ['LIVE', null, true, 'CONNECTED'],
    ['DELAYED', null, true, 'CONNECTED'],
    ['CONNECTING', null, true, 'NOT CONNECTED'],
    ['DISCONNECTED', null, true, 'NOT CONNECTED'],
    ['UNAVAILABLE', null, true, 'NOT CONNECTED'],
    ['LIVE', 'auth failed', true, 'ERROR'],
    ['LIVE', null, false, 'UNSUPPORTED'],
  ] as const)('feed %s / error=%s / supported=%s → %s', (connection, error, supported, out) => {
    expect(feedStatusValue({ connection, error, supported })).toBe(out);
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
    expect(STATUS_TONE.UNSUPPORTED).toBe('off');
    expect(STATUS_TONE.CONNECTED).toBe('ok');
  });
});
