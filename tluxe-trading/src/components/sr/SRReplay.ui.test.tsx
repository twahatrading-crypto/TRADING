import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { randomWalk } from '../../engines/sr/fixtures/builders';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';
import type { Timeframe } from '../../types/market';

const setData = vi.fn();
const upsert = vi.fn();
vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({
  ChartController: class {
    setData(c: unknown[]) {
      setData(c);
    }
    upsert(c: unknown) {
      upsert(c);
    }
    setOverlays() {}
    setZones() {}
    onBarClick() {
      return () => {};
    }
    screenshot() {
      return document.createElement('canvas');
    }
    destroy() {}
  },
}));

const TF_SEC: Record<Timeframe, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };

/** TEST-ONLY candles, delivered through the provider interface like a real feed. */
function setup() {
  window.location.hash = '#/engines/support-resistance';
  const provider = new ManualPriceProvider('mt5');
  const r = renderWithServices(<App />, { price: [provider] }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'XAUUSD', 'tluxe.sr.chartTf.XAUUSD': '"H1"' }) });
  act(() => {
    provider.sink.connection('XAUUSD', 'LIVE');
    for (const tf of Object.keys(TF_SEC) as Timeframe[]) {
      const c = randomWalk(300, { seed: 7 + TF_SEC[tf], start: 2650, vol: 3, tf }).map((x, i, a) => ({ ...x, isClosed: i < a.length - 1 }));
      provider.sink.candles('XAUUSD', tf, c, 'replace');
    }
  });
  return { ...r, provider };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};

beforeEach(() => {
  setData.mockClear();
  upsert.mockClear();
});

describe('S&R Replay UI', () => {
  it('Replay button enters replay, steps exactly one candle, and Exit returns to live untouched', async () => {
    const { services, provider } = setup();
    await flush();
    const liveState = services.sr.store('XAUUSD').getState();
    const requests = provider.requestCandles.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /Replay/ }));
    await flush();
    const bar = screen.getByTestId('replay-bar');
    expect(within(bar).getByText('REPLAY')).toBeInTheDocument();
    expect(screen.getByTestId('sr-chart-state')).toHaveTextContent('REPLAY');
    expect(screen.getAllByText('S&R REPLAY').length).toBeGreaterThan(0);

    const count = () => Number(screen.getByTestId('replay-count').textContent!.split('/')[0]!.replace(/,/g, ''));
    const before = count();
    fireEvent.click(screen.getByRole('button', { name: 'Step forward one candle' }));
    await flush();
    expect(count()).toBe(before + 1);
    expect(upsert).toHaveBeenCalledTimes(1); // exactly one new closed candle drawn
    fireEvent.click(screen.getByRole('button', { name: 'Step back one candle' }));
    await flush();
    expect(count()).toBe(before);

    // Live data during replay: live store moves on, replay does not.
    act(() => provider.sink.candles('XAUUSD', 'H1', [{ time: 9_999_999_999, open: 1, high: 1, low: 1, close: 1, volume: null, isClosed: false }], 'upsert'));
    expect(count()).toBe(before);

    fireEvent.click(screen.getByRole('button', { name: /Exit Replay/ }));
    await flush();
    expect(screen.queryByTestId('replay-bar')).toBeNull();
    expect(screen.getByTestId('sr-chart-state')).not.toHaveTextContent('REPLAY');
    expect(provider.requestCandles.mock.calls.length).toBe(requests);
    expect(services.sr.store('XAUUSD').getState().multi).not.toBeNull();
    void liveState;
  });

  it('play/pause and speed controls drive the replay; timeframe switch keeps the replay time', async () => {
    vi.useFakeTimers();
    try {
      setup();
      await vi.advanceTimersByTimeAsync(10);
      fireEvent.click(screen.getByRole('button', { name: /Replay/ }));
      await vi.advanceTimersByTimeAsync(10);
      const count = () => Number(screen.getByTestId('replay-count').textContent!.split('/')[0]!.replace(/,/g, ''));
      const start = count();
      fireEvent.click(screen.getByRole('button', { name: '10x' }));
      fireEvent.click(screen.getByRole('button', { name: 'Play' }));
      await vi.advanceTimersByTimeAsync(500); // 5 candles at 10x
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
      expect(count()).toBe(start + 5);
      const time = screen.getByTestId('replay-time').textContent;
      fireEvent.click(screen.getByRole('button', { name: 'M15' }));
      await vi.advanceTimersByTimeAsync(10);
      expect(screen.getByTestId('replay-time').textContent).toBe(time);
    } finally {
      vi.useRealTimers();
    }
  });
});
