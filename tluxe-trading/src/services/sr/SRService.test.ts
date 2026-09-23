import { describe, expect, it } from 'vitest';
import { INSTRUMENTS } from '../../config/instruments';
import * as F from '../../engines/sr/fixtures/scenarios';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { connectServices, createServices, defaultProviders } from '../registry';
import { SR_SETTINGS_KEY } from './SRService';

function setup(storage = memoryStorage()) {
  const futures = new ManualPriceProvider('futures-feed');
  const mt5 = new ManualPriceProvider('mt5');
  const services = createServices({ ...defaultProviders(), price: [futures, mt5] }, { storage });
  connectServices(services);
  return { services, futures, mt5, storage };
}

describe('SRService', () => {
  it('requests candles for all seven timeframes of the active instrument', () => {
    const { futures } = setup();
    expect(futures.requestCandles.mock.calls.map((c) => c.join(':')).sort()).toEqual(
      ['GC:D1', 'GC:H1', 'GC:H4', 'GC:M1', 'GC:M15', 'GC:M30', 'GC:M5'],
    );
  });

  it('produces no zones without real candles', () => {
    const { services } = setup();
    for (const i of INSTRUMENTS) expect(services.sr.store(i.id).getState().multi).toBeNull();
  });

  it('analyses candles as they arrive, per timeframe, outside React', () => {
    const { services, futures } = setup();
    futures.sink.candles('GC', 'H1', F.strongSupport('H1'), 'replace');
    const st = services.sr.store('GC').getState();
    expect(st.byTimeframe.H1?.state).toBe('READY');
    expect(st.multi!.zones.length).toBeGreaterThan(0);
    expect(st.multi!.zones.every((z) => z.instrumentId === 'GC' && z.timeframe === 'H1')).toBe(true);
    expect(st.byTimeframe.M15).toBeUndefined();
  });

  it('builds confluence across independently analysed timeframes', () => {
    const { services, futures } = setup();
    futures.sink.candles('GC', 'H1', F.strongSupport('H1'), 'replace');
    futures.sink.candles('GC', 'H4', F.h4SupportNear100(), 'replace');
    expect(services.sr.store('GC').getState().multi!.confluences.some((c) => c.timeframes.includes('H4') && c.timeframes.includes('H1'))).toBe(true);
  });

  it('keeps instruments separate and follows the selected symbol', () => {
    const { services, futures, mt5 } = setup();
    futures.sink.candles('GC', 'H1', F.strongSupport('H1'), 'replace');
    services.instruments.select('XAUUSD');
    expect(mt5.requestCandles.mock.calls.some((c) => c[0] === 'XAUUSD')).toBe(true);
    expect(services.sr.store('XAUUSD').getState().multi).toBeNull();
    // GC data arriving while XAUUSD is active does not leak into XAUUSD.
    futures.sink.candles('GC', 'H4', F.h4SupportNear100(), 'replace');
    expect(services.sr.store('XAUUSD').getState().multi).toBeNull();
  });

  it('settings changes are sanitised, persisted and recalculate deterministically', () => {
    const { services, futures, storage } = setup();
    futures.sink.candles('GC', 'H1', F.strongSupport('H1'), 'replace');
    const before = services.sr.store('GC').getState().byTimeframe.H1!;
    services.sr.setSettings({ pivotRight: 5, pivotLeft: 99 });
    const after = services.sr.store('GC').getState().byTimeframe.H1!;
    expect(services.sr.settings.pivotRight).toBe(5);
    expect(services.sr.settings.pivotLeft).toBe(10); // clamped
    expect(after.settingsKey).not.toBe(before.settingsKey);
    expect(JSON.parse(storage.data.get(SR_SETTINGS_KEY)!).pivotRight).toBe(5);
    // A new session restores the persisted settings.
    expect(setup(storage).services.sr.settings.pivotRight).toBe(5);
    services.sr.resetSettings();
    expect(services.sr.settings.pivotRight).toBe(3);
  });
});
