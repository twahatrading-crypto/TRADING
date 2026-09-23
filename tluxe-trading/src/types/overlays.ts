/**
 * Chart overlay contracts — Phase 1 defines the shapes only.
 * No engine produces these yet; strategy computation must live outside React
 * and hand finished overlay data to the chart layer.
 */

export type OverlayKind =
  | 'liquidity'
  | 'support-resistance'
  | 'order-block'
  | 'fvg'
  | 'bos'
  | 'choch'
  | 'session-level'
  | 'entry'
  | 'stop-loss'
  | 'take-profit';

interface OverlayBase {
  id: string;
  kind: OverlayKind;
  label?: string;
}

/** Horizontal price level (S/R, session high/low, entry, SL, TP, liquidity pools). */
export interface PriceLevelOverlay extends OverlayBase {
  shape: 'level';
  price: number;
}

/** Time-bounded price zone (order blocks, FVG). Times are epoch seconds. */
export interface ZoneOverlay extends OverlayBase {
  shape: 'zone';
  from: number;
  to: number | null;
  top: number;
  bottom: number;
}

/** Point marker on a bar (BOS / CHOCH events). */
export interface MarkerOverlay extends OverlayBase {
  shape: 'marker';
  time: number;
  price: number;
  direction: 'up' | 'down';
}

export type ChartOverlay = PriceLevelOverlay | ZoneOverlay | MarkerOverlay;
