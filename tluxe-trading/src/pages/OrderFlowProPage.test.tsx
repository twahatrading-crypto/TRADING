import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { offlineStatus } from '../engines/orderFlowPro/engine';
import type { GatewayProvenance, OfpFrame, OfpRoot, SourceStatus, StreamLiveness } from '../engines/orderFlowPro/types';
import { installOfpController, OfpController } from '../providers/orderFlowPro/controller';
import type { OfpSource, SourceSink } from '../providers/orderFlowPro/source';
import { DemoSource } from '../providers/orderFlowPro/testing/DemoSource';
import { BackendSource } from '../providers/orderFlowPro/BackendSource';
import { OrderFlowProPage } from './OrderFlowProPage';
import { OfpChartView } from '../components/orderFlowPro/OfpChartView';

// The controller coalesces notifications to one per animation frame: wait past a frame, then settle React.
const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
  for (let i = 0; i < 3; i++) await act(async () => {});
};

/** A scripted non-demo source: lets a test push a backend status and frames. */
function scripted() {
  const sinks = new Map<OfpRoot, SourceSink>();
  const src: OfpSource = {
    info: { id: 'scripted', name: 'scripted', demo: false },
    subscribe: (root, sink) => {
      sinks.set(root, sink);
      return () => sinks.delete(root);
    },
    history: async () => [],
  };
  return { src, push: (root: OfpRoot, st: SourceStatus, frames: OfpFrame[] = [], t = 0) => act(() => (sinks.get(root)?.status(st), sinks.get(root)?.frames(frames), sinks.get(root)?.time(t))) };
}

const contract = { root: 'GC' as const, localSymbol: 'GCZ6', conId: 462941472, expiry: '20261229', exchange: 'COMEX' as const, tradingClass: 'GC', multiplier: '100', verified: true };

// jsdom has no canvas: drawing is skipped (the canvas renderers guard a null context).
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  installOfpController(new OfpController(new BackendSource()));
  vi.restoreAllMocks();
});

