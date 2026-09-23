import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { INSTRUMENTS } from '../../config/instruments';
import { SELECTED_INSTRUMENT_KEY } from '../../services/instruments/InstrumentSelection';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';
import { AiPanel } from '../ai/AiPanel';
import { CalendarPanel } from '../calendar/CalendarPanel';
import { ChartPanel } from '../chart/ChartPanel';
import { NewsPanel } from '../news/NewsPanel';
import { SystemStatusPanel } from '../status/SystemStatusPanel';
import { MarketBar } from './MarketBar';

// Chart drawing needs canvas; the controller is replaced so tests observe data flow only.
vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setOverlays() {}
    destroy() {}
  },
}));

function Dash() {
  return (
    <>
      <MarketBar />
      <ChartPanel />
      <NewsPanel />
      <CalendarPanel />
      <SystemStatusPanel />
      <AiPanel />
    </>
  );
}

const marketBar = () => screen.getByRole('banner', { name: 'Market bar' });
const trigger = () => screen.getByRole('button', { name: /Change instrument/ });
const open = () => fireEvent.click(trigger());
const pick = (id: string) => {
  open();
  fireEvent.click(screen.getByTestId(`symbol-option-${id}`));
};

describe('symbol selector', () => {
  it('lists every instrument in Futures / Metals / Forex / Crypto / Indices groups', () => {
    renderWithServices(<MarketBar />);
    open();
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['Futures', 'Metals', 'Forex', 'Crypto', 'Indices']);
    expect(screen.getAllByRole('option')).toHaveLength(INSTRUMENTS.length);
    const metals = screen.getByRole('group', { name: 'Metals' });
    expect(within(metals).getByText('XAUUSD')).toBeInTheDocument();
    expect(within(metals).getByText('Gold / US Dollar')).toBeInTheDocument();
  });

  it('shows a per-instrument feed indicator that is not connected for all', () => {
    renderWithServices(<MarketBar />);
    open();
    expect(screen.getAllByRole('img', { name: 'Price feed not connected' })).toHaveLength(INSTRUMENTS.length);
  });

  it('filters by search and selects with the keyboard', () => {
    const { services } = renderWithServices(<MarketBar />);
    open();
    const search = screen.getByRole('combobox', { name: 'Search instruments' });
    fireEvent.change(search, { target: { value: 'silver' } });
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-testid'))).toEqual(['symbol-option-SI', 'symbol-option-XAGUSD']);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(services.instruments.active.id).toBe('XAGUSD');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows a no-match message', () => {
    renderWithServices(<MarketBar />);
    open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'cadusd' } });
    expect(screen.getByText(/No instruments match/)).toBeInTheDocument();
  });

  it('opens with Ctrl+K and closes with Escape', () => {
    renderWithServices(<MarketBar />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const search = screen.getByRole('combobox');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});

describe('switching the whole dashboard context', () => {
  it.each([
    ['SI', 'SI — COMEX Silver Futures', 'SI Price Chart', 'Depth: Not connected'],
    ['XAUUSD', 'XAUUSD — Gold / US Dollar', 'XAUUSD Price Chart', 'Depth: Unsupported'],
    ['BTCUSD', 'BTCUSD — Bitcoin', 'BTCUSD Price Chart', 'Depth: Not connected'],
    ['USDCAD', 'USDCAD — US Dollar / Canadian Dollar', 'USDCAD Price Chart', 'Depth: Unsupported'],
  ])('selecting %s updates bar, chart and status without reload', (id, display, chartTitle, depth) => {
    renderWithServices(<Dash />);
    pick(id);
    expect(trigger()).toHaveAccessibleName(`Instrument: ${display}. Change instrument`);
    expect(screen.getByText(`${id} DATA UNAVAILABLE`)).toBeInTheDocument();
    expect(within(marketBar()).getByText('Not Connected')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: chartTitle })).toBeInTheDocument();
    expect(screen.getByText('MARKET DATA NOT CONNECTED')).toBeInTheDocument();
    expect(screen.getByTestId('depth-status')).toHaveTextContent(depth);
    expect(screen.getByText(`Price Data · ${id}`)).toBeInTheDocument();
    expect(screen.getByTestId('ai-instrument')).toHaveTextContent(id);
    expect(screen.queryByText(/^GC /)).not.toBeInTheDocument();
  });

  it('remembers the selected symbol between sessions', () => {
    const storage = memoryStorage();
    const first = renderWithServices(<MarketBar />, {}, { storage });
    pick('ETHUSD');
    expect(storage.data.get(SELECTED_INSTRUMENT_KEY)).toBe('ETHUSD');
    first.unmount();
    renderWithServices(<MarketBar />, {}, { storage });
    expect(screen.getByText('ETHUSD DATA UNAVAILABLE')).toBeInTheDocument();
  });

  it('keeps the timeframe per instrument', () => {
    renderWithServices(<ChartPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'M5' }));
    expect(screen.getByRole('tab', { name: 'M5' })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches news topics and calendar currencies with the instrument', () => {
    const { services } = renderWithServices(<Dash />);
    const topics = () => within(screen.getByRole('group', { name: 'News categories' })).getAllByRole('button').map((b) => b.textContent);
    expect(topics()).toContain('COMEX');
    act(() => services.instruments.select('EURUSD'));
    expect(topics()).toEqual(['FX', 'USD', 'FED', 'RATES', 'INFLATION']);
    expect(screen.getByText(/EURUSD · EUR, USD releases/)).toBeInTheDocument();
    act(() => services.instruments.select('BTCUSD'));
    expect(topics()).toContain('CRYPTO');
    expect(topics()).not.toContain('COMEX');
  });

  it('explains that NASDAQ is a category that must resolve to a specific instrument', () => {
    const { services } = renderWithServices(<Dash />);
    act(() => services.instruments.select('NASDAQ'));
    expect(screen.getByText(/NASDAQ is a category/)).toBeInTheDocument();
    expect(screen.getByTestId('status-price')).toHaveTextContent('UNSUPPORTED');
  });
});

