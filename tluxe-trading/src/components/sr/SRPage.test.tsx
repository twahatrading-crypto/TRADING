import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import * as F from '../../engines/sr/fixtures/scenarios';
import { ManualPriceProvider } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';

const setZones = vi.fn();
vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setOverlays() {}
    setZones(z: unknown) {
      setZones(z);
    }
    screenshot() {
      return document.createElement('canvas');
    }
    destroy() {}
  },
}));

const open = () => {
  window.location.hash = '#/engines/support-resistance';
};

function withData() {
  open();
  const futures = new ManualPriceProvider('futures-feed');
  const mt5 = new ManualPriceProvider('mt5');
  const r = renderWithServices(<App />, { price: [futures, mt5] });
  // Deterministic TEST fixtures delivered through the provider interface (never in production).
  act(() => {
    futures.sink.connection('GC', 'DELAYED');
    futures.sink.candles('GC', 'H1', F.supportToResistanceFlip(), 'replace');
    futures.sink.candles('GC', 'M15', F.strongSupport('M15'), 'replace');
    futures.sink.candles('GC', 'H4', F.h4SupportNear100(), 'replace');
  });
  return { ...r, futures, mt5 };
}

const rows = () => screen.queryAllByTestId(/^zone-row-/);
const lastDrawn = () => (setZones.mock.calls.at(-1)?.[0] ?? []) as { id: string; selected: boolean; highlighted: boolean }[];
const detailValue = (label: string) => within(screen.getByRole('region', { name: 'Zone Details' })).getByText(label).nextElementSibling!.textContent;

beforeEach(() => setZones.mockClear());

describe('S&R page without a provider', () => {
  it('shows truthful unavailable states and no zones or example prices', () => {
    open();
    const { container } = renderWithServices(<App />);
    expect(screen.getByRole('heading', { name: /Support & Resistance/ })).toBeInTheDocument();
    expect(screen.getAllByText('MARKET DATA NOT CONNECTED').length).toBeGreaterThan(0);
    expect(screen.getByText('Data Not Connected')).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
    expect(screen.getByTestId('sr-chart-state')).toHaveTextContent('MARKET DATA NOT CONNECTED');
    expect(container.textContent).not.toMatch(/2,362\.4|2,405\.2|2,318\.4/);
    for (const k of ['timeframe', 'reaction', 'touchQuality', 'freshness', 'structure', 'confluence']) {
      expect(screen.getByTestId(`score-${k}`)).toHaveTextContent('—');
    }
  });

  it('NASDAQ category reports S&R DATA UNAVAILABLE', () => {
    open();
    const { services } = renderWithServices(<App />);
    act(() => services.instruments.select('NASDAQ'));
    expect(screen.getAllByText('S&R DATA UNAVAILABLE').length).toBeGreaterThan(0);
  });

  it('connected with too little history reports INSUFFICIENT HISTORY', () => {
    open();
    const futures = new ManualPriceProvider('futures-feed');
    renderWithServices(<App />, { price: [futures] });
    act(() => {
      futures.sink.connection('GC', 'LIVE');
      futures.sink.candles('GC', 'H1', F.strongSupport().slice(0, 20), 'replace');
    });
    expect(screen.getByTestId('sr-chart-state')).toHaveTextContent('INSUFFICIENT HISTORY · 19/50 bars');
  });
});

describe('S&R page with provider candles (test fixtures)', () => {
  it('lists engine zones; selecting a row opens details, real score values and highlights on the chart', async () => {
    const { services } = withData();
    await waitFor(() => expect(setZones).toHaveBeenCalled());
    expect(rows().length).toBeGreaterThan(0);
    const engineZones = services.sr.store('GC').getState().multi!.zones;
    const first = rows()[0]!;
    fireEvent.click(first);
    const id = first.getAttribute('data-testid')!.replace('zone-row-', '');
    const z = engineZones.find((x) => x.id === id)!;
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(detailValue('Touches')).toMatch(new RegExp(`^${z.touchCount} `));
    expect(detailValue('Status')).toBe(z.status);
    for (const [k, v] of Object.entries(z.score.components)) expect(screen.getByTestId(`score-${k}`)).toHaveTextContent(String(Math.round(v)));
    await waitFor(() => expect(lastDrawn().find((d) => d.id === id)?.selected).toBe(true));
  });

  it('filters by type and timeframe without changing engine state', () => {
    const { services } = withData();
    const before = services.sr.store('GC').getState();
    fireEvent.click(within(screen.getByRole('group', { name: 'Zone type' })).getByRole('button', { name: /^Support/ }));
    expect(rows().every((r) => within(r).queryByText('Resistance') === null)).toBe(true);
    fireEvent.click(within(screen.getByRole('group', { name: 'Timeframe' })).getByRole('button', { name: 'H4' }));
    expect(rows().every((r) => within(r).getByText('H4'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Score' }));
    expect(services.sr.store('GC').getState()).toBe(before);
  });

  it('shows MTF confluence and highlights its zones when clicked', async () => {
    withData();
    await waitFor(() => expect(setZones).toHaveBeenCalled());
    const panel = screen.getByRole('region', { name: 'Multi-Timeframe Confluence' });
    expect(within(panel).getByText('H4')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Highlight confluence zones on chart' }));
    await waitFor(() => expect(lastDrawn().filter((d) => d.highlighted).length).toBeGreaterThanOrEqual(2));
  });

  it('Analysis tab states facts only — never BUY/SELL/LONG/SHORT', () => {
    const { container } = withData();
    fireEvent.click(screen.getByRole('tab', { name: 'Analysis' }));
    expect(screen.getByText('Nearest support')).toBeInTheDocument();
    expect(screen.getByText('MTF confluence nearby')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b(BUY|SELL|LONG|SHORT)\b/);
  });

  it('Settings tab changes recalculate the engine', () => {
    const { services } = withData();
    const key = services.sr.store('GC').getState().byTimeframe.H1!.settingsKey;
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    fireEvent.change(screen.getByLabelText('Pivot confirmation bars'), { target: { value: '5' } });
    expect(services.sr.store('GC').getState().byTimeframe.H1!.settingsKey).not.toBe(key);
  });

  it('19. switching symbol removes every GC zone from table, details and chart', async () => {
    const { services } = withData();
    await waitFor(() => expect(setZones).toHaveBeenCalled());
    fireEvent.click(rows()[0]!);
    act(() => services.instruments.select('XAUUSD'));
    expect(rows()).toHaveLength(0);
    expect(screen.queryAllByText(/^GC:/)).toHaveLength(0);
    expect(screen.getByRole('region', { name: 'Zone Details' })).toHaveTextContent('MARKET DATA NOT CONNECTED');
    // The GC chart controller is torn down on switch; nothing drawn afterwards may be a GC zone.
    const callsAfter = setZones.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(setZones.mock.calls.slice(callsAfter).flat(2).some((d) => (d as { id: string }).id.startsWith('GC:'))).toBe(false);
    act(() => services.instruments.select('GC'));
    expect(rows().length).toBeGreaterThan(0);
  });
});
