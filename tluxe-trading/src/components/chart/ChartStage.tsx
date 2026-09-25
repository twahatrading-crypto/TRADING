import { Maximize2, Minus, Plus, Undo2 } from 'lucide-react';
import { useEffect, type ReactNode, type RefObject } from 'react';
import { isResetShortcut } from './chartNav';

/** The presentation-only view API every strategy chart exposes (implemented by ChartController). */
export interface ChartNavigable {
  zoomIn(): void;
  zoomOut(): void;
  resetView(): void;
  fitView(): void;
}

/**
 * The single, shared navigation bar for strategy charts. It only changes the
 * VIEW (bar spacing, scroll position, price autoscale) — never data, engines,
 * levels, signals or alerts.
 */
export function ChartNavControls({ controller }: { controller: ChartNavigable | null }) {
  // One window listener per mounted chart, removed on unmount / HMR re-render.
  useEffect(() => {
    if (!controller) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isResetShortcut(e)) return;
      e.preventDefault();
      controller.resetView();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller]);

  const off = !controller;
  return (
    <div className="chartnav" role="toolbar" aria-label="Chart navigation" data-testid="chart-nav">
      <button type="button" className="chartnav__btn" onClick={() => controller?.zoomOut()} disabled={off} aria-label="Zoom out" title="Zoom out (or scroll the mouse wheel)">
        <Minus size={14} />
      </button>
      <button type="button" className="chartnav__btn" onClick={() => controller?.zoomIn()} disabled={off} aria-label="Zoom in" title="Zoom in (or scroll the mouse wheel)">
        <Plus size={14} />
      </button>
      <button type="button" className="chartnav__btn" onClick={() => controller?.fitView()} disabled={off} aria-label="Fit all bars and auto scale price" title="Fit / Auto scale">
        <Maximize2 size={13} />
      </button>
      <button type="button" className="chartnav__reset" onClick={() => controller?.resetView()} disabled={off} aria-label="Reset chart view (Alt + R)" title="Reset chart view (Alt + R)">
        <Undo2 size={13} aria-hidden="true" /> <span>Reset chart view</span> <kbd>Alt + R</kbd>
      </button>
    </div>
  );
}

/**
 * The chart area shared by every strategy chart: the lightweight-charts canvas,
 * the navigation controls (shown once bars exist) and the empty state (children,
 * shown when there are no bars). New strategy charts must use this component.
 */
export function ChartStage({ containerRef, controller, hasBars, children }: { containerRef: RefObject<HTMLDivElement | null>; controller: ChartNavigable | null; hasBars: boolean; children?: ReactNode }) {
  return (
    <div className="srchart__stage">
      <div ref={containerRef} className="chart-canvas" hidden={!hasBars} />
      {hasBars && <ChartNavControls controller={controller} />}
      {!hasBars && children}
    </div>
  );
}
