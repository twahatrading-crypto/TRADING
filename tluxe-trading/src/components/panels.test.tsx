import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithServices } from '../test/renderWithServices';
import type { EconomicEvent } from '../types/calendar';
import { AiPanel } from './ai/AiPanel';
import { CalendarList, CalendarPanel } from './calendar/CalendarPanel';
import { ChartPanel } from './chart/ChartPanel';
import { NewsPanel } from './news/NewsPanel';
import { SystemStatusPanel } from './status/SystemStatusPanel';
import { render } from '@testing-library/react';

describe('ChartPanel', () => {
  it('shows MARKET DATA NOT CONNECTED and no chart canvas when there are no candles', () => {
    renderWithServices(<ChartPanel />);
    expect(screen.getByText('MARKET DATA NOT CONNECTED')).toBeInTheDocument();
    expect(screen.getByTestId('chart-canvas')).not.toBeVisible();
    expect(screen.getByText(/0 bars/)).toBeInTheDocument();
  });

  it('offers all seven timeframes and switches selection', () => {
    renderWithServices(<ChartPanel />);
    const tabs = within(screen.getByRole('tablist', { name: 'Chart timeframe' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']);
    fireEvent.click(screen.getByRole('tab', { name: 'M15' }));
    expect(screen.getByRole('tab', { name: 'M15' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/Timeframe: M15/)).toBeInTheDocument();
  });

  it('keeps overlay layers disabled (no engines in Phase 1)', () => {
    renderWithServices(<ChartPanel />);
    for (const label of ['Liquidity', 'Order Blocks', 'FVG', 'BOS', 'CHoCH']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }
  });
});

describe('CalendarPanel', () => {
  it('shows ECONOMIC CALENDAR NOT CONNECTED with no invented events', () => {
    renderWithServices(<CalendarPanel />);
    expect(screen.getByText('ECONOMIC CALENDAR NOT CONNECTED')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'HIGH' })).toBeDisabled();
  });

  it('renders provider events with obvious high-impact styling and unknown values as —', () => {
    const events: EconomicEvent[] = [
      { id: 'a', time: Date.UTC(2026, 8, 23, 12, 30), country: 'US', currency: 'USD', event: 'Test High', importance: 'HIGH', previous: '1%', forecast: null, actual: null },
      { id: 'b', time: Date.UTC(2026, 8, 23, 14, 0), country: 'EU', currency: 'EUR', event: 'Test Low', importance: 'LOW', previous: null, forecast: null, actual: null },
    ];
    render(<CalendarList events={events} tz="UTC" />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveClass('cal__row--high');
    expect(rows[0]).toHaveAttribute('data-importance', 'HIGH');
    expect(within(rows[0]!).getByText('HIGH')).toHaveClass('cal__imp--high');
    expect(within(rows[0]!).getByText('12:30')).toBeInTheDocument();
    expect(within(rows[1]!).getAllByText('—')).toHaveLength(3);
  });
});

describe('NewsPanel', () => {
  it('shows NEWS PROVIDER NOT CONNECTED and no headlines', () => {
    renderWithServices(<NewsPanel />);
    expect(screen.getByText('NEWS PROVIDER NOT CONNECTED')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    for (const c of ['GOLD', 'USD', 'FED', 'RATES', 'INFLATION', 'GEOPOLITICS', 'COMEX']) {
      expect(screen.getByRole('button', { name: c })).toBeDisabled();
    }
  });
});

describe('AiPanel', () => {
  it('declares itself Not Connected with all tabs and actions present', () => {
    renderWithServices(<AiPanel />);
    expect(screen.getByText('TLUXE AI')).toBeInTheDocument();
    expect(screen.getByText('Trading Research & Development Assistant')).toBeInTheDocument();
    expect(screen.getByText('Not Connected')).toBeInTheDocument();
    for (const t of ['Chat', 'Research', 'Analysis', 'Tools']) expect(screen.getByRole('tab', { name: t })).toBeInTheDocument();
    for (const a of ['Analyze Market', 'Check My Engine', 'Find Problems', 'Deep Research', 'Build Feature'])
      expect(screen.getByRole('button', { name: a })).toBeInTheDocument();
  });

  it('does not fabricate a reply when a message is sent', async () => {
    const { container } = renderWithServices(<AiPanel />);
    fireEvent.change(screen.getByLabelText('Message TLUXE AI'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Not sent — TLUXE AI is not connected/)).toBeInTheDocument();
    expect(container.querySelector('.ai__msg--assistant')).toBeNull();
  });
});

describe('SystemStatusPanel', () => {
  it('renders the truthful Phase 1 status for every item', () => {
    renderWithServices(<SystemStatusPanel />);
    const value = (id: string) => screen.getByTestId(`status-${id}`).textContent;
    expect(value('app')).toContain('ONLINE');
    for (const id of ['market', 'ai', 'database', 'news', 'calendar']) expect(value(id)).toContain('NOT CONNECTED');
    for (const id of ['order-block', 'liquidity', 'support-resistance', 'sweep-reversal']) expect(value(`engine-${id}`)).toContain('DISABLED');
    expect(screen.getByText('1/6 online')).toBeInTheDocument();
  });
});
