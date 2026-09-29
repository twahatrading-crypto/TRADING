import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarketBar } from '../../components/market/MarketBar';
import { renderWithServices } from '../../test/renderWithServices';
import { ibkrHealth, type IbkrStatus } from './IbkrDepthProvider';
import { level2Headline } from './ibkrView';

/* TEST DATA ONLY - the IBKR health store is set directly; no gateway / IBKR connection is involved. */

const status = (state: string, configured = true) =>
  ({ configured, link: { connected: false, stale: false, lastMessageMs: null, detail: null }, session: { state }, roots: { GC: { state }, SI: { state } }, depthType: '', timestampSource: '' }) as unknown as IbkrStatus;

afterEach(() => ibkrHealth.setState({ status: null, error: null, fetchedAt: null }));

describe('Level-2 depth status wording (IBKR price levels)', () => {
  it('names each IBKR state; never MBO', () => {
    expect(level2Headline('LIVE')).toBe('LEVEL-2 DEPTH LIVE');
    expect(level2Headline('STALE')).toBe('LEVEL-2 DEPTH STALE');
    expect(level2Headline('RECONNECTING')).toBe('LEVEL-2 DEPTH RECONNECTING');
    expect(level2Headline('OFFLINE')).toBe('LEVEL-2 DEPTH OFFLINE');
    expect(level2Headline('NOT_ENTITLED')).toBe('LEVEL-2 DEPTH NOT ENTITLED');
  });

  it('header shows IBKR DEPTH: <state> for GC when IBKR is configured', () => {
    renderWithServices(<MarketBar />);
    act(() => ibkrHealth.setState({ status: status('LIVE'), error: null, fetchedAt: 1 }));
    expect(screen.getByTestId('depth-status')).toHaveTextContent('IBKR DEPTH: LIVE');
    act(() => ibkrHealth.setState({ status: status('STALE'), error: null, fetchedAt: 2 }));
    expect(screen.getByTestId('depth-status')).toHaveTextContent('IBKR DEPTH: STALE');
  });

  it('no IBKR provider / IBKR not configured -> the generic depth status is kept', () => {
    renderWithServices(<MarketBar />);
    expect(screen.getByTestId('depth-status')).toHaveTextContent('Depth: Not connected');
    act(() => ibkrHealth.setState({ status: status('NOT_CONFIGURED', false), error: null, fetchedAt: 1 }));
    expect(screen.getByTestId('depth-status')).toHaveTextContent('Depth: Not connected');
  });
});