describe('Order Flow Pro page', () => {
  it('production default: backend link OFF -> BACKEND OFFLINE, no requests, no candles, nothing simulated', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    installOfpController(new OfpController(new BackendSource()));
    render(<OrderFlowProPage />);
    await flush();
    expect(screen.getByRole('heading', { level: 1, name: /Order Flow Pro/i })).toBeInTheDocument();
    expect(screen.getByTestId('ofp-feed')).toHaveTextContent('BACKEND OFFLINE');
    expect(screen.getByTestId('ofp-nodata')).toHaveTextContent(/Nothing is simulated/);
    expect(screen.queryByText(/DEMO FIXTURE/)).toBeNull();
    expect(f).not.toHaveBeenCalled();
    f.mockRestore();
  });

  it('DEMO fixture is bannered and never labelled LIVE', async () => {
    installOfpController(new OfpController(new DemoSource({ t0: Date.UTC(2026, 9, 9, 13), historySeconds: 1800 }), true));
    render(<OrderFlowProPage />);
    await flush();
    expect(screen.getByText(/DEMO FIXTURE — synthetic events/)).toBeInTheDocument();
    const pill = screen.getByTestId('ofp-feed');
    expect(pill).toHaveTextContent('DEMO · NOT LIVE');
    expect(pill.textContent).not.toMatch(/^\s*LIVE\s*$/);
    expect(screen.queryByTestId('ofp-nodata')).toBeNull();
    expect(screen.getAllByText(/DEMO-GCZ6/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Side \(inferred\)/)).toBeInTheDocument();
  });

  it('shows the contract expiry explicitly and switches GC <-> SI', async () => {
    installOfpController(new OfpController(new DemoSource({ t0: Date.UTC(2026, 9, 9, 13), historySeconds: 600 }), true));
    render(<OrderFlowProPage />);
    await flush();
    expect(screen.getByRole('combobox', { name: 'Contract expiry' })).toHaveDisplayValue('DEMO-GCZ6 · exp 2026-12-29');
    fireEvent.click(screen.getByRole('button', { name: /SI/ }));
    await flush();
    expect(screen.getByRole('combobox', { name: 'Contract expiry' })).toHaveDisplayValue('DEMO-SIZ6 · exp 2026-12-29');
    fireEvent.click(screen.getByRole('button', { name: /GC/ }));
    await flush();
    expect(screen.getByRole('combobox', { name: 'Contract expiry' })).toHaveDisplayValue('DEMO-GCZ6 · exp 2026-12-29');
  });

  it('every chart layer has an independent toggle', async () => {
    installOfpController(new OfpController(new DemoSource({ t0: Date.UTC(2026, 9, 9, 13), historySeconds: 300 }), true));
    render(<OrderFlowProPage />);
    await flush();
    const group = screen.getByRole('group', { name: 'Chart layers' });
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes.map((b) => b.parentElement!.textContent!.trim())).toEqual(['Heatmap', 'Footprint', 'Bubbles', 'Volume Profile', 'POC/VAH/VAL', 'Order Book', 'Strong Liquidity', 'Reversals']);
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Heatmap' }));
    expect(within(group).getByRole('checkbox', { name: 'Heatmap' })).not.toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'Footprint' })).toBeChecked();
    expect(JSON.parse(localStorage.getItem('tluxe.ofp.layers.v1')!)).toMatchObject({ heatmap: false, footprint: true });
  });

  it('workspace: full-screen by default, exits to the standard layout, schedule label never says market open', async () => {
    installOfpController(new OfpController(new DemoSource({ t0: Date.UTC(2026, 9, 9, 13), historySeconds: 300 }), true));
    render(<OrderFlowProPage />);
    await flush();
    expect(screen.getByTestId('ofp-page')).toHaveClass('ofp--ws');
    expect(screen.getByTestId('ofp-schedule').textContent).toMatch(/schedule only, not exchange status/);
    expect(screen.getByTestId('ofp-schedule').textContent).not.toMatch(/market open/i);
    expect(screen.getByText(/NEVER LIVE/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Exit full screen/ }));
    expect(screen.getByTestId('ofp-page')).not.toHaveClass('ofp--ws');
    expect(JSON.parse(localStorage.getItem('tluxe.ofp.workspace.v1')!)).toBe(false);
  });

  it('panes resize with the keyboard and persist; liquidity strength shows coverage and unavailable metrics', async () => {
    installOfpController(new OfpController(new DemoSource({ t0: Date.UTC(2026, 9, 9, 13), historySeconds: 900 }), true));
    render(<OrderFlowProPage />);
    await flush();
    const sep = screen.getByRole('separator', { name: 'Resize order book column' });
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(JSON.parse(localStorage.getItem('tluxe.ofp.panes.v1')!).side).toBe(470 + 16);
    const strength = screen.getByTestId('ofp-strength');
    expect(strength.textContent).toMatch(/Book coverage \(30 min\)/i);
    expect(strength.textContent).toMatch(/Unavailable/);
    expect(strength.textContent).toMatch(/queue position/);
    fireEvent.click(screen.getByRole('button', { name: 'Display settings' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Bubble opacity' }), { target: { value: '0.4' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Bubble density' }), { target: { value: 'low' } });
    expect(JSON.parse(localStorage.getItem('tluxe.ofp.bubbleOpacity.v1')!)).toBe(0.4);
    expect(JSON.parse(localStorage.getItem('tluxe.ofp.bubbleDensity.v1')!)).toBe('low');
  });

  it('feed states from the backend are shown as reported: LIVE only for real-time; DELAYED / STALE / NOT ENTITLED / login required', async () => {
    const s = scripted();
    installOfpController(new OfpController(s.src));
    render(<OrderFlowProPage />);
    await flush();
    const base = { ...offlineStatus('GC', 'LIVE', []), contract, capabilities: { depth: 'AVAILABLE', trades: 'AVAILABLE', aggressor: 'AVAILABLE', historicalBars: 'AVAILABLE' } } as SourceStatus;
    s.push('GC', { ...base, marketDataType: 'REALTIME' });
    await flush();
    expect(screen.getByTestId('ofp-feed')).toHaveTextContent(/^\s*LIVE\s*$/);
    expect(screen.getByRole('combobox', { name: 'Contract expiry' })).toHaveDisplayValue('GCZ6 · exp 2026-12-29');
    for (const [feed, mdt, text] of [
      ['DELAYED', 'DELAYED', 'DELAYED'],
      ['FROZEN', 'FROZEN', 'FROZEN'],
      ['STALE', 'REALTIME', 'STALE'],
      ['NOT_ENTITLED', null, 'NOT ENTITLED'],
      ['AUTH_REQUIRED', null, 'GATEWAY LOGIN REQUIRED'],
      ['DISABLED', null, 'IBKR CONNECTION DISABLED'],
      ['COMPETING_SESSION', null, 'COMPETING IBKR SESSION'],
      ['MODE_MISMATCH', null, 'PAPER / LIVE MISMATCH'],
      ['LIVE', 'DELAYED', 'DELAYED'],
    ] as const) {
      s.push('GC', { ...base, feed, marketDataType: mdt });
      await flush();
      expect(screen.getByTestId('ofp-feed')).toHaveTextContent(text);
      expect(screen.getByTestId('ofp-feed').textContent!.trim()).not.toBe('LIVE'); // none of these is LIVE + REALTIME
    }
  });

  it('Phase 2D: diagnostics show independent health signals; trades show inference basis and quote age', async () => {
    const s = scripted();
    installOfpController(new OfpController(s.src));
    localStorage.setItem('tluxe.ofp.tab.v1', JSON.stringify('Diagnostics'));
    render(<OrderFlowProPage />);
    await flush();
    const health = {
      connection: 'OK',
      accountVerified: true,
      heartbeatAgeMs: 3000,
      ibkrLink: 'OK',
      quotes: { lastMs: 1, ageMs: 900, state: 'FRESH' },
      depth: { lastMs: 1, ageMs: 45_000, state: 'AGED' },
      trades: { lastMs: 1, ageMs: 2000, state: 'FRESH', activity: 'ACTIVE' },
      gaps: { count: 1, last: { from: 1, to: 2, reason: 'IBKR 1100: Connectivity lost' }, recorderDropped: 0 },
      streams: { mkt: 'ACTIVE', depth: 'ACTIVE', trades: 'ACTIVE', hist: 'ACTIVE' },
      activity: 'ACTIVE',
      quietForMs: 2000,
      schedule: 'IN_SCHEDULE',
      depthPacing: { backoffS: 5, pending: null, suspended: null, retriesInWindow: 0 },
    } as const;
    const classification = { method: 'QUOTE_RULE', inferred: true, touchSource: 'depth', maxQuoteAgeMs: 2000, prevTouchWindowMs: 250, reasons: { AT_ASK: 1, QUOTE_STALE: 1 }, volume: { BUY: 3, SELL: 0, UNKNOWN: 1 }, unknownVolumeByReason: { QUOTE_STALE: 1 }, unknownVolumePct: 25 } as const;
    const st = { ...offlineStatus('GC', 'LIVE', []), marketDataType: 'REALTIME', contract, health, classification } as SourceStatus;
    const t = Date.UTC(2026, 9, 9, 14, 0, 5);
    s.push('GC', st, [{ root: 'GC', seq: 1, events: [{ kind: 'trade', t, price: 4195.4, size: 1, aggressor: 'UNKNOWN', method: 'QUOTE_RULE', inferred: true, basis: 'QUOTE_STALE', quoteAgeMs: 5200, quoteSource: 'depth', bid: 4195.3, ask: 4195.4 }] }], t);
    await flush();
    const panel = screen.getByRole('tabpanel');
    for (const text of [/Quote freshness/, /FRESH · last message 0\.9 s ago/, /Depth freshness/, /AGED · last message 45\.0 s ago/, /Trade activity/, /Recording gaps/, /IBKR 1100/, /INFERRED/, /max quote age 2000 ms/, /QUOTE_STALE 1/]) expect(panel.textContent).toMatch(text);
    fireEvent.click(screen.getByRole('tab', { name: 'Trades (Footprint)' }));
    expect(screen.getByRole('tabpanel').textContent).toMatch(/quote stale · 5\.2 s/);
  });

  it('candles and footprint come only from prints the source delivered', async () => {
    const s = scripted();
    installOfpController(new OfpController(s.src));
    render(<OrderFlowProPage />);
    await flush();
    const st = { ...offlineStatus('GC', 'LIVE', []), marketDataType: 'REALTIME', contract, capabilities: { depth: 'AVAILABLE', trades: 'AVAILABLE', aggressor: 'AVAILABLE', historicalBars: 'AVAILABLE' } } as SourceStatus;
    s.push('GC', st);
    await flush();
    expect(screen.getByTestId('ofp-nodata')).toBeInTheDocument();
    const t = Date.UTC(2026, 9, 9, 14, 0, 5);
    s.push('GC', st, [{ root: 'GC', seq: 1, events: [{ kind: 'trade', t, price: 4195.4, size: 3, aggressor: 'BUY', method: 'QUOTE_RULE', bid: 4195.3, ask: 4195.4 }] }], t);
    await flush();
    expect(screen.queryByTestId('ofp-nodata')).toBeNull();
    expect(screen.getAllByText('4195.4').length).toBeGreaterThan(0);
  });
});

