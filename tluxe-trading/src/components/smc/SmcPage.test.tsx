import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { SMC_TIMEFRAMES } from '../../engines/smc/config';
import { candles } from '../../engines/smc/fixtures/builders';
import * as S from '../../engines/smc/fixtures/scenarios';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';
import type { Candle, Timeframe } from '../../types/market';

/* TEST DATA ONLY — synthetic candles through a manual provider. */

const calls = { smc: 0, zoomIn: 0, zoomOut: 0, fit: 0, reset: 0, lastItems: 0 };
vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setOverlays() {}
    setZones() {}
    setSmc(items: unknown[]) {
      calls.smc++;
      calls.lastItems = items.length;
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
const series = (tf: Timeframe, src: () => Candle[] = S.bullishReversal): Candle[] => {
  const s = src();
  const ov: Record<number, Partial<Candle>> = {};
  s.forEach((x, i) => (ov[i] = { open: x.open, high: x.high, low: x.low }));
  const c = candles(s.map((x) => x.close), { tf, ov });
  return c.map((x, i) => ({ ...x, isClosed: i < c.length - 1 }));
};

function setup(withData: boolean) {
  window.location.hash = '#/engines/smc';
  const provider = new ManualPriceProvider('mt5');
  const r = renderWithServices(<App />, { price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'XAUUSD' }) });
  if (withData)
    act(() => {
      provider.sink.connection('XAUUSD', 'LIVE');
      for (const tf of SMC_TIMEFRAMES) provider.sink.candles('XAUUSD', tf, series(tf), 'replace');
    });
  return { ...r, provider };
}

beforeEach(() => {
  Object.assign(calls, { smc: 0, zoomIn: 0, zoomOut: 0, fit: 0, reset: 0, lastItems: 0 });
  localStorage.clear();
});

describe('SMC page', () => {
  it('is in the sidebar under Trading Strategy (route /engines/smc)', async () => {
    window.location.hash = '#/';
    renderWithServices(<App />);
    await flush();
    const link = screen.getByRole('link', { name: /Smart Money Concepts/ });
    expect(link.getAttribute('href')).toBe('#/engines/smc');
  });

  it('without MT5: DATA UNAVAILABLE everywhere, never LIVE, no score, no invented objects', async () => {
    setup(false);
    await flush();
    expect(screen.getByTestId('smc-data-status').textContent).toBe('DATA UNAVAILABLE');
    expect(screen.getByTestId('smc-state').textContent).toMatch(/DATA UNAVAILABLE/);
    expect(screen.getByTestId('smc-chart-state').textContent).toMatch(/DATA UNAVAILABLE/);
    expect(screen.getByTestId('smc-score-total').textContent).toBe('—');
    expect(document.body.textContent).not.toMatch(/\bLIVE\b(?! chart)/);
    expect(screen.queryAllByTestId('smc-log-row')).toHaveLength(0);
    expect(within(screen.getByTestId('smc-pd')).getByText('DATA UNAVAILABLE')).toBeTruthy();
  });

  it('with real-shaped closed candles: LIVE, structure, sequence, matrix, score and events from the engine', async () => {
    setup(true);
    await flush();
    expect(screen.getByTestId('smc-data-status').textContent).toBe('LIVE');
    expect(screen.getByTestId('smc-chart-state').textContent).toMatch(/LIVE/);
    expect(within(screen.getByTestId('smc-structure')).getByText('BULLISH')).toBeTruthy();
    const stages = screen.getAllByTestId('smc-seq-stage');
    expect(stages).toHaveLength(7);
    expect(stages.filter((s) => s.textContent!.includes('CONFIRMED')).length).toBeGreaterThanOrEqual(5);
    expect(within(screen.getByTestId('smc-matrix')).getAllByRole('row')).toHaveLength(8);
    expect(screen.getByTestId('smc-score-total').textContent).toMatch(/^\d+$/);
    expect(screen.getAllByTestId('smc-log-row').length).toBeGreaterThan(0);
    expect(calls.lastItems).toBeGreaterThan(0);
  });

  it('never shows trade signals, entries, stop loss or take profit', async () => {
    setup(true);
    await flush();
    const text = document.querySelector('[data-testid=smc-page]')!.textContent!;
    expect(text).not.toMatch(/BUY CONFIRMED|SELL CONFIRMED|ENTRY READY|Stop loss|Take profit|R:R/i);
    expect(text).toMatch(/not a probability of winning/);
  });

  it('clicking a timeframe changes the chart timeframe (tabs and matrix links)', async () => {
    setup(true);
    await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'H1' }));
    await flush();
    expect(screen.getByRole('heading', { name: /XAUUSD · H1/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show M5 on the chart' }));
    await flush();
    expect(screen.getByRole('heading', { name: /XAUUSD · M5/ })).toBeTruthy();
    expect(within(screen.getByTestId('smc-structure')).getByText(/Market Structure · M5/)).toBeTruthy();
  });

  it('navigation and overlay toggles are view-only: the engine is never re-run', async () => {
    const { services } = setup(true);
    await flush();
    const runs = services.smc.runs;
    const snap = services.smc.store.getState().snapshot;
    for (const name of ['Zoom in', 'Zoom out', 'Fit all bars and auto scale price', 'Reset chart view (Alt + R)']) fireEvent.click(screen.getByRole('button', { name }));
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR', altKey: true });
    const before = calls.smc;
    fireEvent.click(within(screen.getByTestId('smc-toggles')).getByRole('switch', { name: /Order Blocks/ }));
    await flush();
    expect(calls.smc).toBeGreaterThan(before); // redraw only
    expect(calls).toMatchObject({ zoomIn: 1, zoomOut: 1, fit: 1 });
    expect(calls.reset).toBe(2);
    expect(services.smc.runs).toBe(runs);
    expect(services.smc.store.getState().snapshot).toBe(snap);
  });

  it('symbol switch clears the previous analysis at once (XAUUSD → XAGUSD)', async () => {
    const { services } = setup(true);
    await flush();
    act(() => services.instruments.select('XAGUSD'));
    await flush();
    expect(within(screen.getByTestId('smc-structure')).queryByText('BULLISH')).toBeNull();
    expect(screen.queryAllByTestId('smc-log-row')).toHaveLength(0);
    expect(screen.getByTestId('smc-data-status').textContent).not.toBe('LIVE');
  });

  it('replay: parity MATCH and the live chart is frozen', async () => {
    setup(true);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Replay/ }));
    await flush();
    expect(screen.getByTestId('smc-replay-bar')).toBeTruthy();
    expect(screen.getByTestId('smc-replay-parity').textContent).toBe('MATCH');
    fireEvent.click(screen.getByRole('button', { name: 'Step forward one candle' }));
    await flush();
    expect(screen.getByTestId('smc-replay-parity').textContent).toBe('MATCH');
    expect(screen.getByTestId('smc-chart-state').textContent).toMatch(/REPLAY/);
    fireEvent.click(screen.getByRole('button', { name: /Exit Replay/ }));
    await flush();
    expect(screen.queryByTestId('smc-replay-bar')).toBeNull();
  });
});
