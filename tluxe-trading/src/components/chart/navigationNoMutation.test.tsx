import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { DEFAULT_HLE_SETTINGS, HLE_TIMEFRAMES } from '../../engines/highLowEngine/config';
import { analyzeHighLow } from '../../engines/highLowEngine/engine';
import * as F from '../../engines/highLowEngine/fixtures/scenarios';
import { hleKnownInput } from '../../engines/highLowEngine/knowledge';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';

const calls = { data: 0, overlays: 0, zoomIn: 0, zoomOut: 0, fitView: 0, resetView: 0 };
vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({
  ChartController: class {
    setData() { calls.data++; }
    upsert() { calls.data++; }
    setOverlays() { calls.overlays++; }
    setZones() { calls.overlays++; }
    setHighLowEngine() { calls.overlays++; }
    onBarClick() { return () => {}; }
    screenshot() { return document.createElement('canvas'); }
    zoomIn() { calls.zoomIn++; }
    zoomOut() { calls.zoomOut++; }
    fitView() { calls.fitView++; }
    resetView() { calls.resetView++; }
    destroy() {}
  },
}));
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};

describe('chart navigation is presentation only', () => {
  it('zoom / fit / reset / Alt+R never request data, recalculate engines, change signals, logs or alerts', async () => {
    const c = F.buyReversal();
    const s = analyzeHighLow({ instrumentId: 'XAUUSD', tickSize: 0.01, candles: c }).setups.find((x) => x.entry)!;
    const data = hleKnownInput({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: { ...DEFAULT_HLE_SETTINGS }, candles: c }, s.entry!.knownAt);
    window.location.hash = '#/engines/high-low-engine';
    const provider = new ManualPriceProvider('mt5');
    const storage = memoryStorage({ 'tluxe.instrument.v1': 'XAUUSD', 'tluxe.hle.chartTf.XAUUSD': '"M15"' });
    const { services } = renderWithServices(<App />, { price: [provider] }, { storage });
    act(() => {
      provider.sink.connection('XAUUSD', 'LIVE');
      for (const tf of HLE_TIMEFRAMES) provider.sink.candles('XAUUSD', tf, (data[tf] ?? []).map((x) => ({ ...x, isClosed: true })), 'replace');
    });
    await flush();
    expect(screen.getByTestId('hle-signal')).toHaveTextContent('BUY CONFIRMED');

    const stores = [services.market, services.sr, services.liquidity, services.orderBlocks, services.hlReversal, services.highLow].map((x) => x.store('XAUUSD'));
    const before = stores.map((x) => x.getState());
    const signal = JSON.stringify(services.highLow.store('XAUUSD').getState().snapshot);
    const log = services.highLow.log.get('XAUUSD').length;
    const requests = provider.requestCandles.mock.calls.length;
    const drawn = { ...calls };
    const alertSpy = vi.spyOn(services.highLow.alerts, 'observe');
    const persisted = JSON.stringify([...storage.data]);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: /Fit all bars/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset chart view (Alt + R)' }));
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR', altKey: true });
    await flush();

    expect([calls.zoomIn, calls.zoomOut, calls.fitView, calls.resetView]).toEqual([drawn.zoomIn + 1, drawn.zoomOut + 1, drawn.fitView + 1, drawn.resetView + 2]);
    expect(calls.data).toBe(drawn.data); // no candle re-feed
    expect(calls.overlays).toBe(drawn.overlays); // no overlay re-computation
    stores.forEach((x, i) => expect(x.getState()).toBe(before[i])); // no store update in ANY engine
    expect(JSON.stringify(services.highLow.store('XAUUSD').getState().snapshot)).toBe(signal);
    expect(services.highLow.log.get('XAUUSD').length).toBe(log);
    expect(provider.requestCandles.mock.calls.length).toBe(requests);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(JSON.stringify([...storage.data])).toBe(persisted); // nothing persisted (signal log, alert ids, settings)
    expect(screen.getByTestId('hle-signal')).toHaveTextContent('BUY CONFIRMED');
  });
});
