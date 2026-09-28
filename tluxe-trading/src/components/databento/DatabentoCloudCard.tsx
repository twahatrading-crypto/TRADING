import { Database } from 'lucide-react';
import { useServices } from '../../app/servicesContext';
import { useNow } from '../../store/clock';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import { UNKNOWN } from '../../utils/format';
import { Panel } from '../ui/Panel';
import { StatusPill } from '../ui/StatusPill';

const utc = (ms: number | null | undefined) => (ms == null ? UNKNOWN : `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`);
const age = (ms: number | null | undefined, now: number) => (ms == null ? UNKNOWN : `${Math.max(0, Math.round((now - ms) / 1000))}s ago`);

/**
 * Cloud deployment: Databento runs server-side next to the TLUXE gateway (GLBX.MDP3). Read-only diagnostics of what
 * the gateway ACTUALLY receives for the canonical instruments GC / SI - nothing to configure in the browser, and
 * depth is shown as NOT ENTITLED instead of being approximated.
 */
export function DatabentoCloudCard() {
  const { databento } = useServices();
  const st = useOptionalStore(databento?.state, (s) => s, null);
  const now = useNow('second');
  const h = st?.health ?? null;
  const connected = st?.bridge === 'ONLINE' && h?.sessions.tape.state === 'CONNECTED';
  const ents = h?.schemas?.entitlements ?? {};
  const requested = h?.schemas?.requested?.tape ?? [];
  const depthEntitled = ents['mbo']?.state !== 'NOT_ENTITLED' && h?.plan === 'mbo';
  return (
    <Panel id="databento-cloud" title="DATABENTO" icon={<Database size={15} />} subtitle="Cloud · GLBX.MDP3 · COMEX futures GC / SI (never used for XAUUSD / XAGUSD)">
      <dl className="kv" data-testid="databento-cloud">
        <div className="kv__row">
          <dt>Status</dt>
          <dd>
            <StatusPill tone={connected ? 'ok' : 'bad'} label={connected ? 'CONNECTED' : 'DISCONNECTED'} compact />
            {st?.error && !connected ? <span className="is-unknown"> {st.error}</span> : null}
          </dd>
        </div>
        <div className="kv__row"><dt>Dataset</dt><dd>{h?.dataset ?? 'GLBX.MDP3'}</dd></div>
        <div className="kv__row"><dt>Schemas</dt><dd>{requested.length ? requested.join(', ') : UNKNOWN}</dd></div>
        {(['GC', 'SI'] as const).map((root) => {
          const i = h?.instruments[root];
          const last = i?.lastEventNs != null ? Math.floor(i.lastEventNs / 1_000_000) : null;
          const vol = i ? Object.values(i.tape.volume ?? {}).reduce((a, b) => a + (Number(b) || 0), 0) : null;
          return (
            <div className="kv__row" key={root} data-testid={`databento-${root}`}>
              <dt>{root}</dt>
              <dd>
                {i ? (
                  <>
                    <strong>{i.contract ?? 'resolving contract…'}</strong> ({i.subscribed}) · {i.status} · Trades {i.capabilities?.trades ?? UNKNOWN} · OHLCV{' '}
                    {i.capabilities?.ohlcv ?? UNKNOWN} · latest event {utc(last)} ({age(last, now)}) · volume {vol ?? UNKNOWN} · bars {i.candles.bars}
                  </>
                ) : (
                  UNKNOWN
                )}
              </dd>
            </div>
          );
        })}
        <div className="kv__row">
          <dt>Entitlements</dt>
          <dd>{Object.keys(ents).length ? Object.entries(ents).map(([k, v]) => `${k}: ${v.state}`).join(' · ') : UNKNOWN}</dd>
        </div>
        <div className="kv__row" data-testid="databento-depth">
          <dt>Depth</dt>
          <dd>{depthEntitled ? 'MBO (entitled)' : 'DEPTH — NOT ENTITLED (MBO / MBP-10 not in this Databento plan; never approximated)'}</dd>
        </div>
      </dl>
    </Panel>
  );
}
