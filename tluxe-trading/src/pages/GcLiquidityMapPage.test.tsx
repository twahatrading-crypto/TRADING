import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import { DEFAULT_MAP_SETTINGS } from '../components/gcMap/mapSettings';
import { memoryStorage } from '../test/providers';
import { renderWithServices } from '../test/renderWithServices';

vi.mock('lightweight-charts', () => ({}));
vi.mock('../components/chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    onBarClick() {
      return () => {};
    }
    destroy() {}
  },
}));

const ROUTE = '#/engines/gc-liquidity-map';
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => {});
};
const go = async (hash: string) => {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await flush();
};
let urls: string[] = [];
beforeEach(() => {
  urls = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  // Recorded-depth endpoint (TEST DATA ONLY): an empty matrix - the page must not invent anything.
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    urls.push(String(u));
    return { ok: true, status: 200, json: async () => ({ root: 'GC', contract: 'GCZ6', provider: 'Interactive Brokers', depthType: 'PRICE_LEVEL', mbo: false, firstRecordedMs: null, lastObservedMs: null, bucketMs: 250, from: 0, to: 0, columns: [] }) };
  }));
  for (const k of ['tluxe.gcmap.settings.v1', 'tluxe.gcmap.tf.v1']) localStorage.removeItem(k);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const open = async (instrument = 'GC') => {
  window.location.hash = ROUTE;
  const r = renderWithServices(<App />, {}, { storage: memoryStorage({ 'tluxe.instrument.v1': instrument }) });
  await flush();
  return r;
};

