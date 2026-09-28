import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRuntimeContext } from '../../components/cloud/cloudContext';
import { CloudSignIn } from '../../components/cloud/CloudSignIn';
import { healthLabel, healthTone } from '../../components/cloud/cloudHealth';
import { CloudStatusPanel } from '../../components/cloud/CloudStatusPanel';
import { createStore } from '../../store/createStore';
import type { AlertState, HLEAlertRecord } from '../highLowEngine/alerts';
import { HEALTH_STATES, login, sessionStatus, type CloudStatus } from './cloudApi';
import { CloudStream, type CloudStreamOptions } from './CloudStream';
import { startCloudRuntime, type CloudRuntime } from './cloudRuntime';

/** TEST gateway: records requests, answers from a script. No network. */
function gateway(routes: Record<string, (init?: RequestInit) => { status: number; body?: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = routes[`${init?.method ?? 'GET'} ${url}`]?.(init) ?? { status: 404, body: { error: { code: 'NOT_FOUND' } } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetchImpl, calls };
}

const STATUS: CloudStatus = {
  timeMs: 1,
  components: {
    api: { state: 'LIVE', detail: 'Gateway serving.' },
    databento: { state: 'NOT CONNECTED', detail: 'Databento service not configured.' },
    mt5Feed: { state: 'STALE', detail: 'Market closed.', expected: true, marketOpen: false },
  },
};

/** TEST transport: captures the runtime's stream callbacks; the socket never connects anywhere. */
function streamWithHooks() {
  const h: { opts: CloudStreamOptions | null; makeStream: (o: CloudStreamOptions) => CloudStream } = {
    opts: null,
    makeStream: (o) => {
      h.opts = o;
      return new CloudStream({ ...o, socket: () => ({ onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} }) });
    },
  };
  return h;
}

function fakeServices() {
  const alerts = createStore<AlertState>({ alarmOn: true, sound: 'off', desktop: 'unsupported', email: 'not-configured', last: null, history: [] });
  const pollOnce = vi.fn(async () => {});
  return { services: { newsBridge: { isRunning: () => true, pollOnce }, highLow: { alerts: { store: alerts } } } as never, alerts, pollOnce };
}

const alert = (key: string): HLEAlertRecord => ({
  kind: 'entry-ready',
  alertKey: key,
  setupId: 's1',
  instrumentId: 'XAUUSD' as never,
  side: 'BUY',
  at: 1_700_000_000_000,
  readyAt: 1_700_000_000_000,
  late: false,
  discovery: null,
  entry: null,
  stop: null,
  tp1: null,
  channels: [],
});

let rt: CloudRuntime | null = null;
afterEach(() => {
  rt?.stop();
  rt = null;
});

describe('cloud session API - the browser never holds a credential', () => {
  it('login sends the password once, same-origin, and stores nothing in the browser', async () => {
    const gw = gateway({ 'POST /api/auth/login': () => ({ status: 200, body: { ok: true } }) });
    const set = vi.spyOn(Storage.prototype, 'setItem');
    await login('owner-password', gw.fetchImpl);
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0]!.init?.credentials).toBe('same-origin');
    expect(gw.calls[0]!.url).toBe('/api/auth/login');
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
  });

  it('session state: 200 authenticated, 401 anonymous, network error unreachable', async () => {
    expect(await sessionStatus(gateway({ 'GET /api/auth/me': () => ({ status: 200, body: {} }) }).fetchImpl)).toBe('authenticated');
    expect(await sessionStatus(gateway({ 'GET /api/auth/me': () => ({ status: 401 }) }).fetchImpl)).toBe('anonymous');
    expect(await sessionStatus(async () => Promise.reject(new Error('down')))).toBe('unreachable');
  });

  it('sign-in form shows the gateway error and signs in on success', async () => {
    let ok = false;
    const gw = gateway({ 'POST /api/auth/login': () => (ok ? { status: 200, body: { ok: true } } : { status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: 'Wrong password.' } } }) });
    const onSignedIn = vi.fn();
    render(<CloudSignIn onSignedIn={onSignedIn} fetchImpl={gw.fetchImpl} />);
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password.');
    ok = true;
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
  });
});

