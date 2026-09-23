import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionsPanel } from './SessionsPanel';

describe('SessionsPanel at fixed instants', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('Tuesday 11:30Z (London DST): London + Globex open, NY upcoming, Asia closed', () => {
    vi.setSystemTime(new Date('2026-09-22T11:30:00Z'));
    render(<SessionsPanel />);
    expect(screen.getByTestId('session-status-london')).toHaveTextContent('Open');
    expect(screen.getByTestId('session-status-globex')).toHaveTextContent('Open');
    expect(screen.getByTestId('session-status-new-york')).toHaveTextContent('Upcoming');
    expect(screen.getByTestId('session-status-asia')).toHaveTextContent('Closed');
    expect(screen.getByText('Open: London, COMEX / Globex')).toBeInTheDocument();
  });

  it('counts down every second', () => {
    vi.setSystemTime(new Date('2026-09-22T11:30:00Z'));
    render(<SessionsPanel />);
    // New York opens 12:00Z → 30 minutes
    expect(screen.getAllByText('30m 00s').length).toBeGreaterThan(0);
    // The shared ticker fires just after each second boundary.
    act(() => vi.advanceTimersByTime(5_010));
    expect(screen.getAllByText('29m 55s').length).toBeGreaterThan(0);
  });

  it('Saturday: every session closed', () => {
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
    render(<SessionsPanel />);
    for (const id of ['asia', 'london', 'new-york', 'globex']) {
      expect(screen.getByTestId(`session-status-${id}`)).toHaveTextContent('Closed');
    }
    expect(screen.getByText('All sessions closed')).toBeInTheDocument();
  });
});
