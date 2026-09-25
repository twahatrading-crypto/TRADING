import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import { FULL_CAPS, TEST_TICK, demoSession } from '../engines/orderFlow/testing/scenarios';
import { ScriptedOrderFlowProvider } from '../providers/orderFlow/testing/ScriptedOrderFlowProvider';
import { memoryStorage } from '../test/providers';
import { renderWithServices } from '../test/renderWithServices';

/* TEST DATA ONLY — the scripted provider is allowed here via allowTestProviders; production refuses it. */

vi.mock('lightweight-charts', () => ({}));
vi.mock('../components/chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setOverlays() {}
    setZones() {}
    setLiquidity() {}
    setEventMarkers() {}
    setHighLowEngine() {}
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
beforeEach(() => {
  // jsdom has no canvas; the renderer handles a null context (nothing drawn, state still tested).
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function setupLive() {
  window.location.hash = '#/engines/liquidity-heatmap';
  const p = new ScriptedOrderFlowProvider(demoSession(), FULL_CAPS, { tickSize: TEST_TICK, contract: 'TEST-GC' });
  const r = renderWithServices(<App />, { orderFlow: { depth: p, trade: p } }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'GC' }), allowTestProviders: true });
  return { ...r, p };
}

describe('Liquidity Heatmap page', () => {
  it('is in the sidebar under Trading Strategy and opens its own page', async () => {
    window.location.hash = '#/';
    renderWithServices(<App />, {}, { storage: memoryStorage({ 'tluxe.instrument.v1': 'GC' }) });
    await flush();
    const link = screen.getByRole('link', { name: /Liquidity Heatmap/ });
    expect(link.getAttribute('href')).toBe('#/engines/liquidity-heatmap');
    act(() => {
      window.location.hash = '#/engines/liquidity-heatmap';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await flush();
    expect(window.location.hash).toBe('#/engines/liquidity-heatmap');
    expect(screen.getByRole('heading', { name: 'Liquidity Heatmap' })).toBeTruthy();
  });

  it('without a Level-2 provider: LEVEL-2 DATA UNAVAILABLE, never LIVE, no heatmap, no book, no CVD', async () => {
    window.location.hash = '#/engines/liquidity-heatmap';
    renderWithServices(<App />, {}, { storage: memoryStorage({ 'tluxe.instrument.v1': 'GC' }) });
    await flush();
    expect(screen.getAllByText('LEVEL-2 DATA UNAVAILABLE').length).toBeGreaterThan(0);
    const feeds = screen.getByTestId('of-feeds').textContent!;
    expect(feeds).toContain('DEPTH: DATA UNAVAILABLE');
    expect(feeds).toContain('TRADES: DATA UNAVAILABLE');
    expect(document.body.textContent).not.toMatch(/DEPTH: LIVE|TRADES: LIVE/);
    expect(document.querySelector('canvas.ofheat__canvas')).toBeNull();
    expect(within(screen.getByTestId('of-cvd')).getByTestId('of-cvd-state').textContent).toMatch(/UNAVAILABLE/);
    expect(screen.queryAllByTestId('of-event-row')).toHaveLength(0);
    expect(screen.getByTestId('of-integrity').textContent).toContain('provider: none');
    // No trading signals on this page.
    expect(document.body.textContent).not.toMatch(/BUY CONFIRMED|SELL CONFIRMED|Stop loss|Take profit/i);
  });

  it('a spot / CFD instrument shows GC DEPTH DATA UNAVAILABLE and offers GC', async () => {
    window.location.hash = '#/engines/liquidity-heatmap';
    const { services } = renderWithServices(<App />, {}, { storage: memoryStorage({ 'tluxe.instrument.v1': 'XAUUSD' }) });
    await flush();
    expect(screen.getByText('GC DEPTH DATA UNAVAILABLE')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Switch to GC/ }));
    await flush();
    expect(services.instruments.store.getState().activeId).toBe('GC');
  });

  it('with a (TEST) Level-2 + trade stream: LIVE statuses, book, events, canvas, CVD', async () => {
    const { p, services } = setupLive();
    await flush();
    act(() => {
      p.emitAll();
      services.orderFlow.publish();
    });
    await flush();
    const feeds = screen.getByTestId('of-feeds').textContent!;
    expect(feeds).toContain('DEPTH: LIVE');
    expect(feeds).toContain('TRADES: LIVE');
    expect(screen.getByTestId('of-contract').textContent).toBe('TEST-GC');
    expect(document.querySelector('canvas.ofheat__canvas')).not.toBeNull();
    expect(screen.getByTestId('of-book-totals').textContent).toMatch(/Best bid/);
    expect(screen.getAllByTestId('of-event-row').length).toBeGreaterThan(0);
    expect(screen.getByTestId('of-cvd-state').textContent).toMatch(/PARTIAL/); // the TEST session has UNKNOWN prints
  });

  it('page switching and re-rendering never add a provider subscription', async () => {
    const { p } = setupLive();
    await flush();
    expect(p.subscriptions).toBe(1);
    for (const h of ['#/engines/liquidity', '#/engines/liquidity-heatmap', '#/', '#/engines/liquidity-heatmap']) {
      act(() => {
        window.location.hash = h;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      await flush();
    }
    expect(p.subscriptions).toBe(1);
    expect(p.connects).toBe(1);
  });

  it('zoom / fit / reset and clicking an event only change the view — never the engine output', async () => {
    const { p, services } = setupLive();
    await flush();
    act(() => {
      p.emitAll();
      services.orderFlow.publish();
    });
    await flush();
    const before = services.orderFlow.engine()!.digest();
    const recBefore = services.orderFlow.recording().length;
    for (const name of ['Zoom in', 'Zoom out', 'Fit all bars and auto scale price', 'Reset chart view (Alt + R)']) {
      const b = screen.getByRole('button', { name });
      if (!(b as HTMLButtonElement).disabled) fireEvent.click(b);
    }
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR', altKey: true });
    fireEvent.click(screen.getAllByTestId('of-event-row')[0]!);
    await flush();
    expect(services.orderFlow.engine()!.digest()).toBe(before);
    expect(services.orderFlow.recording().length).toBe(recBefore);
    expect(p.snapshotRequests).toBe(0);
  });
});
