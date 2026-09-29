import { useStore } from '../../store/createStore';
import { ibkrHealth, ibkrLabel, type IbkrState } from '../../providers/ibkr/IbkrDepthProvider';

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'muted'> = {
  LIVE: 'ok',
  STALE: 'warn',
  CONNECTING: 'warn',
  RECONNECTING: 'warn',
  AUTH_REQUIRED: 'bad',
  OFFLINE: 'bad',
  NOT_ENTITLED: 'bad',
  CONTRACT_UNRESOLVED: 'bad',
  NOT_CONFIGURED: 'muted',
  UNKNOWN: 'muted',
};

const t = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleTimeString('en-GB', { hour12: false }) : '—');

/** IBKR state for one root as reported by the gateway (OFFLINE when the gateway cannot be reached). */
function useIbkrRootState(root: string): IbkrState {
  const h = useStore(ibkrHealth, (s) => s);
  if (!h.status) return h.fetchedAt ? 'OFFLINE' : 'CONNECTING';
  return (h.status.roots[root]?.state as IbkrState | undefined) ?? 'UNKNOWN';
}

/** DEPTH · IBKR <state> - the depth pill when the IBKR COMEX Level-2 provider is the depth source. */
export function IbkrDepthPill({ root }: { root: string }) {
  const st = useIbkrRootState(root);
  return (
    <span className={`ofpill ofpill--${TONE[st] ?? 'muted'}`} data-testid="of-depth-ibkr">
      <i aria-hidden="true" />
      DEPTH · IBKR {ibkrLabel(st)}
    </span>
  );
}

/** Visible IBKR session health (read-only; no account data is ever returned by the gateway). */
export function IbkrSessionStrip({ root, databentoContract }: { root: string; databentoContract: string | null }) {
  const h = useStore(ibkrHealth, (s) => s);
  const s = h.status;
  const r = s?.roots[root];
  const state = useIbkrRootState(root);
  const sess = s?.session;
  const authRequired = state === 'AUTH_REQUIRED' || sess?.authRequired === true;
  const authenticated = !!sess?.apiConnected && !authRequired;
  const mismatch = !!(r?.contract && databentoContract && r.contract.localSymbol !== databentoContract);
  return (
    <div className={`ofibkr ofibkr--${TONE[state] ?? 'muted'}`} role="status" data-testid="ibkr-session">
      <b>IBKR SESSION</b>
      <span className="ofibkr__state">{ibkrLabel(state)}</span>
      <span>Authenticated <b>{s ? (authenticated ? 'YES' : 'NO') : '—'}</b></span>
      {authRequired && <span className="ofibkr__auth">IBKR AUTH REQUIRED — log in to IB Gateway on the VPS; depth features are stopped</span>}
      <span>Last depth <b className="num">{t(r?.lastDepthMs)}</b></span>
      <span>Last heartbeat <b className="num">{t(sess?.lastIbHeartbeatMs)}</b></span>
      <span>Reconnects <b className="num">{sess?.reconnects ?? '—'}</b>{sess?.nextReconnectMs ? <> · next {t(sess.nextReconnectMs)}</> : null}</span>
      <span>
        IBKR <b>{r?.contract ? `${r.contract.localSymbol} · ${r.contract.conId}` : '—'}</b> / Databento <b>{databentoContract ?? '—'}</b>
        {mismatch && <em className="ofibkr__auth"> CONTRACT MISMATCH — depth not used</em>}
      </span>
      <span className="ofdim">{r?.bidLevels ?? 0}×{r?.askLevels ?? 0} levels · MBP (aggregated levels, not MBO) · VPS receive time</span>
    </div>
  );
}
