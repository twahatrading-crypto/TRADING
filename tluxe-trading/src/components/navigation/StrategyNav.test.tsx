import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { STRATEGY_NAV } from '../../config/navigation';
import { renderWithServices } from '../../test/renderWithServices';

vi.mock('lightweight-charts', () => ({}));
vi.mock('../chart/ChartController', () => ({ ChartController: class {} }));

const nav = () => screen.getByRole('navigation', { name: 'Main navigation' });
const go = async (hash: string) => {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  for (let i = 0; i < 4; i++) await act(async () => {});
};

const EXPECTED: [string, string | null, RegExp | null][] = [
  ['Support & Resistance', '/engines/support-resistance', null],
  ['Liquidity', '/engines/liquidity', null],
  ['Order Blocks', '/engines/order-blocks', null],
  ['High / Low Reversal', '/engines/high-low-reversal', null],
  ['High / Low Engine', '/engines/high-low-engine', null],
  ['SMC Analysis', '/engines/smc', /SMC Engine/],
  ['Liquidity Heatmap', '/engines/liquidity-heatmap', /Liquidity Heatmap/],
  ['Sweep / Reversal', null, null],
];

describe('Trading Strategy sidebar', () => {
  it('lists every strategy page once, in order, with the right route (Sweep / Reversal SOON)', () => {
    expect(STRATEGY_NAV.map((s) => [s.label, s.route])).toEqual(EXPECTED.map(([l, r]) => [l, r]));
    expect(new Set(STRATEGY_NAV.map((s) => s.route).filter(Boolean)).size).toBe(7);
  });

  it('each item opens its page, is highlighted as active, and the sidebar stays visible', async () => {
    window.location.hash = '#/';
    renderWithServices(<App />);
    for (const [label, route, heading] of EXPECTED) {
      if (!route) {
        const soon = within(nav()).getByTitle(`${label} — not built yet`);
        expect(soon).toHaveAttribute('aria-disabled', 'true');
        expect(within(nav()).queryByRole('link', { name: label })).toBeNull();
        continue;
      }
      const link = within(nav()).getByRole('link', { name: label });
      expect(link).toHaveAttribute('href', `#${route}`);
      await go(`#${route}`);
      expect(within(nav()).getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
      expect(within(nav()).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page')).toHaveLength(1);
      if (heading) expect(screen.getAllByRole('heading', { level: 1 }).some((h) => heading.test(h.textContent ?? ''))).toBe(true);
      expect(nav()).toBeInTheDocument();
    }
  });
});
