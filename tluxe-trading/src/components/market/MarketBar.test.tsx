import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ManualPriceProvider } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';
import { MarketBar } from './MarketBar';

const bar = () => screen.getByRole('banner', { name: 'Market bar' });

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
    const quoteArea = [...bar().querySelectorAll('.mbar__price, .mbar__fields')].map((e) => e.textContent).join(' ');
    expect(quoteArea).not.toMatch(/\d/);
  });

  it('reports price and depth separately', () => {
    renderWithServices(<MarketBar />);
    expect(screen.getByTestId('depth-status')).toHaveTextContent('Depth: Not connected');
  });
});

describe('MarketBar — with a provider', () => {
  it('shows CONNECTING, then values only once the provider supplies them', () => {
    const p = new ManualPriceProvider('futures-feed');
    renderWithServices(<MarketBar />, { price: [p] });
    expect(screen.getByText('Test futures-feed')).toBeInTheDocument();
    act(() => p.sink.connection('GC', 'CONNECTING'));
    expect(screen.getByText('GC CONNECTING…')).toBeInTheDocument();
    act(() => {
      p.sink.connection('GC', 'LIVE');
      p.sink.quote('GC', { last: 2401.3, change: -4.2, changePercent: -0.17, bid: 2401.2 });
    });
    expect(screen.getByText('2,401.3')).toBeInTheDocument();
    expect(screen.getByText('−4.2 (−0.17%)')).toBeInTheDocument();
    expect(within(screen.getByText('Ask').parentElement!).getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    // Price connected does not mean depth connected.
    expect(screen.getByTestId('depth-status')).toHaveTextContent('Depth: Not connected');
  });

  it('marks last-known values STALE after a disconnect', () => {
    const p = new ManualPriceProvider('futures-feed');
    renderWithServices(<MarketBar />, { price: [p] });
    act(() => {
      p.sink.connection('GC', 'LIVE');
      p.sink.quote('GC', { last: 2401.3 });
      p.sink.connection('GC', 'DISCONNECTED');
    });
    expect(screen.getByText('STALE')).toBeInTheDocument();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });
});
