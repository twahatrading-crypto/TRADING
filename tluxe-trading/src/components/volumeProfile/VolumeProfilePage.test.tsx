import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { dataset } from '../../engines/volumeProfile/fixtures/builders';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';
import type { Candle, Timeframe } from '../../types/market';

/* TEST DATA ONLY — synthetic candles + synthetic tick volume through a manual provider. */

const calls = { vp: 0, rows: 0, items: 0, zoomIn: 0, zoomOut: 0, fit: 0, reset: 0 };
vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setOverlays() {}
    setZones() {}
    setVolumeProfile(hist: { rows: unknown[] } | null, items: unknown[]) {
      calls.vp++;
      calls.rows = hist?.rows.length ?? 0;
      calls.items = items.length;
    }
    onVisibleRange() {
      return () => {};
    }
    onBarClick() {
      return () => {};
    }
    screenshot() {
      return document.createElement('canvas');
    }
    zoomIn() {
      calls.zoomIn++;
    }
    zoomOut() {
      calls.zoomOut++;
    }
    fitView() {
      calls.fit++;
    }
    resetView() {
      calls.reset++;
    }
    destroy() {}
  },
}));

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => {});
};
const TFS: Timeframe[] = ['D1', 'H4', 'H1', 'M30', 'M15', 'M5'];
const DS = dataset(5, 17);