describe('GC Liquidity Map - a separate, read-only page', () => {
  it('own route + sidebar item; the existing liquidity pages stay separate', async () => {
    await open();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getByRole('link', { name: 'GC Liquidity Map' }).getAttribute('href')).toBe(ROUTE);
    expect(within(nav).getByRole('link', { name: 'GC Liquidity Map' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'GC Liquidity Map' })).toBeTruthy();
    await go('#/engines/liquidity-heatmap');
    expect(screen.getByRole('heading', { level: 1, name: 'Liquidity Heatmap' })).toBeTruthy();
    expect(screen.queryByTestId('gcmap')).toBeNull();
  });

  it('without live IBKR depth: NO DEPTH DATA, no current level, nothing drawn without data', async () => {
    await open();
    expect(screen.getByTestId('gcmap-nodata').textContent).toMatch(/NO DEPTH DATA/);
    expect(screen.getByTestId('gcmap-now').textContent).toMatch(/NO DEPTH DATA — no current levels/);
    expect(document.querySelector('canvas.gcmap__canvas')).toBeNull();
    expect(screen.getByTestId('gcmap-empty')).toBeTruthy();
  });

  it('reads recorded depth over the existing endpoint only, and the candle timeframe never changes that request', async () => {
    await open();
    const heat = () => urls.filter((u) => u.startsWith('/api/ibkr/heatmap?root=GC')).map((u) => new URL(u, 'http://x').searchParams.get('bucket'));
    expect(heat().length).toBeGreaterThan(0);
    const before = heat();
    const tfs = screen.getByRole('tablist', { name: 'Candle timeframe' });
    fireEvent.click(within(tfs).getByRole('tab', { name: '1H' }));
    fireEvent.click(within(tfs).getByRole('tab', { name: '1m' }));
    await flush();
    expect(heat().slice(0, before.length)).toEqual(before);
    expect(new Set(heat()).size).toBe(1); // one bucket size - chosen from the viewport, not the candle timeframe
    expect(urls.every((u) => u.startsWith('/api/ibkr/heatmap?') || u.startsWith('/api/'))).toBe(true);
  });

  it('history window: LIVE SESSION by default, then 1H .. 24H; the session start is read from recorded coverage of the last 24 h', async () => {
    await open();
    const w = screen.getByRole('tablist', { name: 'History window' });
    expect(within(w).getAllByRole('tab').map((t) => t.textContent)).toEqual(['LIVE SESSION', '1H', '3H', '6H', '12H', '24H']);
    expect(within(w).getByRole('tab', { name: 'LIVE SESSION' })).toHaveAttribute('aria-selected', 'true');
    const probe = urls.map((u) => new URL(u, 'http://x').searchParams).find((q) => q.get('bucket') === '300000');
    expect(Number(probe!.get('to')) - Number(probe!.get('from'))).toBeGreaterThanOrEqual(86_400_000 - 1000);
    await act(() => new Promise((r) => setTimeout(r, 1100))); // the page reads the store on its 1 s tick
    await flush();
    // nothing recorded (empty matrix): said so - no session is invented
    expect(screen.getByTestId('gcmap-window').textContent).toMatch(/no recorded depth session found in the last 24 h/);
    fireEvent.click(within(w).getByRole('tab', { name: '6H' }));
    await flush();
    expect(within(w).getByRole('tab', { name: '6H' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('gcmap-window').textContent).toMatch(/DEPTH GAP, never filled/);
  });

  it('labels describe depth only: no signals, no S&R, no prediction; the IBKR limitation is stated', async () => {
    await open();
    const page = screen.getByTestId('gcmap');
    expect(page.textContent).not.toMatch(/\bBUY\b|\bSELL\b|LONG|SHORT/);
    expect(page.textContent).not.toMatch(/bullish|bearish|probabilit|win rate|Volume Profile|\bCVD\b|\bDelta\b|\bRSI\b|\bMACD\b/i);
    expect(page.textContent).toMatch(/not buy \/ sell, not support \/ resistance/);
    expect(page.textContent).toMatch(/not the full COMEX book, not MBO/);
  });

  it('minimal controls with their own storage; Reset restores the defaults', async () => {
    await open();
    const c = screen.getByTestId('gcmap-settings');
    for (const l of ['Intensity', 'Minimum Size', 'Relative Strength', 'Minimum Persistence', 'Maximum Distance']) expect(within(c).getByLabelText(l)).toBeTruthy();
    for (const l of ['Candles', 'Liquidity Heat', 'Current Depth', 'Strong Only', 'Labels']) expect(screen.getByLabelText(l)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Strong Only'));
    fireEvent.change(within(c).getByLabelText('Minimum Size'), { target: { value: '80' } });
    await flush();
    expect(JSON.parse(localStorage.getItem('tluxe.gcmap.settings.v1')!)).toMatchObject({ strongOnly: true, minSize: 80 });
    fireEvent.click(screen.getByTestId('gcmap-reset'));
    await flush();
    expect(JSON.parse(localStorage.getItem('tluxe.gcmap.settings.v1')!)).toEqual(DEFAULT_MAP_SETTINGS);
  });

  it('a non-GC instrument: GC only (never relabels spot / CFD data)', async () => {
    await open('XAUUSD');
    expect(screen.getByTestId('gcmap-not-gc').textContent).toMatch(/GC — COMEX Gold Futures only/);
  });

  it('isolation: no collector / provider / connection / recorder / polling of its own; no synthetic source; no other page imported', () => {
    const src = import.meta.glob(['/src/pages/GcLiquidityMapPage.tsx', '/src/components/gcMap/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    expect(Object.keys(src).length).toBe(5);
    for (const [f, s] of Object.entries(src)) {
      expect(s, f).not.toMatch(/new (DatabentoFeed|IbkrDepthProvider|DatabentoBridgeClient|WebSocket|EventSource|MarketDataService|OrderFlowService)\b/);
      expect(s, f).not.toMatch(/connectServices|createServices|DepthRecorder|setEngineSettings|\bfetch\(/);
      expect(s, f).not.toMatch(/\/testing\/|fixtures/);
      expect(s, f).not.toMatch(/pages\/(LiquidityHeatmapPage|GcLiquidityProPage)|components\/(sr|liquidity|orderBlocks|smc|volumeProfile|volumeFootprint|hlReversal|highLowEngine)\/(?!sr\.css)/);
      expect(s, f).not.toMatch(/XAUUSD|XAGUSD/);
    }
  });
});
