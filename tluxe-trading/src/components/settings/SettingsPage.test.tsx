import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { BridgeOfflineError } from '../../services/mt5/client';
import { sanitizeMt5Config } from '../../services/mt5/config';
import { Mt5Provider } from '../../services/mt5/Mt5Provider';
import { memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';

const offline = () => Promise.reject(new BridgeOfflineError());
const offlineClient = { health: offline, symbols: offline, quote: offline, rates: offline };

beforeEach(() => {
  window.location.hash = '#/settings';
});

describe('Settings → Data Providers', () => {
  it('without MT5 enabled: says so, shows Not Connected, and the token field is a password field', () => {
    renderWithServices(<App />);
    expect(screen.getByTestId('mt5-disabled')).toHaveTextContent('MT5 NOT ENABLED');
    expect(screen.getByTestId('feed-provider')).toHaveTextContent('Not Connected');
    expect(screen.getByLabelText('Access token')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Enable MT5 market data')).not.toBeChecked();
  });

  it('MT5 enabled but the bridge is down: MT5 BRIDGE OFFLINE everywhere, never live', async () => {
    const cfg = sanitizeMt5Config({ enabled: true, token: 'x'.repeat(32) });
    const mt5 = new Mt5Provider(cfg, { client: offlineClient, autoStart: false });
    renderWithServices(<App />, { price: [mt5] }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'XAUUSD' }) });
    await act(() => mt5.pollHealth());
    expect(screen.getByTestId('bridge-state')).toHaveTextContent('OFFLINE');
    expect(screen.getAllByText('MT5 BRIDGE OFFLINE').length).toBeGreaterThan(0);
    expect(screen.queryByText('MT5 · LIVE')).toBeNull();
    expect(screen.getByTestId('quote-unavailable')).toBeInTheDocument();
  });
});
