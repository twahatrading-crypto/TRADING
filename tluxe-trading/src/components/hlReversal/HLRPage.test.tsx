import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { HLR_TIMEFRAMES } from '../../engines/hlReversal/config';
import type { HLRInput } from '../../engines/hlReversal/engine';
import * as F from '../../engines/hlReversal/fixtures/scenarios';
import { DEFAULT_HLR_SETTINGS } from '../../engines/hlReversal/config';
import { analyzeHighLowReversal } from '../../engines/hlReversal/engine';
import { hlrKnownInput } from '../../engines/hlReversal/knowledge';

/** Exactly the candles known when ENTRY READY happened (the market as it stood then). */
function atEntryReady(): HLRInput {
  const c = F.buyReversal();
  const s = analyzeHighLowReversal({ instrumentId: 'XAUUSD', tickSize: 0.01, candles: c }).setups.find((x) => x.entry)!;
  return hlrKnownInput({ instrumentId: 'XAUUSD', tickSize: 0.01, settings: { ...DEFAULT_HLR_SETTINGS }, candles: c }, s.entry!.knownAt);
}
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';
import type { HLRDrawable } from './hlrView';

const setHLR = vi.fn<(x: HLRDrawable[]) => void>();
vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setOverlays() {}
    setZones() {}
    setHighLowReversal(x: HLRDrawable[]) {
      setHLR(x);
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

function setup(data: HLRInput | null = atEntryReady(), instrument = 'XAUUSD') {
  window.location.hash = '#/engines/high-low-reversal';
  const provider = new ManualPriceProvider('mt5');
  const r = renderWithServices(<App />, { price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': instrument, [`tluxe.hlr.chartTf.${instrument}`]: '"M5"' }) });
  if (data) {
    act(() => {
      provider.sink.connection(instrument, 'LIVE');
      for (const tf of HLR_TIMEFRAMES) provider.sink.candles(instrument, tf, (data[tf] ?? []).map((c) => ({ ...c, isClosed: true })), 'replace');
    });
  }
  return { ...r, provider };
}

beforeEach(() => setHLR.mockClear());

describe('High / Low Reversal page', () => {
  it('is reachable from the sidebar as its own page with the five workflow cards and five panel tabs', async () => {
    window.location.hash = '#/';
    renderWithServices(<App />);
    const link = within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'High / Low Reversal' });
    expect(link).toHaveAttribute('href', '#/engines/high-low-reversal');
    act(() => {
      window.location.hash = '#/engines/high-low-reversal';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await flush();
    expect(screen.getByRole('heading', { name: 'High / Low Reversal Engine' })).toBeInTheDocument();
    for (const c of ['h4', 'h1', 'm15', 'm5', 'm1']) expect(screen.getByTestId(`hlr-card-${c}`)).toBeInTheDocument();
    for (const t of [/Setup List/, /Active Setup/, 'History', 'Alerts', 'Settings']) expect(screen.getByRole('tab', { name: t })).toBeInTheDocument();
  });

  it('without data: MARKET DATA OFFLINE, no setups, Replay disabled — nothing simulated', async () => {
    setup(null);
    await flush();
    expect(screen.getByTestId('hlr-chart-state')).toHaveTextContent('MARKET DATA OFFLINE');
    expect(screen.getByRole('button', { name: /Replay/ })).toBeDisabled();
    expect(screen.queryAllByTestId(/hlr-row-/)).toHaveLength(0);
    expect(screen.getByTestId('hlr-card-m1-zone')).toHaveTextContent('—');
  });

  it('a missing timeframe → DEPENDENCY DATA UNAVAILABLE (no approximation)', async () => {
    const d = { ...atEntryReady() };
    delete d.M1;
    setup(d);
    await flush();
    expect(screen.getByTestId('hlr-chart-state')).toHaveTextContent('DEPENDENCY DATA UNAVAILABLE');
    expect(screen.getByTestId('hlr-chart-state')).toHaveTextContent('M1');
    expect(screen.queryAllByTestId(/hlr-row-/)).toHaveLength(0);
  });

  it('with real-feed data: ENTRY READY setup is the active one; cards, details, score, sequence and overlays all come from it', async () => {
    setup();
    await flush();
    expect(screen.getByTestId('hlr-chart-state')).toHaveTextContent('LIVE');
    expect(within(screen.getByTestId('hlr-card-m1')).getByText('ENTRY READY')).toBeInTheDocument();
    expect(screen.getByTestId('hlr-card-m1-zone').textContent).not.toBe('—');
    expect(within(screen.getByTestId('hlr-details')).getByText('Low sweep reversal (BUY)')).toBeInTheDocument();
    expect(screen.getByTestId('hlr-score-m5Structure')).toHaveTextContent('100');
    expect(screen.getByTestId('hlr-sequence').querySelectorAll('.is-done')).toHaveLength(5);
    expect(screen.getByTestId('hlr-snapshot-chart')).toBeInTheDocument();
    const last = setHLR.mock.calls.at(-1)![0];
    expect(last.some((x) => x.kind === 'zone')).toBe(true);
    expect(screen.getByText(/not a probability or win rate/)).toBeInTheDocument();
  });

  it('selecting another setup in the list synchronises the details', async () => {
    setup(F.buyReversal());
    await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    await flush();
    const rows = screen.getAllByTestId(/hlr-row-/);
    const trig = rows.find((r) => r.textContent!.includes('TRIGGERED'))!;
    fireEvent.click(trig);
    await flush();
    expect(within(screen.getByTestId('hlr-details')).getAllByText('TRIGGERED').length).toBeGreaterThan(0);
  });

  it('never claims certainty: no "guarantee", "win rate" or "probability" as a claim', async () => {
    setup();
    await flush();
    for (const t of [/Setup List/, /Active Setup/, 'History', 'Alerts', 'Settings']) {
      fireEvent.click(screen.getByRole('tab', { name: t }));
      await flush();
      const txt = document.body.textContent ?? '';
      expect(txt).not.toMatch(/guaranteed|sure win|\d+% (win|chance)/i);
    }
  });

  it('stale feed → DATA STALE, never LIVE', async () => {
    const { provider } = setup();
    act(() => provider.sink.connection('XAUUSD', 'DISCONNECTED'));
    await flush();
    expect(screen.getByTestId('hlr-chart-state')).toHaveTextContent('DATA STALE');
  });

  it('replay: step one candle with parity MATCH, exit back to live; other engines untouched', async () => {
    const { services } = setup();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Replay/ }));
    await flush();
    const count = () => Number(screen.getByTestId('hlr-replay-count').textContent!.split('/')[0]!.replace(/,/g, ''));
    const before = count();
    fireEvent.click(screen.getByRole('button', { name: 'Step forward one candle' }));
    await flush();
    expect(count()).toBe(before + 1);
    expect(screen.getByTestId('hlr-replay-parity')).toHaveTextContent('MATCH');
    fireEvent.click(screen.getByRole('button', { name: /Exit Replay/ }));
    await flush();
    expect(screen.queryByTestId('hlr-replay-bar')).toBeNull();
    expect(services.orderBlocks.store('XAUUSD').getState().byTimeframe.M5).toBeDefined();
  });

  it('instrument change clears the previous instrument view immediately (never XAUUSD data for XAGUSD)', async () => {
    const { services } = setup();
    await flush();
    expect(screen.getByTestId('hlr-card-m1-zone').textContent).not.toBe('—');
    act(() => services.instruments.select('XAGUSD'));
    await flush();
    expect(screen.getByTestId('hlr-card-m1-zone')).toHaveTextContent('—');
    expect(services.hlReversal.store('XAGUSD').getState().snapshot?.setups ?? []).toEqual([]);
  });
});