describe('Order Flow Pro chart controls + liquidity overlay (presentation only)', () => {
  beforeEach(() => localStorage.clear());
  const demo = () => installOfpController(new OfpController(new DemoSource({ t0: Date.UTC(2026, 9, 9, 13), historySeconds: 900 }), true));

  it('Expand chart: chart-only overlay; Escape restores the layout; the chart (and its zoom / pan) is never recreated', async () => {
    demo();
    const destroy = vi.spyOn(OfpChartView.prototype, 'destroy');
    render(<OrderFlowProPage />);
    await flush();
    const page = screen.getByTestId('ofp-page');
    const before = page.className;
    const saved = { ...localStorage };
    fireEvent.click(screen.getByTestId('ofp-expand'));
    await flush();
    expect(page.className).toMatch(/ofp--chartmax/);
    expect(screen.getByTestId('ofp-expand')).toHaveTextContent(/Exit full-screen chart/);
    // essential tools stay available while expanded
    for (const name of ['Zoom in', 'Zoom out', 'Fit', 'Price zoom in', 'Price zoom out', 'Auto price scale']) expect(screen.getAllByRole('button', { name }).length).toBeGreaterThan(0); // toolbar (+ shared overlay for +/-)
    fireEvent.keyDown(window, { key: 'Escape' });
    await flush();
    expect(page.className).toBe(before);
    expect(screen.getByTestId('ofp-expand')).toHaveTextContent('Expand chart');
    expect({ ...localStorage }).toEqual(saved); // layout / workspace / panes untouched
    expect(destroy).not.toHaveBeenCalled();
    // the existing Workspace full-screen button is still there and separate
    expect(screen.getByRole('button', { name: /Exit full screen$/ })).toBeInTheDocument();
  });

  it('Clean view hides overlays without changing the saved layer choices, and restores them', async () => {
    demo();
    render(<OrderFlowProPage />);
    await flush();
    const layerGroup = () => within(screen.getByRole('group', { name: 'Chart layers' }));
    fireEvent.click(layerGroup().getByRole('checkbox', { name: 'Heatmap' }));
    const layers = localStorage.getItem('tluxe.ofp.layers.v1');
    fireEvent.click(screen.getByTestId('ofp-clean'));
    await flush();
    expect(screen.getByTestId('ofp-clean')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('checkbox', { name: 'Footprint' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Strong' })).toBeDisabled();
    expect(localStorage.getItem('tluxe.ofp.layers.v1')).toBe(layers);
    fireEvent.click(screen.getByTestId('ofp-clean'));
    await flush();
    expect(screen.getByRole('checkbox', { name: 'Footprint' })).toBeEnabled();
    expect(layerGroup().getByRole('checkbox', { name: 'Heatmap' })).not.toBeChecked();
  });

  it('BID / ASK / STRONG / MEDIUM / quantity / label toggles are independent and persisted', async () => {
    demo();
    render(<OrderFlowProPage />);
    await flush();
    const liqGroup = within(screen.getByRole('group', { name: 'Liquidity overlay' }));
    fireEvent.click(liqGroup.getByRole('checkbox', { name: 'Ask' }));
    fireEvent.click(liqGroup.getByRole('checkbox', { name: 'Medium' }));
    fireEvent.click(liqGroup.getByRole('checkbox', { name: 'Contracts' }));
    expect(JSON.parse(localStorage.getItem('tluxe.ofp.liq.v1')!)).toEqual({ strong: true, medium: true, bid: true, ask: false, qty: false, lane: true });
  });

  it('legend: four categories, contracts (never orders), and no class without enough depth history', async () => {
    const s = scripted();
    installOfpController(new OfpController(s.src));
    render(<OrderFlowProPage />);
    await flush();
    const st = { ...offlineStatus('GC', 'LIVE', []), marketDataType: 'REALTIME', contract } as SourceStatus;
    const t = Date.UTC(2026, 9, 9, 14, 0, 5);
    s.push('GC', st, [{ root: 'GC', seq: 1, events: [{ kind: 'book', t, bids: [[4195.3, 4], [4195.2, 2], [4195.1, 1]], asks: [[4195.4, 3], [4195.5, 1]] }, { kind: 'trade', t, price: 4195.4, size: 3, aggressor: 'BUY', method: 'QUOTE_RULE', bid: 4195.3, ask: 4195.4 }] }], t + 60_000);
    await flush();
    const legend = screen.getByTestId('ofp-liq-legend');
    for (const k of ['STRONG BID', 'MEDIUM BID', 'STRONG ASK', 'MEDIUM ASK']) expect(legend).toHaveTextContent(k);
    expect(screen.getByTestId('ofp-liq-status')).toHaveTextContent(/Collecting depth history 1m 00s \/ 10m 00s/);
    const info = legend.querySelector('.ofp-liqinfo')!.getAttribute('title')!;
    expect(info).toMatch(/displayed aggregate contracts per price level - not a count of individual orders/);
    expect(info).toMatch(/BID = resting buy-side liquidity · ASK = resting sell-side liquidity/);
    expect(info).toMatch(/does not mean a trade will happen/);
  });

  it('no recorded-depth request outside the website gateway source (no extra polling)', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    demo();
    render(<OrderFlowProPage />);
    await flush();
    await flush();
    expect(f.mock.calls.filter((c) => String(c[0]).includes('/api/ibkr/heatmap'))).toEqual([]);
  });

  it('chart height handle in the standard layout, persisted; hidden in Workspace mode', async () => {
    demo();
    render(<OrderFlowProPage />);
    await flush();
    expect(screen.queryByRole('separator', { name: 'Resize chart height' })).toBeNull(); // workspace (default)
    fireEvent.click(screen.getByRole('button', { name: /Exit full screen$/ }));
    await flush();
    const h = screen.getByRole('separator', { name: 'Resize chart height' });
    fireEvent.keyDown(h, { key: 'ArrowDown' });
    await flush();
    const panes = JSON.parse(localStorage.getItem('tluxe.ofp.panes.v1')!);
    expect(panes.chart).toBeGreaterThanOrEqual(380);
    expect(screen.getByTestId('ofp-page').style.getPropertyValue('--ofp-main-h')).toBe(`${panes.chart}px`);
  });
});

describe('depth freshness: Order Book, Liquidity Strength and the chart overlay agree; old depth is never current', () => {
  beforeEach(() => localStorage.clear());
  const prov = (depth: StreamLiveness, detail: string | null = null, c = 'GCZ6'): GatewayProvenance => {
    const p = (state: StreamLiveness, d: string | null = null) => ({ state, provider: 'x', timeBasis: 'VPS_DEPTH_UPDATE' as const, contract: c, lastMs: Date.UTC(2026, 9, 9, 14), ageMs: 0, lastPollMs: Date.now(), detail: d });
    return { trades: p('LIVE'), depth: p(depth, detail), bars: p('LIVE'), aggressor: 'EXCHANGE', quality: { tradesAccepted: 0, tradesDuplicate: 0, tradesRejected: 0, tradesOutOfOrder: 0, unknownSide: 0, depthChanges: 0, depthResyncs: 0, depthSeqGaps: 0, depthRejected: 0, gaps: 0, requestErrors: 0, rateLimited: 0 }, requests: 0 };
  };
  const status = (depth: StreamLiveness, detail: string | null = null, feed: SourceStatus['feed'] = 'LIVE', c = contract) => ({ ...offlineStatus('GC', feed, []), marketDataType: 'REALTIME', contract: c, depthRows: 10, provenance: prov(depth, detail, c.localSymbol) }) as SourceStatus;
  const t = Date.UTC(2026, 9, 9, 14, 0, 5);
  const book = { kind: 'book' as const, t, bids: [[4195.3, 4], [4195.2, 2], [4195.1, 1]] as Array<[number, number]>, asks: [[4195.4, 3], [4195.5, 1]] as Array<[number, number]> };
  const trade = { kind: 'trade' as const, t, price: 4195.4, size: 1, aggressor: 'BUY' as const, method: 'EXCHANGE' as const, bid: 4195.3, ask: 4195.4 };

  async function live() {
    const s = scripted();
    installOfpController(new OfpController(s.src));
    render(<OrderFlowProPage />);
    await flush();
    s.push('GC', status('LIVE'), [{ root: 'GC', seq: 1, events: [book, trade] }], t + 1000);
    await flush();
    return s;
  }

  it('LIVE: the book is current in every view', async () => {
    await live();
    expect(screen.queryByTestId('ofp-book-stale')).toBeNull();
    expect(screen.getByRole('table', { name: 'Order book' })).toHaveTextContent('4195.3');
    expect(screen.queryByTestId('ofp-strength-stale')).toBeNull();
    expect(screen.getByTestId('ofp-book-state')).toHaveTextContent('10 × 10 rows');
  });

  it('request failures: book withdrawn -> the last confirmed book is shown dimmed and labelled historical; every view agrees', async () => {
    const s = await live();
    const why = 'No IBKR depth confirmation for > 6 s (gateway depth request failing (HTTP 503)) - book withdrawn; last confirmed 14:00:06 UTC';
    s.push('GC', status('DISCONNECTED', why), [{ root: 'GC', seq: 3, events: [{ kind: 'gap', from: t + 1000, to: t + 8000, reason: why }] }], t + 8000);
    await flush();
    const banner = screen.getByTestId('ofp-book-stale');
    expect(banner).toHaveTextContent('DEPTH DISCONNECTED · NOT CURRENT');
    expect(banner).toHaveTextContent(/showing the last confirmed book \(historical; last change \d\d:\d\d:\d\d UTC\)/);
    expect(banner).toHaveTextContent(/HTTP 503/);
    const old = screen.getByRole('table', { name: 'Last confirmed order book (not current)' });
    expect(old).toHaveClass('is-stale');
    expect(old).toHaveTextContent('4195.3'); // kept, but only as labelled history
    expect(screen.queryByRole('table', { name: 'Order book' })).toBeNull();
    expect(screen.getByTestId('ofp-book-state')).toHaveTextContent('DEPTH DISCONNECTED');
    expect(screen.getByTestId('ofp-strength-stale')).toHaveTextContent('DEPTH DISCONNECTED · no current levels');
    // chart overlay legend: the same rule and the same state
    expect(screen.getByTestId('ofp-liq-status')).toHaveTextContent('DEPTH DISCONNECTED - no current levels');
  });

  it('STALE while the book is still valid (before any gap): already not current anywhere', async () => {
    const s = await live();
    s.push('GC', status('STALE', 'IBKR depth STALE'), [], t + 2000);
    await flush();
    expect(screen.getByTestId('ofp-book-stale')).toHaveTextContent('DEPTH STALE · NOT CURRENT');
    expect(screen.getByTestId('ofp-strength-stale')).toBeInTheDocument();
    expect(screen.getByTestId('ofp-liq-status')).toHaveTextContent('DEPTH STALE - no current levels');
    expect(screen.getByTestId('ofp-book-state')).toHaveTextContent('DEPTH STALE');
  });

  it('contract mismatch: not current; a book from another contract is never shown', async () => {
    const s = await live();
    s.push('GC', status('LIVE', null, 'CONTRACT_MISMATCH'), [], t + 2000);
    await flush();
    expect(screen.getByTestId('ofp-book-stale')).toHaveTextContent('DEPTH CONTRACT MISMATCH · NOT CURRENT');
    expect(screen.getByTestId('ofp-strength-stale')).toHaveTextContent('DEPTH CONTRACT MISMATCH · no current levels');
    expect(screen.getByTestId('ofp-liq-status')).toHaveTextContent('DEPTH CONTRACT MISMATCH - no current levels');
    // roll to another contract: the GCZ6 book is not offered as "last confirmed" for GCG7
    const g7 = { ...contract, localSymbol: 'GCG7', expiry: '20270224' };
    s.push('GC', status('DISCONNECTED', 'waiting', 'LIVE', g7), [{ root: 'GC', seq: 5, events: [{ kind: 'gap', from: t + 2000, to: t + 3000, reason: 'roll' }] }], t + 3000);
    await flush();
    expect(screen.getByTestId('ofp-book-stale')).toHaveTextContent('no confirmed book to show');
    expect(screen.queryByRole('table', { name: 'Last confirmed order book (not current)' })).toBeNull();
  });

  it('recovery: a fresh snapshot makes the book current again and the historical label disappears', async () => {
    const s = await live();
    s.push('GC', status('DISCONNECTED', 'withdrawn'), [{ root: 'GC', seq: 3, events: [{ kind: 'gap', from: t + 1000, to: t + 8000, reason: 'withdrawn' }] }], t + 8000);
    await flush();
    expect(screen.getByTestId('ofp-book-stale')).toBeInTheDocument();
    s.push('GC', status('LIVE'), [{ root: 'GC', seq: 4, events: [{ ...book, t: t + 9000, bids: [[4195.6, 5], [4195.5, 2], [4195.4, 1]], asks: [[4195.7, 3], [4195.8, 1]] }] }], t + 9500);
    await flush();
    expect(screen.queryByTestId('ofp-book-stale')).toBeNull();
    expect(screen.getByRole('table', { name: 'Order book' })).toHaveTextContent('4195.6');
    expect(screen.queryByTestId('ofp-strength-stale')).toBeNull();
    expect(screen.getByTestId('ofp-liq-status')).not.toHaveTextContent(/no current levels/);
    expect(screen.getByTestId('ofp-book-state')).toHaveTextContent('10 × 10 rows');
  });
});
