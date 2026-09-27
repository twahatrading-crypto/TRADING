import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { ServicesProvider } from '../../app/ServicesProvider';
import { DatabentoFootprintProvider, DatabentoMarketProvider, DatabentoOrderFlowProvider } from '../../providers/databento/adapters';
import { DEFAULT_DATABENTO_CONFIG } from '../../providers/databento/config';
import { DatabentoFeed } from '../../providers/databento/DatabentoFeed';
import { FakeBridge } from '../../providers/databento/testing/FakeBridge';
import { connectServices, createServices, defaultProviders } from '../../services/registry';
import { memoryStorage } from '../../test/providers';

/* TEST DATA ONLY — FakeBridge stands in for the local bridge. */

vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setOverlays() {}
    setZones() {}
    setFootprint() {}
    setEventMarkers() {}
    autoScalePrice() {}
    onBarClick() {
      return () => {};
    }
    destroy() {}
  },
}));

let teardown: (() => void) | null = null;
afterEach(() => {
  teardown?.();
  teardown = null;
});

function mount(instrument = 'GC', bridge = new FakeBridge()) {
  window.location.hash = '#/settings';
  const feed = new DatabentoFeed({ ...DEFAULT_DATABENTO_CONFIG, enabled: true, token: 'x'.repeat(40), pollMs: 3_600_000, healthMs: 3_600_000 }, { api: bridge });
  const flow = new DatabentoOrderFlowProvider(feed);
  const services = createServices({ ...defaultProviders(), price: [new DatabentoMarketProvider(feed)], orderFlow: { depth: flow, trade: flow }, footprint: new DatabentoFootprintProvider(feed), databento: feed }, { storage: memoryStorage({ 'tluxe.instrument.v1': instrument }) });
  teardown = connectServices(services);
  const listenersBefore = feed.listenerCount();
  render(
    <StrictMode>
      <ServicesProvider services={services}>
        <App />
      </ServicesProvider>
    </StrictMode>,
  );
  return { feed, bridge, services, listenersBefore };
}

describe('Databento provider strip', () => {
  it('GC: DATABENTO • GLBX.MDP3 • LIVE with the ACTUAL contract; diagnostics expand; StrictMode adds no connection', async () => {
    const { feed, bridge, listenersBefore } = mount('GC');
    await act(async () => {
      await feed.healthOnce();
    });
    expect(screen.getByTestId('databento-badge').textContent).toMatch(/DATABENTO • GLBX\.MDP3 • LIVE/);
    expect(screen.getByTestId('databento-contract').textContent).toBe('GC • GCZ6');
    fireEvent.click(screen.getByRole('button', { name: /Diagnostics/ }));
    const d = screen.getByTestId('databento-diagnostics').textContent!;
    expect(d).toMatch(/Actual contract\s*GCZ6/);
    expect(d).toMatch(/Instrument ID\s*42001/);
    expect(d).toMatch(/Dataset\s*GLBX\.MDP3/);
    expect(d).toMatch(/Sequence health\s*OK/);
    // React StrictMode (double effects) and page rendering never open more Databento listeners / loops.
    expect(feed.listenerCount()).toBe(listenersBefore);
    // Exactly ONE automatic poll chain exists (a duplicated loop would have issued two first polls).
    await act(async () => new Promise<void>((r) => setTimeout(r, 50)));
    expect(bridge.calls.filter((c) => c === 'feed').length).toBe(1);
  });

  it('XAUUSD (MT5 spot): no Databento strip — the providers are never mixed', () => {
    mount('XAUUSD');
    expect(screen.queryByTestId('databento-strip')).toBeNull();
  });

  it('many frames in one poll → one batched UI publish (never one render per market event)', async () => {
    const { feed, bridge, services } = mount('GC');
    await act(async () => {
      await feed.healthOnce();
    });
    let updates = 0;
    const off = services.orderFlow.store.subscribe(() => (updates += 1));
    for (let k = 0; k < 200; k++) bridge.frame({ GC: { trades: [bridge.trade('GC', 2400, 1, 'BUY', 1_790_000_000_000 + k)] } });
    await act(async () => {
      await feed.pollOnce();
    });
    off();
    expect(updates).toBeLessThanOrEqual(2);
    expect(feed.state.getState().framesReceived).toBe(200);
  });
});
