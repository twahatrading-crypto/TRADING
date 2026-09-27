import { Cloud, LogOut } from 'lucide-react';
import { COMPONENT_LABELS, logout } from '../../services/cloud/cloudApi';
import { healthLabel, healthTone } from './cloudHealth';
import type { StreamState } from '../../services/cloud/CloudStream';
import { useStore } from '../../store/createStore';
import type { StatusTone } from '../../types/status';
import { Panel } from '../ui/Panel';
import { StatusPill } from '../ui/StatusPill';
import { useCloudRuntime } from './cloudContext';
import './cloud.css';

const ORDER = ['frontend', 'api', 'postgres', 'ai', 'openai', 'databento', 'news', 'mt5Bridge', 'mt5Feed', 'websocket'];

const STREAM_TONE: Record<StreamState, StatusTone> = { IDLE: 'off', CONNECTING: 'warn', LIVE: 'ok', STALE: 'warn', RECONNECTING: 'warn', STOPPED: 'off' };

/**
 * Cloud deployment: every connection is configured server-side (Railway variables / the Windows VPS link), so this
 * panel only REPORTS the gateway's unified health. No URL, token or key can be entered in the browser.
 */
export function CloudStatusPanel() {
  const rt = useCloudRuntime();
  if (!rt) return null;
  return <CloudStatusInner rt={rt} />;
}

function CloudStatusInner({ rt }: { rt: NonNullable<ReturnType<typeof useCloudRuntime>> }) {
  const status = useStore(rt.store, (s) => s.status);
  const statusAt = useStore(rt.store, (s) => s.statusAt);
  const stream = useStore(rt.stream.store, (s) => s.state);
  const signOut = async () => {
    await logout();
    window.location.reload();
  };
  return (
    <Panel id="cloud-status" title="Cloud connections" icon={<Cloud size={15} />} subtitle="Managed on the server — credentials never reach this browser">
      <div className="cloud-status" data-testid="cloud-status">
        <div className="cloud-status__row">
          <span>Live stream</span>
          <StatusPill tone={STREAM_TONE[stream]} label={stream} compact />
        </div>
        {ORDER.map((k) => {
          const c = status?.components?.[k];
          return (
            <div className="cloud-status__row" key={k} title={c?.detail ?? 'No status from the gateway yet.'}>
              <span>{COMPONENT_LABELS[k] ?? k}</span>
              <StatusPill tone={healthTone(c)} label={healthLabel(c)} compact />
              <small className="cloud-status__detail">{c?.detail ?? 'No status from the gateway yet.'}</small>
            </div>
          );
        })}
        <p className="cloud-status__note">
          {statusAt ? `Status confirmed ${new Date(statusAt).toISOString().slice(11, 19)} UTC.` : 'Waiting for the gateway status.'} LIVE requires fresh market data while the market is open —
          never just a running process.
        </p>
        <button type="button" className="sbtn cloud-status__signout" onClick={() => void signOut()}>
          <LogOut size={13} /> Sign out
        </button>
      </div>
    </Panel>
  );
}
