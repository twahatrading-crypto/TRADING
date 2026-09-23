import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';

vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({
  ChartController: class {
    setData() {}
    upsert() {}
    setOverlays() {}
    setZones() {}
    screenshot() {
      return document.createElement('canvas');
    }
    destroy() {}
  },
}));

const go = (hash: string) =>
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });

const nav = () => screen.getByRole('navigation', { name: 'Main navigation' });

beforeEach(() => {
  window.location.hash = '#/';
  localStorage.clear();
});

describe('Left sidebar navigation', () => {
  it('is present on every page with branding, Dashboard and Trading Strategy', () => {
    renderWithServices(<App />);
    for (const hash of ['#/', '#/engines/support-resistance', '#/settings', '#/trading-journal']) {
      go(hash);
      expect(within(nav()).getByRole('link', { name: /TLUXE\s*TRADING/ })).toBeInTheDocument();
      expect(within(nav()).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
      expect(within(nav()).getByRole('button', { name: 'Trading Strategy' })).toBeInTheDocument();
    }
  });

  it('highlights the active page', () => {
    renderWithServices(<App />);
    expect(within(nav()).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    go('#/engines/support-resistance');
    expect(within(nav()).getByRole('link', { name: 'Support & Resistance' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav()).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('Trading Strategy expands/collapses; only Support & Resistance is enabled', () => {
    renderWithServices(<App />);
    const head = within(nav()).getByRole('button', { name: 'Trading Strategy' });
    expect(head).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav()).getByRole('link', { name: 'Support & Resistance' })).toHaveAttribute('href', '#/engines/support-resistance');
    for (const s of ['Liquidity', 'Order Blocks', 'Sweep / Reversal']) {
      const item = within(nav()).getByTitle(`${s} — not built yet`);
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item.tagName).not.toBe('A');
    }
    fireEvent.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(within(nav()).queryByRole('link', { name: 'Support & Resistance' })).toBeNull();
    fireEvent.click(head);
    expect(within(nav()).getByRole('link', { name: 'Support & Resistance' })).toBeInTheDocument();
  });

  it('Dashboard → S&R → Dashboard → S&R reuses the same services: no re-subscribe, no reconnect, instrument kept', () => {
    const mt5 = new ManualPriceProvider('mt5');
    const connect = vi.spyOn(mt5, 'connect');
    const { services } = renderWithServices(<App />, { price: [mt5] }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'XAUUSD' }) });
    act(() => mt5.sink.connection('XAUUSD', 'LIVE'));
    const subscribes = mt5.subscribed.length;
    const header = screen.getByLabelText('Market bar');

    for (let i = 0; i < 2; i++) {
      go('#/engines/support-resistance');
      expect(document.querySelector('.srgrid')).not.toBeNull();
      go('#/');
      expect(document.querySelector('.dash')).not.toBeNull();
    }
    go('#/engines/support-resistance');

    expect(screen.getByLabelText('Market bar')).toBe(header); // header never re-mounted
    expect(mt5.subscribed).toHaveLength(subscribes);
    expect(mt5.unsubscribe).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1); // connected once at start-up, never by navigation
    expect(services.instruments.store.getState().activeId).toBe('XAUUSD');
    expect(services.market.store('XAUUSD').getState().connection).toBe('LIVE');
  });

  it('drawer opens from the header menu button and closes on navigation', () => {
    renderWithServices(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(nav()).toHaveClass('is-open');
    fireEvent.click(within(nav()).getByRole('link', { name: 'Support & Resistance' }));
    expect(nav()).not.toHaveClass('is-open');
  });
});
