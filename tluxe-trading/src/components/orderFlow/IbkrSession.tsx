import { BookOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStore } from '../../store/createStore';
import { ibkrBook, ibkrHealth, ibkrLabel } from '../../providers/ibkr/IbkrDepthProvider';
import { useIbkrRootState, visibleImbalance } from '../../providers/ibkr/ibkrView';
import { formatPrice } from '../../utils/format';
import { Panel, Unavailable } from './OrderFlowPanels';

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'muted'> = {
  LIVE: 'ok',
  STALE: 'warn',
  CONNECTING: 'warn',
  RECONNECTING: 'warn',
  AUTH_REQUIRED: 'bad',
  OFFLINE: 'bad',
  NOT_ENTITLED: 'bad',
  UNSUPPORTED: 'bad',
  CONTRACT_UNRESOLVED: 'bad',
  CONTRACT_MISMATCH: 'bad',
  NOT_CONFIGURED: 'muted',
  UNKNOWN: 'muted',
};

const t = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleTimeString('en-GB', { hour12: false }) : '—');


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
        IBKR <b>{r?.contract ? `${r.contract.localSymbol}${r.contract.conId ? ` · ${r.contract.conId}` : ''}` : '—'}</b> / Databento <b>{databentoContract ?? '—'}</b>
        {mismatch && <em className="ofibkr__auth"> CONTRACT MISMATCH — depth not used</em>}
      </span>
      <span className="ofdim">{r?.bidLevels ?? 0}×{r?.askLevels ?? 0} levels · PRICE_LEVEL (aggregated levels) · MBO false · bridge receive time</span>
    </div>
  );
}

/** Seconds since `ms`, re-rendered every second (freshness of the visible book). */
function useAge(ms: number | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return ms ? Math.max(0, (now - ms) / 1000) : null;
}


/** COB for the IBKR COMEX price-level depth: the rows exactly as IBKR published them (level, price, size, market maker
 *  when supplied), with source and freshness. Aggregated levels - no order counts, no order ids, never MBO. */
export function IbkrDomPanel({ root, d, className }: { root: string; d: number; className?: string }) {
  const book = useStore(ibkrBook, (s) => s[root] ?? null);
  const state = useIbkrRootState(root);
  const detail = useStore(ibkrHealth, (s) => s.status?.roots[root]?.detail ?? null);
  const age = useAge(book?.lastUpdateMs);
  const live = !!book && state === 'LIVE' && (book.bids.length > 0 || book.asks.length > 0);
  const n = Math.max(book?.bids.length ?? 0, book?.asks.length ?? 0);
  const im = live ? visibleImbalance(book.bids, book.asks) : null;
  const maxB = Math.max(1, ...(book?.bids ?? []).map((r) => r.size));
  const maxA = Math.max(1, ...(book?.asks ?? []).map((r) => r.size));
  return (
    <Panel title="COB (Order Book) · IBKR" icon={<BookOpen size={15} aria-hidden="true" />} className={`ofbook ofdom ${className ?? ''}`} testId="of-book"
      right={<span className={`ofpill ofpill--${TONE[state] ?? 'muted'}`}><i aria-hidden="true" />{ibkrLabel(state)}</span>}>
      {!live ? (
        <Unavailable title="DEPTH UNAVAILABLE" detail={<><b>IBKR {ibkrLabel(state)}</b><br />{detail ?? 'No current IBKR price-level book.'} Old depth is never shown as live; sizes are never derived from trades.</>} />
      ) : (
        <>
          <p className="ofdom__src" data-testid="ibkr-dom-source">
            Interactive Brokers · <b>PRICE_LEVEL</b> · MBO <b>false</b> · updated <b className="num">{t(book.lastUpdateMs)}</b> ({age === null ? '—' : `${age.toFixed(0)} s ago`}, bridge receive time — not an exchange timestamp)
          </p>
          <table className="ofbook__t" data-testid="ibkr-dom">
            <thead>
              <tr><th>Lvl</th><th className="num-col">Bid Size</th><th className="num-col">Bid</th><th className="num-col">Ask</th><th className="num-col">Ask Size</th></tr>
            </thead>
            <tbody>
              {Array.from({ length: n }, (_, i) => {
                const b = book.bids[i];
                const a = book.asks[i];
                return (
                  <tr key={i} className={i === 0 ? 'is-best' : ''}>
                    <td className="num ofdim">{b?.position ?? a?.position ?? i}</td>
                    <td className="num ofbid" style={{ ['--w' as string]: `${b ? (100 * b.size) / maxB : 0}%` }} title={b?.marketMaker ? `market maker ${b.marketMaker}` : undefined}>{b ? b.size.toLocaleString() : '—'}</td>
                    <td className="num ofbid-t">{b ? formatPrice(b.price, d) : '—'}</td>
                    <td className="num ofask-t">{a ? formatPrice(a.price, d) : '—'}</td>
                    <td className="num ofask" style={{ ['--w' as string]: `${a ? (100 * a.size) / maxA : 0}%` }} title={a?.marketMaker ? `market maker ${a.marketMaker}` : undefined}>{a ? a.size.toLocaleString() : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {im && (
            <div className="oftotals" data-testid="ibkr-imbalance">
              <span>Visible IBKR book, top {n} rows:</span>
              <span>Total bid <b className="num ofbid-t">{im.bid.toLocaleString()}</b></span>
              <span>Total ask <b className="num ofask-t">{im.ask.toLocaleString()}</b></span>
              <span>Bid/ask <b className="num">{im.ratio === null ? '—' : im.ratio.toFixed(2)}</b></span>
              <span>Imbalance <b className="num">{im.imbalance === null ? '—' : `${(im.imbalance * 100).toFixed(1)}%`}</b></span>
            </div>
          )}
          <p className="ofnote">Aggregated size per price level as published by IBKR (COMEX). Not order-by-order: no order counts, order ids or queue positions exist in this data.</p>
        </>
      )}
    </Panel>
  );
}