function setup(withData: boolean, instrument = 'XAUUSD') {
  window.location.hash = '#/engines/volume-profile';
  const provider = new ManualPriceProvider('mt5');
  const r = renderWithServices(<App />, { price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': instrument }) });
  if (withData)
    act(() => {
      provider.sink.connection(instrument, 'LIVE');
      for (const tf of TFS) provider.sink.candles(instrument, tf, (DS[tf as keyof typeof DS] as Candle[]).map((c) => ({ ...c, isClosed: true })), 'replace');
    });
  return { ...r, provider };
}

beforeEach(() => {
  Object.assign(calls, { vp: 0, rows: 0, items: 0, zoomIn: 0, zoomOut: 0, fit: 0, reset: 0 });
  localStorage.clear();
});

describe('Volume Profile page', () => {
  it('is in the sidebar after Liquidity Heatmap and before Volume Footprint', async () => {
    window.location.hash = '#/';
    renderWithServices(<App />);
    await flush();
    const link = screen.getByRole('link', { name: /Volume Profile/ });
    expect(link.getAttribute('href')).toBe('#/engines/volume-profile');
    const labels = screen.getAllByRole('link').map((a) => a.textContent ?? '');
    const i = labels.findIndex((t) => /Volume Profile/.test(t));
    expect(labels.findIndex((t) => /Liquidity Heatmap/.test(t))).toBe(i - 1);
    expect(labels.findIndex((t) => /Volume Footprint/.test(t))).toBe(i + 1);
  });

  it('without MT5: DATA UNAVAILABLE + VOLUME DATA UNAVAILABLE, no histogram, no score, nothing invented', async () => {
    setup(false);
    await flush();
    expect(screen.getByTestId('vp-data-status').textContent).toBe('DATA UNAVAILABLE');
    expect(screen.getByTestId('vp-source').textContent).toBe('VOLUME DATA UNAVAILABLE');
    expect(screen.getByTestId('vp-poc').textContent).toBe('—');
    expect(screen.getByTestId('vp-score-total').textContent).toBe('—');
    expect(screen.queryAllByTestId('vp-log-row')).toHaveLength(0);
    expect(screen.queryAllByTestId('vp-node-row')).toHaveLength(0);
    expect(calls.rows).toBe(0);
  });

  it('GC: GC VOLUME DATA UNAVAILABLE (MT5 tick volume is never shown as COMEX volume)', async () => {
    setup(false, 'GC');
    await flush();
    expect(screen.getByTestId('vp-source').textContent).toBe('GC VOLUME DATA UNAVAILABLE');
    expect(document.querySelector('[data-testid=vp-page]')!.textContent).not.toMatch(/COMEX Exchange Volume/);
  });

  it('with closed candles: LIVE, "MT5 Tick Volume", POC / VA / MTF / sessions / score / events from the engine', async () => {
    setup(true);
    await flush();
    expect(screen.getByTestId('vp-data-status').textContent).toBe('LIVE');
    expect(screen.getByTestId('vp-source').textContent).toBe('MT5 Tick Volume');
    expect(screen.getByTestId('vp-poc').textContent).toMatch(/^\d/);
    expect(screen.getByTestId('vp-location').textContent).toMatch(/VALUE|POC/);
    expect(within(screen.getByTestId('vp-mtf')).getAllByTestId('vp-mtf-row')).toHaveLength(6);
    expect(screen.getAllByTestId('vp-session-row')).toHaveLength(5);
    expect(screen.getAllByTestId('vp-score-row')).toHaveLength(9);
    expect(screen.getByTestId('vp-score-total').textContent).toMatch(/^\d+$/);
    expect(screen.getAllByTestId('vp-log-row').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('vp-level-row').length).toBeGreaterThan(0);
    expect(calls.rows).toBeGreaterThan(0);
    expect(calls.items).toBeGreaterThan(0);
  });

  it('never shows trade signals; the score is labelled as not a probability', async () => {
    setup(true);
    await flush();
    const text = document.querySelector('[data-testid=vp-page]')!.textContent!;
    expect(text).not.toMatch(/BUY CONFIRMED|SELL CONFIRMED|ENTRY READY|Stop loss|Take profit|R:R/i);
    expect(text).toMatch(/not a probability/);
  });

  it('profile selector switches the histogram profile; toggles and navigation are view-only', async () => {
    const { services } = setup(true);
    await flush();
    const runs = services.volumeProfile.runs;
    const snap = services.volumeProfile.store.getState().snapshot;
    fireEvent.change(screen.getByTestId('vp-profile-select'), { target: { value: 'PREVIOUS_DAY' } });
    await flush();
    expect(screen.getByRole('heading', { name: /Previous day/i })).toBeTruthy();
    fireEvent.change(screen.getByTestId('vp-profile-select'), { target: { value: 'FIXED' } });
    await flush();
    expect(screen.getByTestId('vp-fixed')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Fixed range/ })).toBeTruthy();
    for (const name of ['Zoom in', 'Zoom out', 'Fit all bars and auto scale price', 'Reset chart view (Alt + R)']) fireEvent.click(screen.getByRole('button', { name }));
    const before = calls.vp;
    fireEvent.click(within(screen.getByTestId('vp-toggles')).getByRole('switch', { name: /^POC/ }));
    await flush();
    expect(calls.vp).toBeGreaterThan(before);
    expect(calls).toMatchObject({ zoomIn: 1, zoomOut: 1, fit: 1, reset: 1 });
    expect(services.volumeProfile.runs).toBe(runs);
    expect(services.volumeProfile.store.getState().snapshot).toBe(snap);
  });

  it('symbol switch clears the previous profile at once (XAUUSD → XAGUSD)', async () => {
    const { services } = setup(true);
    await flush();
    act(() => services.instruments.select('XAGUSD'));
    await flush();
    expect(screen.getByTestId('vp-poc').textContent).toBe('—');
    expect(screen.queryAllByTestId('vp-log-row')).toHaveLength(0);
    expect(screen.getByTestId('vp-data-status').textContent).not.toBe('LIVE');
  });

  it('replay: parity MATCH, chart frozen, exit restores live', async () => {
    setup(true);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Replay/ }));
    await flush();
    expect(screen.getByTestId('vp-replay-bar')).toBeTruthy();
    expect(screen.getByTestId('vp-replay-parity').textContent).toBe('MATCH');
    fireEvent.click(screen.getByRole('button', { name: 'Step forward one candle' }));
    await flush();
    expect(screen.getByTestId('vp-replay-parity').textContent).toBe('MATCH');
    expect(screen.getByTestId('vp-chart-state').textContent).toMatch(/REPLAY/);
    fireEvent.click(screen.getByRole('button', { name: /Exit Replay/ }));
    await flush();
    expect(screen.queryByTestId('vp-replay-bar')).toBeNull();
  });
});
