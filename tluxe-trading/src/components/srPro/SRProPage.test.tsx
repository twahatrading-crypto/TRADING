import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import * as F from '../../engines/sr/fixtures/scenarios';
import { ManualPriceProvider } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';

const calls = { zones: vi.fn(), smc: vi.fn(), bands: vi.fn() };
vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setOverlays() {}
    setZones(z: unknown) {
      calls.zones(z);
    }
    setSmc(d: unknown, m: unknown) {
      calls.smc(d, m);
    }
    setTimeBands(b: unknown) {
      calls.bands(b);
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

const open = () => {
  window.location.hash = '#/engines/support-resistance';
};

/** TEST fixtures delivered through the provider interface (never in production). */
function withData() {
  open();
  const futures = new ManualPriceProvider('futures-feed');
  const r = renderWithServices(<App />, { price: [futures, new ManualPriceProvider('mt5')] });
  act(() => {
    futures.sink.connection('GC', 'DELAYED');
    futures.sink.candles('GC', 'H1', F.supportToResistanceFlip(), 'replace');
    futures.sink.candles('GC', 'M15', F.strongSupport('M15'), 'replace');
    futures.sink.candles('GC', 'H4', F.h4SupportNear100(), 'replace');
  });
  return { ...r, futures };
}

/** A percentage, a confidence figure or an upper-case trade signal. (The page's own disclaimers say "no probability" / "not a buy/sell signal".) */
const FORBIDDEN = /\d\s?%(?! of reference)|confidence|\b(BUY|SELL|LONG|SHORT)\b/;

beforeEach(() => {
  Object.values(calls).forEach((c) => c.mockClear());
  localStorage.removeItem('tluxe.sr.view');
  localStorage.removeItem('tluxe.srpro.overlays');
});

describe('S&R Pro view', () => {
  it('is the default view of the S&R route; the classic view stays one click away', () => {
    open();
    renderWithServices(<App />);
    expect(screen.getByTestId('srp-page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Classic view/ }));
    expect(screen.queryByTestId('srp-page')).toBeNull();
    expect(document.querySelector('.srgrid')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pro view' }));
    expect(screen.getByTestId('srp-page')).toBeInTheDocument();
  });

  it('without data: NO DATA, no zones, no invented values', () => {
    open();
    renderWithServices(<App />);
    expect(screen.getByTestId('srp-feed')).toHaveTextContent('NO DATA');
    expect(screen.queryByTestId('srp-zone-table')).toBeNull();
    expect(screen.getByTestId('srp-scenario-BULLISH')).toHaveTextContent('NOT AVAILABLE');
    expect(screen.getByTestId('srp-scenario-NO_TRADE')).toHaveTextContent('ACTIVE');
    expect(screen.getByTestId('srp-page').textContent).not.toMatch(FORBIDDEN);
  });

  it('with candles: tiers, zone table, click → evidence + chart highlight; no signals or percentages', async () => {
    withData();
    await waitFor(() => expect(calls.zones).toHaveBeenCalled());
    const page = screen.getByTestId('srp-page');
    for (const t of ['Strong', 'Medium', 'Weak', 'Inactive']) expect(within(page).getAllByText(t).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: 'Zones' }));
    const table = screen.getByTestId('srp-zone-table');
    const firstRow = within(table).getAllByRole('row')[1]!;
    fireEvent.click(firstRow);
    expect(screen.getByRole('tab', { name: 'Analysis' })).toHaveAttribute('aria-selected', 'true');
    const ev = screen.getAllByTestId('srp-zone-evidence')[0]!;
    expect(ev).toHaveTextContent(/Why this rating/);
    expect(ev).toHaveTextContent(/Invalidation/);
    expect(ev).toHaveTextContent(/consecutive .* closes/);
    await waitFor(() => expect((calls.zones.mock.calls.at(-1)?.[0] as { selected: boolean }[]).some((z) => z.selected)).toBe(true));
    expect(page.textContent).not.toMatch(FORBIDDEN);
  });

  it('overlay toggles reach the chart (zones off → none drawn)', async () => {
    withData();
    await waitFor(() => expect((calls.zones.mock.calls.at(-1)?.[0] as unknown[] | undefined)?.length).toBeGreaterThan(0));
    fireEvent.click(within(screen.getByTestId('srp-page')).getByRole('button', { name: 'S&R zones' }));
    await waitFor(() => expect(calls.zones.mock.calls.at(-1)?.[0]).toEqual([]));
    expect(calls.bands).toHaveBeenCalled();
    expect(calls.smc).toHaveBeenCalled();
  });

  it('Key Levels tab labels the exact Asia boundaries and switches session definition', () => {
    withData();
    fireEvent.click(screen.getByRole('tab', { name: 'Key Levels' }));
    const cme = screen.getByRole('button', { name: /Asia \(CME desk\) · 18:00–03:00 New York/ });
    const tokyo = screen.getByRole('button', { name: /Asia \(Tokyo\) · 09:00–18:00 Tokyo/ });
    expect(cme).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(tokyo);
    expect(tokyo).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('tluxe.srpro.asia')).toBe('"tokyo"');
  });

  it('IBKR order-book evidence is never shown as live unless it is', () => {
    withData();
    fireEvent.click(screen.getByRole('tab', { name: 'Liquidity' }));
    expect(screen.getByText(/No order-book evidence is shown or used while depth is not live/)).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.tagName === 'LI' && /INFERRED from swing structure by the Liquidity engine — not resting orders/.test(el.textContent ?? ''))).toBeInTheDocument();
  });
});
