import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { DEFAULT_HLE_SETTINGS, HLE_TIMEFRAMES } from '../../engines/highLowEngine/config';
import { analyzeHighLow, type HLEInput } from '../../engines/highLowEngine/engine';
import * as F from '../../engines/highLowEngine/fixtures/scenarios';
import { hleKnownInput } from '../../engines/highLowEngine/knowledge';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';
import type { HLEDrawable } from './hleView';

const draw = vi.fn<(x: HLEDrawable[]) => void>();
vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setOverlays() {}
    setZones() {}
    setHighLowEngine(x: HLEDrawable[]) {
      draw(x);
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
function atEntry(): HLEInput {
  const c = F.buyReversal();
  const s = analyzeHighLow({ instrumentId: 'XAUUSD', tickSize: 0.01, candles: c }).setups.find((x) => x.entry)!;
  return hleKnownInput({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: { ...DEFAULT_HLE_SETTINGS }, candles: c }, s.entry!.knownAt);
}
function setup(data: HLEInput | null = atEntry()) {
  window.location.hash = '#/engines/high-low-engine';
  const provider = new ManualPriceProvider('mt5');
  const r = renderWithServices(<App />, { price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'XAUUSD', 'tluxe.hle.chartTf.XAUUSD': '"M15"' }) });
  if (data)
    act(() => {
      provider.sink.connection('XAUUSD', 'LIVE');
      for (const tf of HLE_TIMEFRAMES) provider.sink.candles('XAUUSD', tf, (data[tf] ?? []).map((c) => ({ ...c, isClosed: true })), 'replace');
    });
  return { ...r, provider };
}
beforeEach(() => draw.mockClear());

describe('High / Low Engine page', () => {
  it('its own sidebar entry and route; High / Low Reversal is untouched and still separate', async () => {
    window.location.hash = '#/';
    renderWithServices(<App />);
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getByRole('link', { name: 'High / Low Engine' })).toHaveAttribute('href', '#/engines/high-low-engine');
    expect(within(nav).getByRole('link', { name: 'High / Low Reversal' })).toHaveAttribute('href', '#/engines/high-low-reversal');
    act(() => {
      window.location.hash = '#/engines/high-low-engine';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await flush();
    expect(screen.getByRole('heading', { name: 'High / Low Engine' })).toBeInTheDocument();
    expect(screen.getByText('Find the best buy-low / sell-high setups using multi-timeframe structure and liquidity.')).toBeInTheDocument();
    for (const c of ['h4', 'h1', 'm15', 'm5', 'm1']) expect(screen.getByTestId(`hle-card-${c}`)).toBeInTheDocument();
    for (const c of ['denver', 'india', 'malaysia', 'myanmar']) expect(screen.getByTestId(`hle-clock-${c}`)).toBeInTheDocument();
  });
  it('without data: MARKET DATA OFFLINE, WAIT, honest engine status — nothing faked', async () => {
    setup(null);
    await flush();
    expect(screen.getByTestId('hle-chart-state')).toHaveTextContent('MARKET DATA OFFLINE');
    expect(screen.getByTestId('hle-signal')).toHaveTextContent('NO DATA');
    expect(screen.getByTestId('hle-status-runner')).toHaveTextContent('NOT CONFIGURED');
    expect(screen.getByTestId('hle-status-email')).toHaveTextContent('OFF');
    expect(screen.getByTestId('hle-status-analysis')).toHaveTextContent('Last analysis—');
    expect(screen.getByTestId('hle-card-m1-zone')).toHaveTextContent('—');
  });
  it('with data at the ENTRY READY close: BUY CONFIRMED, stage cards, sequence, score, log and overlays from the engine', async () => {
    setup();
    await flush();
    expect(screen.getByTestId('hle-chart-state')).toHaveTextContent('LIVE');
    expect(screen.getByTestId('hle-signal')).toHaveTextContent('BUY CONFIRMED');
    expect(screen.getByTestId('hle-card-m1-zone').textContent).not.toBe('—');
    expect(screen.getByTestId('hle-pipe-BUY').querySelectorAll('.is-done')).toHaveLength(5);
    expect(screen.getByTestId('hle-score-m5Structure')).toHaveTextContent('9/15'); // CHOCH 0.60, not displaced (documented shaping)
    expect(screen.getByTestId('hle-mandatory').querySelectorAll('.is-pass')).toHaveLength(6);
    expect(within(screen.getByTestId('hle-log')).getAllByText(/ENTRY READY/).length).toBeGreaterThan(0);
    expect(draw.mock.calls.at(-1)![0].some((x) => x.kind === 'zone')).toBe(true);
    expect(screen.getByText(/Score describes quality only/)).toBeInTheDocument();
    expect(screen.getByText(/A high is not a sell and a low is not a buy/)).toBeInTheDocument();
  });
  it('View All Levels lists every level with source, price, validity, rating, state, touches and distance', async () => {
    setup();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /View All Levels/ }));
    const dlg = screen.getByTestId('hle-levels-dialog');
    for (const h of ['Source', 'Price', 'Valid from', 'Rating', 'State', 'Touches', 'Distance']) expect(within(dlg).getByRole('columnheader', { name: h })).toBeInTheDocument();
    expect(within(dlg).getAllByRole('row').length).toBeGreaterThan(1);
  });
  it('a STALE feed withholds the complete setup: WAIT · DATA_STALE, no Entry / SL / TP drawn — never LIVE', async () => {
    const { provider } = setup();
    await flush();
    act(() => provider.sink.connection('XAUUSD', 'DELAYED'));
    await flush();
    expect(screen.getByTestId('hle-chart-state')).toHaveTextContent('DATA STALE');
    expect(screen.getByTestId('hle-signal')).toHaveTextContent('WAIT');
    expect(screen.getByTestId('hle-signal')).toHaveTextContent(/withheld/);
    expect(draw.mock.calls.at(-1)![0].some((x) => x.kind === 'zone' || x.kind === 'tp')).toBe(false);
  });
  it('TEST EMAIL never fakes a send', async () => {
    setup();
    await flush();
    fireEvent.click(screen.getByTestId('hle-test-email'));
    expect(screen.getByRole('status')).toHaveTextContent(/not configured/);
  });
  it('tools toggles remove overlays (draw only what is enabled)', async () => {
    setup();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Entry \/ SL \/ TP/ }));
    await flush();
    expect(draw.mock.calls.at(-1)![0].some((x) => x.kind === 'zone')).toBe(false);
  });
  it('replay: step one candle with parity MATCH; exit back to live', async () => {
    setup();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Replay/ }));
    await flush();
    const count = () => Number(screen.getByTestId('hle-replay-count').textContent!.split('/')[0]!.replace(/,/g, ''));
    const before = count();
    fireEvent.click(screen.getByRole('button', { name: 'Step forward one candle' }));
    await flush();
    expect(count()).toBe(before + 1);
    expect(screen.getByTestId('hle-replay-parity')).toHaveTextContent('MATCH');
    fireEvent.click(screen.getByRole('button', { name: /Exit Replay/ }));
    await flush();
    expect(screen.queryByTestId('hle-replay-bar')).toBeNull();
  });
  it('symbol switch clears the view immediately; the other engines keep running', async () => {
    const { services } = setup();
    await flush();
    act(() => services.instruments.select('XAGUSD'));
    await flush();
    expect(screen.getByTestId('hle-card-m1-zone')).toHaveTextContent('—');
    expect(screen.getByTestId('hle-signal')).toHaveTextContent('NO DATA');
    expect(services.hlReversal.store('XAUUSD').getState().snapshot).not.toBeNull();
  });
});
