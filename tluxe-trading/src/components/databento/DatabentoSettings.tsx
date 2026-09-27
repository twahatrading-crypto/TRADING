import { Database, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { loadDatabentoConfig, saveDatabentoConfig, type DatabentoConfig } from '../../providers/databento/config';
import { Panel } from '../ui/Panel';

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
