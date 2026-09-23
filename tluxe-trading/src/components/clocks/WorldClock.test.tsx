import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorldClock } from './WorldClock';

describe('WorldClock', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('shows the five default cities with DST-correct times and offsets', () => {
    render(<WorldClock />);
    expect(screen.getByTestId('clock-time-denver')).toHaveTextContent('06:00AM');
    expect(screen.getByTestId('clock-time-new-york')).toHaveTextContent('08:00AM');
    expect(screen.getByTestId('clock-time-london')).toHaveTextContent('01:00PM');
    expect(screen.getByTestId('clock-time-yangon')).toHaveTextContent('06:30PM');
    expect(screen.getByTestId('clock-time-kuala-lumpur')).toHaveTextContent('08:00PM');
    expect(screen.getByText('UTC−6')).toBeInTheDocument();
    expect(screen.getByText('UTC+6:30')).toBeInTheDocument();
  });

  it('uses standard time in winter', () => {
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    render(<WorldClock />);
    expect(screen.getByTestId('clock-time-denver')).toHaveTextContent('05:00AM');
    expect(screen.getByTestId('clock-time-london')).toHaveTextContent('12:00PM');
  });

  it('adds, removes and persists locations', () => {
    const { unmount } = render(<WorldClock />);
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText('Add location'), { target: { value: 'tokyo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Denver' }));
    expect(screen.getByTestId('clock-time-tokyo')).toBeInTheDocument();
    expect(screen.queryByTestId('clock-time-denver')).not.toBeInTheDocument();
    unmount();
    render(<WorldClock />);
    expect(screen.getByTestId('clock-time-tokyo')).toBeInTheDocument();
    expect(screen.queryByTestId('clock-time-denver')).not.toBeInTheDocument();
  });

  it('falls back to defaults when stored config is corrupt or has an invalid zone', () => {
    localStorage.setItem('tluxe.clocks.v1', JSON.stringify([{ id: 'x', city: 'X', timeZone: 'Not/AZone' }]));
    render(<WorldClock />);
    expect(screen.getByTestId('clock-time-denver')).toBeInTheDocument();
  });
});