describe('cloud runtime - status, news notifications, alert persistence, session expiry', () => {
  it('loads the authoritative status, then applies stream updates', async () => {
    const gw = gateway({ 'GET /api/status': () => ({ status: 200, body: STATUS }), 'GET /api/auth/me': () => ({ status: 200, body: {} }) });
    const { services } = fakeServices();
    const h = streamWithHooks();
    rt = startCloudRuntime(services, { fetchImpl: gw.fetchImpl, makeStream: h.makeStream });
    await waitFor(() => expect(rt!.store.getState().status?.components.api?.state).toBe('LIVE'));
    expect(gw.calls.every((c) => c.init?.credentials === 'same-origin')).toBe(true);
  });

  it('stream updates replace the status; a news notification triggers one incremental fetch (no fake items)', async () => {
    const { services, pollOnce } = fakeServices();
    const gw = gateway({ 'GET /api/status': () => ({ status: 200, body: STATUS }) });
    const h = streamWithHooks();
    rt = startCloudRuntime(services, { fetchImpl: gw.fetchImpl, makeStream: h.makeStream });
    await waitFor(() => expect(rt!.store.getState().status).not.toBeNull());
    h.opts!.onMessage!({ type: 'status', seq: 2, ts: 0, data: { timeMs: 2, components: { ...STATUS.components, api: { state: 'ERROR', detail: 'x' } } } });
    expect(rt.store.getState().status?.components.api?.state).toBe('ERROR');
    expect(pollOnce).not.toHaveBeenCalled();
    h.opts!.onMessage!({ type: 'news', seq: 3, ts: 0, data: { feed: 'calendar', seq: 42 } });
    expect(pollOnce).toHaveBeenCalledTimes(1);
    // A reconnect / sequence gap refetches the authoritative status.
    const before = gw.calls.filter((c) => c.url === '/api/status').length;
    h.opts!.onResync!('gap');
    await waitFor(() => expect(gw.calls.filter((c) => c.url === '/api/status').length).toBe(before + 1));
  });

  it('persists each NEW High / Low alert exactly once (deduplicated by key)', async () => {
    const gw = gateway({ 'GET /api/status': () => ({ status: 200, body: STATUS }), 'POST /api/alerts': () => ({ status: 200, body: { ok: true, created: true } }) });
    const { services, alerts } = fakeServices();
    rt = startCloudRuntime(services, { fetchImpl: gw.fetchImpl, makeStream: streamWithHooks().makeStream });
    act(() => alerts.setState({ last: alert('k1') }));
    act(() => alerts.setState({ last: alert('k1'), alarmOn: false }));
    act(() => alerts.setState({ last: alert('k2') }));
    await waitFor(() => expect(gw.calls.filter((c) => c.url === '/api/alerts')).toHaveLength(2));
    const bodies = gw.calls.filter((c) => c.url === '/api/alerts').map((c) => JSON.parse(String(c.init?.body)));
    expect(bodies.map((b) => b.alertKey)).toEqual(['k1', 'k2']);
    expect(bodies[0]).toMatchObject({ source: 'high-low-engine', type: 'entry-ready', instrumentId: 'XAUUSD', occurredAt: 1_700_000_000_000 });
  });

  it('an expired session is detected and returns the app to sign-in', async () => {
    vi.useFakeTimers();
    try {
      const gw = gateway({ 'GET /api/status': () => ({ status: 401 }), 'GET /api/auth/me': () => ({ status: 401 }) });
      const expired = vi.fn();
      rt = startCloudRuntime(fakeServices().services, { fetchImpl: gw.fetchImpl, makeStream: streamWithHooks().makeStream, sessionCheckMs: 1000, onSessionExpired: expired });
      await vi.advanceTimersByTimeAsync(1000);
      expect(expired).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(expired).toHaveBeenCalledTimes(1);
      expect(rt.store.getState().session).toBe('expired');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cloud status panel - truthful states only', () => {
  it('maps the six gateway states; a market-closed STALE is not an error and nothing is LIVE without data', () => {
    expect(HEALTH_STATES).toEqual(['LIVE', 'DELAYED', 'STALE', 'NOT CONNECTED', 'UNAVAILABLE', 'ERROR']);
    expect(healthTone({ state: 'LIVE', detail: null })).toBe('ok');
    expect(healthTone({ state: 'STALE', detail: null, expected: true })).toBe('off');
    expect(healthLabel({ state: 'STALE', detail: null, expected: true })).toBe('MARKET CLOSED');
    expect(healthTone({ state: 'STALE', detail: null })).toBe('warn');
    expect(healthTone({ state: 'ERROR', detail: null })).toBe('bad');
    expect(healthLabel(undefined)).toBe('UNAVAILABLE');
  });

  it('renders every component; components the gateway has not reported show UNAVAILABLE, never LIVE', async () => {
    const gw = gateway({ 'GET /api/status': () => ({ status: 200, body: STATUS }) });
    rt = startCloudRuntime(fakeServices().services, { fetchImpl: gw.fetchImpl, makeStream: streamWithHooks().makeStream });
    render(
      <CloudRuntimeContext.Provider value={rt}>
        <CloudStatusPanel />
      </CloudRuntimeContext.Provider>,
    );
    const panel = await screen.findByTestId('cloud-status');
    await waitFor(() => expect(panel).toHaveTextContent('Gateway serving.'));
    expect(panel).toHaveTextContent('MARKET CLOSED');
    expect(panel).toHaveTextContent('NOT CONNECTED');
    expect(panel.textContent!.match(/LIVE/g)?.length ?? 0).toBe(1 + 1); // the API row + the note text "LIVE requires ..."
    expect(panel).toHaveTextContent('UNAVAILABLE'); // e.g. PostgreSQL / OpenAI not reported in this status
  });
});

describe('gateway runtime config - public market-data mode', () => {
  it('only an explicit public market-data answer skips sign-in; anything else fails closed', async () => {
    const { fetchRuntimeConfig } = await import('./cloudApi');
    const cfg = (body: unknown, status = 200) => fetchRuntimeConfig(async () => new Response(JSON.stringify(body), { status }));
    expect(await cfg({ authRequired: false, publicMarketData: true })).toEqual({ authRequired: false, publicMarketData: true });
    expect(await cfg({ authRequired: true, publicMarketData: false })).toEqual({ authRequired: true, publicMarketData: false });
    expect(await cfg({ publicMarketData: true })).toEqual({ authRequired: true, publicMarketData: false }); // inconsistent -> closed
    expect(await cfg({}, 500)).toEqual({ authRequired: true, publicMarketData: false });
    expect(await fetchRuntimeConfig(async () => Promise.reject(new Error('down')))).toEqual({ authRequired: true, publicMarketData: false });
  });
});
