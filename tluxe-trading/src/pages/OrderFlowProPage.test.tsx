import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { offlineStatus } from '../engines/orderFlowPro/engine';
import type { OfpFrame, OfpRoot, SourceStatus } from '../engines/orderFlowPro/types';
import { installOfpController, OfpController } from '../providers/orderFlowPro/controller';
import type { OfpSource, SourceSink } from '../providers/orderFlowPro/source';
import { DemoSource } from '../providers/orderFlowPro/testing/DemoSource';
import { BackendSource } from '../providers/orderFlowPro/BackendSource';
import { OrderFlowProPage } from './OrderFlowProPage';

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
