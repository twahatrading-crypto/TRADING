import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MarketDataProvider, MarketDataSink } from '../../services/market/MarketDataProvider';
import { renderWithServices } from '../../test/renderWithServices';
import { MarketBar } from './MarketBar';

class ManualProvider implements MarketDataProvider {
  readonly info = { id: 'test', name: 'Test Feed', declaredDelaySec: null };
  sink!: MarketDataSink;
  connect(_s: string, sink: MarketDataSink) {
    this.sink = sink;
  }
  disconnect() {}
  requestCandles() {}
}

describe('MarketBar — no provider', () => {
  it('shows GC DATA UNAVAILABLE and Provider: Not Connected', () => {
    renderWithServices(<MarketBar />);
    expect(screen.getByText('GC DATA UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByText('Not Connected')).toBeInTheDocument();
    expect(screen.getByText('Data Unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/^Live$/)).not.toBeInTheDocument();
  });

  it('renders every quote field as unknown, never 0', () => {
    renderWithServices(<MarketBar />);
    for (const label of ['Bid', 'Ask', 'High', 'Low', 'Volume']) {
      const field = screen.getByText(label).parentElement!;
      expect(within(field).getByText('—')).toBeInTheDocument();
    }
    expect(screen.queryByTestId('quote-values')).not.toBeInTheDocument();
    // No price-like number anywhere in the bar except the clock.
    const bar = screen.getByRole('banner', { name: 'GC market bar' });
    const withoutClock = bar.textContent!.replace(screen.getByLabelText('Current date and time').textContent!, '');
    expect(withoutClock).not.toMatch(/\d/);
  });
});

describe('MarketBar — with a provider', () => {
  it('shows CONNECTING, then values only once the provider supplies them', () => {
    const p = new ManualProvider();
    renderWithServices(<MarketBar />, { market: p });
    expect(screen.getByText('Test Feed')).toBeInTheDocument();
    act(() => p.sink.connection('CONNECTING'));
    expect(screen.getByText('GC CONNECTING…')).toBeInTheDocument();
    act(() => {
      p.sink.connection('LIVE');
      p.sink.quote({ last: 2401.3, change: -4.2, changePercent: -0.17, bid: 2401.2 });
    });
    expect(screen.getByText('2,401.3')).toBeInTheDocument();
    expect(screen.getByText('−4.2 (−0.17%)')).toBeInTheDocument();
    expect(within(screen.getByText('Ask').parentElement!).getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('marks last-known values STALE after a disconnect', () => {
    const p = new ManualProvider();
    renderWithServices(<MarketBar />, { market: p });
    act(() => {
      p.sink.connection('LIVE');
      p.sink.quote({ last: 2401.3 });
      p.sink.connection('DISCONNECTED');
    });
    expect(screen.getByText('STALE')).toBeInTheDocument();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });
});
