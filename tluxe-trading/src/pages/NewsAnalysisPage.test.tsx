import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import { MIN, T_CPI, m1Around } from '../engines/news/testing/fixtures';
import { ScriptedCalendarProvider, ScriptedHeadlineProvider, TEST_CALENDAR_INFO, TEST_WIRE_INFO } from '../providers/news/testing/ScriptedNewsProviders';
import { ManualPriceProvider, memoryStorage } from '../test/providers';
import { renderWithServices } from '../test/renderWithServices';

/* TEST DATA ONLY. */

const calls = { news: 0, markers: 0 };
vi.mock('lightweight-charts', () => ({}));
vi.mock('../components/chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setNewsReaction(m: unknown[]) {
      calls.news++;
      calls.markers = m.length;
    }
    onBarClick() {
      return () => {};
    }
    zoomIn() {}
    zoomOut() {}
    fitView() {}
    resetView() {}
    destroy() {}
  },
}));
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => {});
};
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(T_CPI + 70 * MIN));
  calls.news = 0;
  calls.markers = 0;
});
afterEach(() => vi.useRealTimers());

function setup(withProviders: boolean) {
  window.location.hash = '#/engines/news-analysis';
  const price = new ManualPriceProvider('mt5');
  const cal = new ScriptedCalendarProvider(TEST_CALENDAR_INFO, [
    { id: 'cpi', time: T_CPI, title: 'CPI m/m', country: 'US', currency: 'USD', impact: 'high', forecast: '0.3%', previous: '0.2%', actual: '0.4%' },
    { id: 'claims', time: T_CPI, title: 'Initial Jobless Claims', country: 'US', currency: 'USD', impact: 'medium', forecast: '220K', previous: '215K', actual: '240K' },
    { id: 'fomc', time: T_CPI + 2 * 24 * 60 * MIN, title: 'FOMC Rate Decision', country: 'US', currency: 'USD', impact: 'high', forecast: '4.50%', previous: '4.50%' },
  ]);
  const wire = new ScriptedHeadlineProvider(TEST_WIRE_INFO, [{ id: 'geo', publishedAt: T_CPI + 60 * MIN, headline: 'TEST geopolitical headline', category: 'geopolitical', impact: 'high' }]);
  const r = renderWithServices(<App />, { price: [price], ...(withProviders ? { newsAnalysis: { calendar: cal, breaking: wire } } : {}) }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'XAUUSD' }), allowTestProviders: true });
  return { ...r, price, cal, wire };
}

describe('News Analysis page', () => {
  it('is in the sidebar after Liquidity Heatmap and before Sweep / Reversal', async () => {
    setup(false);
    await flush();
    const labels = within(screen.getByRole('navigation', { name: 'Main navigation' })).getAllByRole('link').map((a) => a.textContent);
    const i = labels.indexOf('News Analysis');
    expect(i).toBeGreaterThan(labels.indexOf('Liquidity Heatmap'));
    expect(screen.getByRole('link', { name: 'News Analysis' })).toHaveAttribute('aria-current', 'page');
  });

  it('without providers: NEWS DATA / ECONOMIC CALENDAR / BREAKING NEWS UNAVAILABLE — nothing invented', async () => {
    setup(false);
    await flush();
    expect(screen.getByTestId('nw-unavailable').textContent).toMatch(/NEWS DATA UNAVAILABLE/);
    expect(within(screen.getByTestId('nw-calendar')).getByText('ECONOMIC CALENDAR UNAVAILABLE')).toBeTruthy();
    expect(within(screen.getByTestId('nw-breaking')).getByText('BREAKING NEWS UNAVAILABLE')).toBeTruthy();
    expect(screen.queryAllByTestId('nw-cal-row')).toHaveLength(0);
    expect(screen.queryAllByTestId('nw-headline-row')).toHaveLength(0);
    expect(screen.getByTestId('nw-usd-card').textContent).toMatch(/NEWS DATA UNAVAILABLE/);
    expect(document.body.textContent).not.toMatch(/BUY CONFIRMED|SELL CONFIRMED|place order/i);
  });

  it('with (TEST) providers: calendar, next event, headlines, conflicts, matrix, reaction from MT5 M1', async () => {
    const { price } = setup(true);
    await flush();
    act(() => {
      price.sink.connection('XAUUSD', 'LIVE');
      price.sink.candles('XAUUSD', 'M1', m1Around(T_CPI, 40, 70, 2400, (i) => (i <= 0 ? 0 : Math.min(i, 10))), 'replace');
    });
    await act(async () => void vi.advanceTimersByTime(1100));
    await flush();
    fireEvent.click(within(screen.getByRole('group', { name: 'Date range' })).getByRole('button', { name: 'All' }));
    await flush();
    expect(screen.getAllByTestId('nw-cal-row').length).toBe(3);
    expect(within(screen.getByTestId('nw-next')).getByText('FOMC Rate Decision')).toBeTruthy();
    expect(screen.getAllByTestId('nw-headline-row')).toHaveLength(1);
    expect(screen.getByTestId('nw-usd-card').textContent).toMatch(/MIXED/);
    expect(screen.getByTestId('nw-usd-card').textContent).toMatch(/CONFLICTING DRIVERS/);
    expect(within(screen.getByTestId('nw-xau')).getByText('CONFLICTING DRIVERS')).toBeTruthy();
    expect(screen.getByTestId('nw-chart-state').textContent).toBe('REACTION COMPLETE');
    expect(calls.markers).toBeGreaterThan(1);
    // Clicking a calendar event opens its detail with expected mechanism, observed reaction and timeline.
    fireEvent.click(screen.getAllByTestId('nw-cal-row').find((r) => r.textContent!.includes('CPI m/m'))!);
    await flush();
    const detail = screen.getByTestId('nw-detail');
    expect(within(detail).getByText('CPI m/m')).toBeTruthy();
    expect(detail.textContent).toMatch(/ABOVE FORECAST/);
    expect(detail.textContent).toMatch(/HOTTER/);
    expect(within(detail).getByTestId('nw-reaction').textContent).toMatch(/\+5 min/);
    expect(within(detail).getAllByRole('listitem').length).toBeGreaterThan(5);
    expect(screen.getByTestId('nw-clocks').textContent).toMatch(/Denver/);
  });

  it('page switching never reconnects providers', async () => {
    const { cal, wire } = setup(true);
    await flush();
    for (const h of ['#/engines/smc', '#/', '#/engines/news-analysis']) {
      act(() => {
        window.location.hash = h;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      await flush();
    }
    expect(cal.connects).toBe(1);
    expect(wire.connects).toBe(1);
  });
});
