import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChartStage, type ChartNavigable } from './ChartStage';

const nav = () => ({ zoomIn: vi.fn<() => void>(), zoomOut: vi.fn<() => void>(), resetView: vi.fn<() => void>(), fitView: vi.fn<() => void>() });
const stage = (controller: ChartNavigable | null, hasBars = true) => <ChartStage containerRef={createRef<HTMLDivElement>()} controller={controller} hasBars={hasBars}><p>EMPTY</p></ChartStage>;
const altR = (target: Window | Element = window) => fireEvent.keyDown(target, { key: 'r', code: 'KeyR', altKey: true });
const keydownListeners = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => c[0] === 'keydown').length;

afterEach(() => vi.restoreAllMocks());

describe('ChartStage (shared strategy-chart navigation)', () => {
  it('Zoom in, Zoom out, Fit / Auto scale and Reset call the chart view API', () => {
    const c = nav();
    render(stage(c));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: /Fit all bars/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset chart view (Alt + R)' }));
    expect(c.zoomIn).toHaveBeenCalledTimes(1);
    expect(c.zoomOut).toHaveBeenCalledTimes(1);
    expect(c.fitView).toHaveBeenCalledTimes(1);
    expect(c.resetView).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('toolbar', { name: 'Chart navigation' })).toHaveTextContent('Reset chart view Alt + R');
  });

  it('Alt + R resets the view (and prevents the browser default); plain R or Ctrl+Alt+R does not', () => {
    const c = nav();
    render(stage(c));
    const ev = new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', altKey: true, cancelable: true });
    act(() => void window.dispatchEvent(ev));
    expect(c.resetView).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR' });
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR', altKey: true, ctrlKey: true });
    expect(c.resetView).toHaveBeenCalledTimes(1);
  });

  it('Alt + R is ignored while typing in an input', () => {
    const c = nav();
    render(<>{stage(c)}<input aria-label="field" /></>);
    altR(screen.getByLabelText('field'));
    expect(c.resetView).not.toHaveBeenCalled();
  });

  it('shows the empty state (no controls) without bars, and disables controls until the chart exists', () => {
    const { rerender } = render(stage(nav(), false));
    expect(screen.getByText('EMPTY')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-nav')).toBeNull();
    rerender(stage(null, true));
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    altR();
  });

  it('registers exactly one keyboard listener per chart and removes it on unmount / controller swap (HMR-safe)', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const a = nav();
    const b = nav();
    const { rerender, unmount } = render(stage(a));
    rerender(stage(a)); // re-render (e.g. HMR / new props) must not add another listener
    expect(keydownListeners(add)).toBe(1);
    rerender(stage(b)); // new controller (timeframe / instrument change)
    expect(keydownListeners(add)).toBe(2);
    expect(keydownListeners(remove)).toBe(1);
    altR();
    expect(a.resetView).not.toHaveBeenCalled();
    expect(b.resetView).toHaveBeenCalledTimes(1);
    unmount();
    expect(keydownListeners(remove)).toBe(2);
    altR();
    expect(b.resetView).toHaveBeenCalledTimes(1);
  });
});
