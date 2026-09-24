import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { walk } from '../../engines/orderBlocks/fixtures/builders';
import * as F from '../../engines/orderBlocks/fixtures/scenarios';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';
import type { Timeframe } from '../../types/market';
import type { OBDrawable } from './obView';

const setOrderBlocks = vi.fn<(x: OBDrawable[]) => void>();
vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setOverlays() {}
    setZones() {}
    setOrderBlocks(x: OBDrawable[]) {
      setOrderBlocks(x);
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

function setup(withData = true, instrument = 'XAUUSD') {
  window.location.hash = '#/engines/order-blocks';
  const provider = new ManualPriceProvider('mt5');
  const r = renderWithServices(<App />, { price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': instrument, [`tluxe.ob.chartTf.${instrument}`]: '"H1"' }) });
  if (withData) {
    act(() => {
      provider.sink.connection(instrument, 'LIVE');
      provider.sink.candles(instrument, 'H1', F.retest().map((c, i, a) => ({ ...c, isClosed: i < a.length - 1 })), 'replace');
      for (const tf of ['M5', 'M15', 'H4'] as Timeframe[]) provider.sink.candles(instrument, tf, walk(300, { seed: tf.length, start: 130, vol: 1.5, tf }).map((c, i, a) => ({ ...c, isClosed: i < a.length - 1 })), 'replace');
    });
  }
  return { ...r, provider };
}

beforeEach(() => setOrderBlocks.mockClear());

describe('Order Blocks page', () => {
  it('is reachable from the sidebar and is its own page', async () => {
    window.location.hash = '#/';
    renderWithServices(<App />);
    const link = within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Order Blocks' });
    expect(link).toHaveAttribute('href', '#/engines/order-blocks');
    act(() => {
      window.location.hash = '#/engines/order-blocks';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await flush();
    expect(screen.getByRole('heading', { name: 'Order Blocks' })).toBeInTheDocument();
    expect(document.querySelector('.srgrid.obgrid')).not.toBeNull();
    for (const t of ['Blocks', 'Mitigations', 'Multi-Timeframe', 'Analysis', 'Settings']) expect(screen.getByRole('tab', { name: t })).toBeInTheDocument();
  });

  it('without data: MARKET DATA OFFLINE, no blocks, Replay disabled — nothing simulated', async () => {
    setup(false);
    await flush();
    expect(screen.getByTestId('ob-chart-state')).toHaveTextContent('MARKET DATA OFFLINE');
    expect(screen.getByRole('button', { name: /Replay/ })).toBeDisabled();
    expect(screen.queryAllByTestId(/ob-row-/)).toHaveLength(0);
  });

  it('with real-feed data: LIVE; table columns; selecting a row shows details, score components and highlights it on the chart', async () => {
    setup();
    await flush();
    expect(screen.getByTestId('ob-chart-state')).toHaveTextContent('ORDER BLOCKS LIVE');
    for (const h of ['Type', 'TF', 'Zone Low', 'Zone High', 'Score', 'Tests', 'Mitigation', 'State', 'Distance']) expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument();
    const rows = screen.getAllByTestId(/ob-row-/);
    expect(rows.length).toBeGreaterThan(0);
    fireEvent.click(rows[0]!);
    await flush();
    expect(within(screen.getByTestId('ob-details')).getByText('Structure break')).toBeInTheDocument();
    expect(screen.getByTestId('ob-score-displacement').textContent).not.toContain('—');
    const last = setOrderBlocks.mock.calls.at(-1)![0];
    expect(last.filter((d) => d.selected)).toHaveLength(1);
    expect(last.every((d) => /^(BULL|BEAR) OB (M1|M5|M15|M30|H1|H4|D1) · \d+$/.test(d.label))).toBe(true);
  });

  it('Recent Mitigation shows the latest return into a zone with a chart excerpt', async () => {
    setup();
    await flush();
    const panel = screen.getByTestId('ob-recent');
    expect(within(panel).getByTestId('ob-excerpt')).toBeInTheDocument();
    expect(panel).toHaveTextContent(/depth \d+% of the zone/);
  });

  it('filters: Bullish / Bearish, timeframe, state', async () => {
    setup();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /^Bearish/ }));
    await flush();
    expect(screen.queryAllByText('BULL', { selector: '.srtable .obtype' })).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /^All \(/ }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Timeframe' })).getByRole('button', { name: 'D1' }));
    await flush();
    expect(screen.queryAllByTestId(/ob-row-/)).toHaveLength(0);
  });

  it('never shows BUY / SELL / LONG / SHORT / ENTRY / TP / SL', async () => {
    setup();
    await flush();
    fireEvent.click(screen.getAllByTestId(/ob-row-/)[0]!);
    for (const tab of ['Blocks', 'Mitigations', 'Multi-Timeframe', 'Analysis', 'Settings']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      await flush();
      expect(document.body.textContent ?? '').not.toMatch(/\b(BUY|SELL|LONG|SHORT|ENTRY|TP|SL)\b/);
    }
  });

  it('stale feed → DATA STALE, never LIVE', async () => {
    const { provider } = setup();
    act(() => provider.sink.connection('XAUUSD', 'DISCONNECTED'));
    await flush();
    expect(screen.getByTestId('ob-chart-state')).toHaveTextContent('DATA STALE');
  });

  it('boundary mode switch recomputes from the same candles (fullRange zones ⊇ wickBody zones)', async () => {
    const { services } = setup();
    await flush();
    const before = services.orderBlocks.store('XAUUSD').getState().byTimeframe.H1!.blocks;
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Full range' }));
    await flush();
    const after = services.orderBlocks.store('XAUUSD').getState().byTimeframe.H1!.blocks;
    expect(services.orderBlocks.settings.boundaryMode).toBe('fullRange');
    const b0 = before.find((b) => b.type === 'bullish')!;
    const b1 = after.find((b) => b.originTime === b0.originTime)!;
    expect(b1.boundaryMode).toBe('fullRange');
    expect(b1.low).toBeLessThanOrEqual(b0.low);
    expect(b1.high).toBeGreaterThanOrEqual(b0.high);
    services.orderBlocks.configure({ boundaryMode: 'wickBody' });
  });

  it('replay: enter, step one candle with parity MATCH, exit back to live; other engines untouched', async () => {
    const { services } = setup();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Replay/ }));
    await flush();
    const count = () => Number(screen.getByTestId('ob-replay-count').textContent!.split('/')[0]!.replace(/,/g, ''));
    const before = count();
    fireEvent.click(screen.getByRole('button', { name: 'Step forward one candle' }));
    await flush();
    expect(count()).toBe(before + 1);
    expect(screen.getByTestId('ob-replay-parity')).toHaveTextContent('MATCH');
    expect(screen.getByTestId('ob-chart-state')).toHaveTextContent('ORDER BLOCKS REPLAY');
    fireEvent.click(screen.getByRole('button', { name: /Exit Replay/ }));
    await flush();
    expect(screen.queryByTestId('ob-replay-bar')).toBeNull();
    expect(screen.getByTestId('ob-chart-state')).toHaveTextContent('ORDER BLOCKS LIVE');
    expect(services.sr.store('XAUUSD').getState().byTimeframe.H1).toBeDefined();
    expect(services.liquidity.store('XAUUSD').getState().byTimeframe.H1).toBeDefined();
  });

  it('instrument change clears the previous instrument view immediately', async () => {
    const { services } = setup();
    await flush();
    fireEvent.click(screen.getAllByTestId(/ob-row-/)[0]!);
    await flush();
    act(() => services.instruments.select('XAGUSD'));
    await flush();
    expect(screen.queryAllByTestId(/ob-row-/)).toHaveLength(0);
    expect(within(screen.getByTestId('ob-details')).queryByText('Structure break')).toBeNull();
  });
});
