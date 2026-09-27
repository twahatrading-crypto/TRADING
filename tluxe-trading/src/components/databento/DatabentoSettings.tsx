import { Database, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useServices } from '../../app/servicesContext';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import { loadDatabentoConfig, saveDatabentoConfig, type DatabentoConfig } from '../../providers/databento/config';
import { DB_ROOTS, type DbCapabilities } from '../../providers/databento/protocol';
import { Panel } from '../ui/Panel';
import { capLabel, planLabel } from './capabilities';
import './databento.css';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Settings → Databento bridge. Only the LOCAL bridge URL and the bridge token are configured in the browser.
 * The Databento API key is never entered here: it is DATABENTO_API_KEY in bridge/databento/.env (server-side).
 */
export function DatabentoSettingsPanel() {
  const [cfg, setCfg] = useState<DatabentoConfig>(() => loadDatabentoConfig(storage()));
  const { databento } = useServices();
  const feed = useOptionalStore(databento?.state, (st) => st, null);
  const health = feed?.health ?? null;
  // Plan as reported by the running bridge (never guessed); the Standard plan is the configured default.
  const plan = health?.plan ?? (cfg.mboDepth ? 'mbo' : 'standard');
  const caps: DbCapabilities | null = health ? (DB_ROOTS.map((r) => health.instruments[r]?.capabilities).find(Boolean) ?? null) : null;
  const yes = (on: boolean, label: string, extra = '') => (
    <span className={on ? 'dbset__cap--yes' : 'dbset__cap--no'}>
      {on ? '✓' : '✕'} {label}
      {extra}
    </span>
  );
  const standard = plan === 'standard';
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof DatabentoConfig>(k: K, v: DatabentoConfig[K]) => {
    setSaved(false);
    setCfg((c) => ({ ...c, [k]: v }));
  };
  const looksLikeKey = /^db-/i.test(cfg.token.trim());
  const tokenOk = cfg.token.length >= 32 && !looksLikeKey;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    saveDatabentoConfig(storage(), cfg);
    setSaved(true);
    window.location.reload();
  };
  return (
    <Panel id="databento-config" title="Databento Bridge" icon={<Database size={15} />} subtitle="Real CME Globex / COMEX data (GC, SI) — market data only">
      <form className="sform" onSubmit={submit} data-testid="databento-settings">
        <label className="sform__check">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Enable Databento (GLBX.MDP3) for GC and SI
        </label>
        <label className="sform__field">
          <span>Bridge URL</span>
          <input type="url" value={cfg.bridgeUrl} onChange={(e) => set('bridgeUrl', e.target.value)} spellCheck={false} />
        </label>
        <label className="sform__field">
          <span>Bridge token</span>
          <input type="password" autoComplete="off" value={cfg.token} onChange={(e) => set('token', e.target.value)} placeholder="TLUXE_DB_BRIDGE_TOKEN from bridge/databento/.env" spellCheck={false} />
        </label>
        <dl className="dbset__caps" data-testid="databento-plan">
          <dt>Plan mode</dt>
          <dd>{planLabel(plan)}{health?.plan ? '' : ' (bridge not reporting yet)'}</dd>
          <dt>Dataset</dt>
          <dd>{health?.dataset ?? 'GLBX.MDP3'}</dd>
          <dt>Capabilities</dt>
          <dd>
            {yes(true, 'Trades')} {yes(true, 'OHLCV')} {yes(true, 'Volume', ' when supplied')} {yes(!standard, 'MBO')} {yes(false, 'MBP-10')}
          </dd>
          {caps && (
            <>
              <dt>Live status</dt>
              <dd>
                Trades {capLabel(caps.trades)} · OHLCV {capLabel(caps.ohlcv)} · Volume {capLabel(caps.volume)} · Depth {capLabel(caps.depth)}
              </dd>
            </>
          )}
          <dt>Level-2 provider</dt>
          <dd>{caps?.level2Provider === 'DATABENTO_MBO' ? 'Databento MBO' : 'Not Connected'}{standard ? ' — Databento Standard does not include real-time MBO/MBP-10 (IBKR / T4 / other depth provider required)' : ''}</dd>
        </dl>
        <label className="sform__check">
          <input type="checkbox" checked={cfg.mboDepth} onChange={(e) => set('mboDepth', e.target.checked)} />
          My Databento plan includes real-time MBO — use Databento as the Level-2 depth source (bridge TLUXE_DB_PLAN=mbo). Leave off for Standard.
        </label>
        {looksLikeKey && <p className="sform__warn">That looks like a Databento API key. Never enter it in the browser — it belongs only in bridge/databento/.env as DATABENTO_API_KEY.</p>}
        {cfg.token && !looksLikeKey && !tokenOk && <p className="sform__warn">The bridge token is at least 32 characters.</p>}
        <p className="sform__note">
          <ShieldCheck size={13} /> Your Databento API key stays on the bridge (server-side environment only). This browser stores only the bridge URL and bridge token.
        </p>
        <div className="sform__actions">
          <button type="submit" className="sbtn" disabled={cfg.enabled && !tokenOk}>
            Save &amp; reconnect
          </button>
          {saved && <span className="sform__saved">Saved</span>}
        </div>
      </form>
    </Panel>
  );
}
