import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { walk } from '../../engines/liquidity/fixtures/builders';
import * as F from '../../engines/liquidity/fixtures/scenarios';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';
import type { Timeframe } from '../../types/market';

const setLiquidity = vi.fn();
const setEventMarkers = vi.fn();
vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setOverlays() {}
    setZones() {}
    setLiquidity(x: unknown) {
      setLiquidity(x);
    }
    setEventMarkers(x: unknown) {
      setEventMarkers(x);
    }
    onBarClick() {
      return () => {};
    }
    screenshot() {
      return document.createElement('canvas');
    }
    destroy() {}
  },
}));

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};

function setup(withData = true) {
  window.location.hash = '#/engines/liquidity';
  const provider = new ManualPriceProvider('mt5');
  const r = renderWithServices(<App />, { price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'XAUUSD', 'tluxe.lq.chartTf.XAUUSD': '"H1"' }) });
  if (withData) {
    act(() => {
      provider.sink.connection('XAUUSD', 'LIVE');
      provider.sink.candles('XAUUSD', 'H1', F.repeatedSweep().map((c, i, a) => ({ ...c, isClosed: i < a.length - 1 })), 'replace');
      for (const tf of ['M5', 'M15', 'H4'] as Timeframe[]) provider.sink.candles('XAUUSD', tf, walk(300, { seed: tf.length, start: 130, vol: 1.5, tf }).map((c, i, a) => ({ ...c, isClosed: i < a.length - 1 })), 'replace');
    });
  }
  return { ...r, provider };
}

beforeEach(() => {
  setLiquidity.mockClear();
  setEventMarkers.mockClear();
});

describe('Liquidity page', () => {
  it('is reachable from the sidebar and is its own page (not inside S&R)', async () => {
    window.location.hash = '#/';
    renderWithServices(<App />);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Liquidity' }));
    act(() => {
      window.location.hash = '#/engines/liquidity';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await flush();
    expect(window.location.hash).toBe('#/engines/liquidity');
    expect(screen.getByRole('heading', { name: 'Liquidity' })).toBeInTheDocument();
    expect(document.querySelector('.srgrid.lqgrid')).not.toBeNull();
  });

  it('without data: MARKET DATA OFFLINE, no pools, Replay disabled — nothing simulated', async () => {
    setup(false);
    await flush();
    expect(screen.getByTestId('lq-chart-state')).toHaveTextContent('MARKET DATA OFFLINE');
    expect(screen.getByRole('button', { name: /Replay/ })).toBeDisabled();
    expect(screen.queryAllByTestId(/pool-row-/)).toHaveLength(0);
  });

  it('with real-feed data: LIQUIDITY LIVE, pools table, details and strength components on selection', async () => {
    setup();
    await flush();
    expect(screen.getByTestId('lq-chart-state')).toHaveTextContent('LIQUIDITY LIVE');
    const rows = screen.getAllByTestId(/pool-row-/);
    expect(rows.length).toBeGreaterThan(0);
    fireEvent.click(rows[0]!);
    await flush();
    expect(within(screen.getByTestId('lq-details')).getByText('Level (to be taken)')).toBeInTheDocument();
    expect(screen.getByTestId('lq-score-equalLevels').textContent).not.toContain('—');
    expect(setLiquidity).toHaveBeenCalled();
  });

  it('never shows BUY / SELL / LONG / SHORT / ENTRY / TP / SL', async () => {
    setup();
    await flush();
    for (const tab of ['Pools', 'Sweeps', 'Multi-Timeframe', 'Analysis', 'Settings']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      await flush();
      const text = document.body.textContent ?? '';
      expect(text).not.toMatch(/\b(BUY|SELL|LONG|SHORT|ENTRY|TP|SL)\b/);
    }
  });

  it('stale feed → DATA STALE, never LIVE', async () => {
    const { provider } = setup();
    act(() => provider.sink.connection('XAUUSD', 'DISCONNECTED'));
    await flush();
    expect(screen.getByTestId('lq-chart-state')).toHaveTextContent('DATA STALE');
    expect(screen.getByTestId('lq-chart-state')).not.toHaveTextContent('LIQUIDITY LIVE');
  });

  it('replay: enter, step exactly one candle, exit back to live; S&R replay untouched', async () => {
    const { services } = setup();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Replay/ }));
    await flush();
    const count = () => Number(screen.getByTestId('lq-replay-count').textContent!.split('/')[0]!.replace(/,/g, ''));
    const before = count();
    fireEvent.click(screen.getByRole('button', { name: 'Step forward one candle' }));
    await flush();
    expect(count()).toBe(before + 1);
    expect(screen.getByTestId('lq-chart-state')).toHaveTextContent('LIQUIDITY REPLAY');
    fireEvent.click(screen.getByRole('button', { name: /Exit Replay/ }));
    await flush();
    expect(screen.queryByTestId('lq-replay-bar')).toBeNull();
    expect(screen.getByTestId('lq-chart-state')).toHaveTextContent('LIQUIDITY LIVE');
    expect(services.sr.store('XAUUSD').getState().byTimeframe.H1).toBeDefined();
  });
});
