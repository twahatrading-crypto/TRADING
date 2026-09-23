import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithServices } from '../../test/renderWithServices';
import { App } from '../../app/App';
import { Dashboard } from './Dashboard';

describe('Dashboard', () => {
  it('renders every Phase 1 section', () => {
    renderWithServices(<Dashboard />);
    for (const name of ['World Clock', 'Trading Sessions', 'GC Price Chart', 'Economic Calendar', 'Latest Market News', 'System Status', 'TLUXE AI']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Trading by TLUXE');
    const modules = screen.getByRole('navigation', { name: 'Dashboard modules' });
    for (const m of ['Market Overview', 'Economic Calendar', 'Trading Journal', 'Risk Management', 'Engines', 'Settings']) {
      expect(modules).toHaveTextContent(m);
    }
  });

  it('places each panel in a named grid area so layouts can reflow without markup changes', () => {
    const { container } = renderWithServices(<Dashboard />);
    for (const area of ['clocks', 'sessions', 'chart', 'modules', 'calendar', 'news', 'status', 'ai']) {
      expect(container.querySelector(`.area-${area}`)).not.toBeNull();
    }
  });

  it('provides a mobile section switcher that targets real sections', () => {
    const { container } = renderWithServices(<Dashboard />);
    const nav = screen.getByRole('navigation', { name: 'Jump to section' });
    for (const a of nav.querySelectorAll('a')) {
      expect(container.querySelector(a.getAttribute('href')!)).not.toBeNull();
    }
  });

  it('shows no BUY/SELL signal language anywhere', () => {
    const { container } = renderWithServices(<Dashboard />);
    expect(container.textContent).not.toMatch(/\b(BUY|SELL)\b/);
  });
});

describe('module routing', () => {
  it('opens a module placeholder page from its hash route', () => {
    window.location.hash = '#/risk-management';
    renderWithServices(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'Risk Management' })).toBeInTheDocument();
    expect(screen.getByText('MODULE NOT YET BUILT')).toBeInTheDocument();
    window.location.hash = '';
  });
});
