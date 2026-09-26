import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { FULL_FP_CAPS, generatedStream } from '../../engines/volumeFootprint/testing/stream';
import { ScriptedFootprintProvider } from '../../providers/footprint/testing/ScriptedFootprintProvider';
import { memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';

/* TEST DATA ONLY — scripted synthetic trades through the real provider boundary. */

const calls = { fp: 0, candles: 0, zoomIn: 0, zoomOut: 0, fit: 0, reset: 0 };
vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setFootprint(data: { candles: unknown[] } | null) {
      calls.fp++;
      calls.candles = data?.candles.length ?? 0;
    }
    autoScalePrice() {}
    onBarClick() {
      return () => {};
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
const SCRIPT = generatedStream({ minutes: 30, seed: 12 });

function setup(o: { provider?: boolean; instrument?: string; caps?: typeof FULL_FP_CAPS } = {}) {
  window.location.hash = '#/engines/volume-footprint';
  const footprint = o.provider ? new ScriptedFootprintProvider(SCRIPT, o.caps ?? FULL_FP_CAPS) : null;
  const r = renderWithServices(<App />, { footprint }, { storage: memoryStorage({ 'tluxe.instrument.v1': o.instrument ?? 'GC' }), allowTestProviders: true });
  act(() => r.services.volumeFootprint.flush());
  return r;
}

beforeEach(() => {
  Object.assign(calls, { fp: 0, candles: 0, zoomIn: 0, zoomOut: 0, fit: 0, reset: 0 });
  localStorage.clear();
});

describe('Volume Footprint page', () => {
  it('is in the sidebar right after Volume Profile', async () => {
    window.location.hash = '#/';
    renderWithServices(<App />);
    await flush();
    const link = screen.getByRole('link', { name: /Volume Footprint/ });
    expect(link.getAttribute('href')).toBe('#/engines/volume-footprint');
    const labels = screen.getAllByRole('link').map((a) => a.textContent ?? '');
    const i = labels.findIndex((t) => /Volume Footprint/.test(t));
    expect(labels[i - 1]).toMatch(/Volume Profile/);
    expect(labels[i + 1]).toMatch(/News Analysis/);
  });

  it('no provider: professional FOOTPRINT DATA UNAVAILABLE page naming the missing capability — nothing invented', async () => {
    setup();
    await flush();
    expect(screen.getByTestId('fp-unavailable').textContent).toMatch(/FOOTPRINT DATA UNAVAILABLE/);
    expect(screen.getByTestId('fp-unavailable').textContent).toMatch(/Rithmic \/ T4 \/ CQG/);
    expect(screen.getByTestId('fp-status').textContent).toBe('FOOTPRINT DATA UNAVAILABLE');
    expect(screen.getByTestId('fp-provider').textContent).toBe('Not connected');
    expect(screen.getByTestId('fp-current-delta').textContent).toBe('—');
    expect(screen.getByTestId('fp-cvd-card').textContent).toBe('—');
    expect(within(screen.getByTestId('fp-integrity-state')).getByText('UNAVAILABLE')).toBeTruthy();
    expect(screen.queryAllByTestId('fp-event-row')).toHaveLength(0);
    expect(screen.queryAllByTestId('fp-imb-row')).toHaveLength(0);
    expect(screen.getByTestId('fp-empty').textContent).toMatch(/never derived from MT5/);
    expect(calls.candles).toBe(0);
  });

  it('XAUUSD (MT5 spot): unavailable — MT5 data is never turned into a footprint', async () => {
    setup({ provider: true, instrument: 'XAUUSD' });
    await flush();
    expect(screen.getByTestId('fp-unavailable').textContent).toMatch(/not an exchange-traded future/);
    expect(calls.candles).toBe(0);
  });

  it('with an exchange trade feed: footprint, contract, delta, CVD, MTF, imbalances and events from the engine', async () => {
    setup({ provider: true });
    await flush();
    expect(screen.queryByTestId('fp-unavailable')).toBeNull();
    expect(screen.getByTestId('fp-status').textContent).toBe('Real Time');
    expect(screen.getByTestId('fp-contract').textContent).toBe('GCZ6');
    expect(screen.getByTestId('fp-current-delta').textContent).toMatch(/^[+-]?\d/);
    expect(screen.getByTestId('fp-cvd-card').textContent).toMatch(/^[+-]?\d/);
    expect(within(screen.getByTestId('fp-integrity-state')).getByText('GOOD')).toBeTruthy();
    expect(screen.getAllByTestId('fp-mtf-row')).toHaveLength(5);
    expect(screen.getAllByTestId('fp-event-row').length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('fp-candle')).getByText('Candle POC')).toBeTruthy();
    expect(calls.candles).toBeGreaterThan(0);
  });

  it('provider without aggressor side: FOOTPRINT DATA UNAVAILABLE names the missing capability', async () => {
    setup({ provider: true, caps: { ...FULL_FP_CAPS, aggressor: 'NONE' } });
    await flush();
    expect(screen.getByTestId('fp-unavailable').textContent).toMatch(/aggressor side/);
    expect(screen.getByTestId('fp-cvd-card').textContent).toBe('—');
  });

  it('display mode / toggles / navigation are view-only: recorded evidence and engine state unchanged', async () => {
    const { services } = setup({ provider: true });
    await flush();
    const fp = services.volumeFootprint;
    const state = JSON.stringify(fp.engine()!.fullState());
    const rec = fp.recording().length;
    fireEvent.change(screen.getByLabelText('Footprint mode'), { target: { value: 'DELTA' } });
    fireEvent.click(within(screen.getByTestId('fp-toggles')).getByRole('switch', { name: /^POC/ }));
    for (const name of ['Zoom in', 'Zoom out', 'Fit all bars and auto scale price', 'Reset chart view (Alt + R)']) fireEvent.click(screen.getByRole('button', { name }));
    await flush();
    expect(calls).toMatchObject({ zoomIn: 1, zoomOut: 1, fit: 1, reset: 1 });
    expect(JSON.stringify(fp.engine()!.fullState())).toBe(state);
    expect(fp.recording().length).toBe(rec);
  });

  it('never shows trade signals', async () => {
    setup({ provider: true });
    await flush();
    const text = document.querySelector('[data-testid=fp-page]')!.textContent!;
    expect(text).not.toMatch(/BUY SIGNAL|SELL SIGNAL|ENTRY READY|STOP LOSS|TAKE PROFIT|R:R/); // no signal labels (the disclaimer's lowercase wording is allowed)
    expect(text).toMatch(/never BUY \/ SELL signals/);
  });

  it('replay: parity MATCH, exit returns to live', async () => {
    setup({ provider: true });
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Replay/ }));
    await flush();
    expect(screen.getByTestId('fp-replay-parity').textContent).toBe('MATCH');
    fireEvent.click(screen.getByRole('button', { name: 'Step forward one candle' }));
    await flush();
    expect(screen.getByTestId('fp-replay-parity').textContent).toBe('MATCH');
    expect(screen.getByTestId('fp-chart-state').textContent).toMatch(/REPLAY/);
    fireEvent.click(screen.getByRole('button', { name: /Exit Replay/ }));
    await flush();
    expect(screen.queryByTestId('fp-replay-bar')).toBeNull();
  });
});