describe('no stale GC data after switching', () => {
  it('GC quote and candles never appear on another instrument', () => {
    const futures = new ManualPriceProvider('futures-feed');
    const { services, container } = renderWithServices(<Dash />, { price: [futures] });
    act(() => {
      futures.sink.connection('GC', 'LIVE');
      futures.sink.quote('GC', { last: 2412.7, bid: 2412.6, ask: 2412.8, volume: 12345 });
      futures.sink.candles('GC', 'H1', [{ time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }], 'replace');
    });
    expect(screen.getByText('2,412.7')).toBeInTheDocument();
    expect(screen.queryByText('MARKET DATA NOT CONNECTED')).not.toBeInTheDocument();

    act(() => services.instruments.select('XAUUSD'));
    expect(screen.queryByText('2,412.7')).not.toBeInTheDocument();
    expect(screen.queryByText('2,412.6')).not.toBeInTheDocument();
    expect(screen.queryByText('12,345')).not.toBeInTheDocument();
    expect(screen.getByText('XAUUSD DATA UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByText('MARKET DATA NOT CONNECTED')).toBeInTheDocument();
    expect(within(marketBar()).getByText('Not Connected')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Test futures-feed/);

    // Switching back shows GC's own (still live) data again.
    act(() => services.instruments.select('GC'));
    expect(screen.getByText('2,412.7')).toBeInTheDocument();
  });

  it('a GC feed does not make SI look connected', () => {
    const futures = new ManualPriceProvider('futures-feed');
    const { services } = renderWithServices(<MarketBar />, { price: [futures] });
    act(() => futures.sink.connection('GC', 'LIVE'));
    act(() => services.instruments.select('SI'));
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });

  it('subscribes the provider to the active instrument only', () => {
    const futures = new ManualPriceProvider('futures-feed');
    const mt5 = new ManualPriceProvider('mt5');
    const { services } = renderWithServices(<MarketBar />, { price: [futures, mt5] });
    expect(futures.subscribed).toEqual(['GC']);
    act(() => services.instruments.select('XAGUSD'));
    expect(futures.subscribed).toEqual([]);
    expect(mt5.subscribed).toEqual(['XAGUSD']);
  });
});

describe('AI requests carry the active instrument', () => {
  it('sends instrumentId explicitly', async () => {
    const send = vi.fn(async () => ({ text: 'ok' }));
    const { services } = renderWithServices(<AiPanel />, {
      ai: { name: 'Test', status: () => 'CONNECTED', send },
    });
    act(() => services.instruments.select('SOLUSD'));
    fireEvent.change(screen.getByLabelText('Message TLUXE AI'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('ok');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ instrumentId: 'SOLUSD' }));
  });
});
