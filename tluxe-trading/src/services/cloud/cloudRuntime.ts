import { createStore, type Store } from '../../store/createStore';
import type { Services } from '../registry';
import { fetchStatus, persistAlert, reportActivity, sessionStatus, type CloudStatus, type FetchLike } from './cloudApi';
import { CloudStream, streamUrl, type CloudStreamOptions, type StreamMessage } from './CloudStream';

export interface CloudRuntimeState {
  status: CloudStatus | null;
  /** When the status was last confirmed by the gateway (ms, browser clock). */
  statusAt: number | null;
  session: 'authenticated' | 'expired';
}

export interface CloudRuntime {
  store: Store<CloudRuntimeState>;
  stream: CloudStream;
  stop(): void;
}

export interface CloudRuntimeDeps {
  fetchImpl?: FetchLike;
  /** Builds the transport (tests inject a scripted one). */
  makeStream?: (o: CloudStreamOptions) => CloudStream;
  now?: () => number;
  /** Session re-check interval (the gateway rotates sessions; an expired one returns the app to the sign-in screen). */
  sessionCheckMs?: number;
  onSessionExpired?: () => void;
  /** Where owner input is observed for the inactivity timeout (default: window / document). */
  activityTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  /** How often real activity is reported to the gateway (default 60 s; nothing is sent while idle). */
  activityEveryMs?: number;
}

/**
 * Cloud-only glue between the gateway and the (unchanged) services:
 *  - unified component status from /api/stream (authoritative refetch on connect / seq gap)
 *  - news notifications trigger an immediate incremental fetch instead of waiting for the next poll
 *  - High / Low engine alerts are persisted server-side (deduplicated by alert key)
 *  - an expired session returns the app to the sign-in screen
 * It never changes provider settings and never generates data.
 */
export function startCloudRuntime(services: Pick<Services, 'newsBridge' | 'highLow'>, deps: CloudRuntimeDeps = {}): CloudRuntime {
  const fetchImpl = deps.fetchImpl;
  const now = deps.now ?? Date.now;
  const store = createStore<CloudRuntimeState>({ status: null, statusAt: null, session: 'authenticated' });
  const refresh = async () => {
    const st = await fetchStatus(fetchImpl);
    if (st) store.setState({ status: st, statusAt: now() });
  };
  const onMessage = (m: StreamMessage) => {
    if (m.type === 'status' && m.data && typeof m.data === 'object') {
      store.setState({ status: { ...(store.getState().status ?? {}), ...(m.data as CloudStatus) }, statusAt: now() });
    } else if (m.type === 'news' && services.newsBridge?.isRunning()) {
      void services.newsBridge.pollOnce();
    }
  };
  const checkSession = async () => {
    const s = await sessionStatus(fetchImpl);
    if (s === 'anonymous' && store.getState().session !== 'expired') {
      store.setState({ session: 'expired' });
      deps.onSessionExpired?.();
    }
  };
  const stream = (deps.makeStream ?? ((o) => new CloudStream(o)))({
    url: streamUrl(window.location),
    onMessage,
    onResync: () => void refresh(),
    onRejected: () => void checkSession(),
  });
  const stopStream = stream.start();
  void refresh();

  // Persist new High / Low engine alerts (the local alert history and alarm stay exactly as they are).
  let lastKey = services.highLow.alerts.store.getState().last?.alertKey ?? null;
  const stopAlerts = services.highLow.alerts.store.subscribe(() => {
    const a = services.highLow.alerts.store.getState().last;
    if (!a || a.alertKey === lastKey) return;
    lastKey = a.alertKey;
    void persistAlert(
      { alertKey: a.alertKey, source: 'high-low-engine', type: a.kind, title: `${a.instrumentId} ${a.side} ${a.kind}`, eventKey: a.setupId, instrumentId: a.instrumentId, occurredAt: Math.round(a.at) },
      fetchImpl,
    );
  });

  const sessionTimer = setInterval(() => void checkSession(), deps.sessionCheckMs ?? 60_000);

  // 2 h inactivity timeout: only REAL owner input counts. Background polling and the stream never report activity,
  // so an unattended tab signs itself out; at most one tiny POST per interval while the owner is active.
  const target = deps.activityTarget !== undefined ? deps.activityTarget : typeof window !== 'undefined' ? window : null;
  let active = false;
  const markActive = () => {
    active = true;
  };
  const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'] as const;
  for (const e of ACTIVITY_EVENTS) target?.addEventListener(e, markActive, { passive: true } as AddEventListenerOptions);
  const activityTimer = setInterval(() => {
    if (!active || store.getState().session === 'expired') return;
    active = false;
    void reportActivity(fetchImpl);
  }, deps.activityEveryMs ?? 60_000);
  return {
    store,
    stream,
    stop() {
      stopStream();
      stopAlerts();
      clearInterval(sessionTimer);
      clearInterval(activityTimer);
      for (const e of ACTIVITY_EVENTS) target?.removeEventListener(e, markActive);
    },
  };
}
