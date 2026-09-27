import { Newspaper, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useServices } from '../../app/servicesContext';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import { loadNewsBridgeConfig, looksLikeProviderKey, NEWS_BRIDGE_DEFAULT_URL, saveNewsBridgeConfig, type NewsBridgeConfig } from '../../providers/newsBridge/config';
import type { BridgeFeedKind, BridgeFeedView } from '../../providers/newsBridge/protocol';
import { Panel } from '../ui/Panel';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const LABEL: Record<BridgeFeedKind, string> = { calendar: 'Economic Calendar', breaking: 'Breaking News', macro: 'Macro News' };
const FRESHNESS: Record<string, string> = { LIVE: 'Live', DELAYED: 'Delayed', STALE: 'Stale', CONNECTING: 'Connecting', ERROR: 'Error', NOT_CONFIGURED: 'Not configured', DISABLED: 'Disabled' };
const connectedOf = (v: BridgeFeedView | undefined) => !!v && (v.status === 'LIVE' || v.status === 'DELAYED' || v.status === 'STALE');
const when = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');

/**
 * Settings → News Providers. The browser stores only the LOCAL news backend URL and its backend token. Provider
 * credentials (Trading Economics, newswires) live only in bridge/news/.env on the backend.
 */
export function NewsProvidersSettingsPanel() {
  const [cfg, setCfg] = useState<NewsBridgeConfig>(() => loadNewsBridgeConfig(storage()));
  const { newsBridge } = useServices();
  const st = useOptionalStore(newsBridge?.state, (s) => s, null);
  const set = <K extends keyof NewsBridgeConfig>(k: K, v: NewsBridgeConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const looksLikeKey = !!cfg.token && looksLikeProviderKey(cfg.token);
  const tokenOk = cfg.token.length >= 32 && !looksLikeKey;
  const feeds = st?.health?.feeds;
  const offline = !newsBridge ? 'News backend not enabled' : st?.bridge === 'OFFLINE' || st?.bridge === 'UNAUTHORIZED' ? st.error ?? 'News backend not reachable' : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    saveNewsBridgeConfig(storage(), cfg);
    window.location.reload();
  };
  const row = (kind: BridgeFeedKind) => {
    const v = feeds?.[kind];
    const ok = !offline && connectedOf(v);
    return (
      <div key={kind} data-testid={`news-provider-${kind}`}>
        <dt>{LABEL[kind]}</dt>
        <dd>
          <strong className={ok ? 'dbset__cap--yes' : 'dbset__cap--no'}>{ok ? 'Connected' : 'Not Connected'}</strong>
          {' · '}
          {v?.providerName ?? v?.provider ?? (kind === 'breaking' ? 'no licensed provider configured' : 'Trading Economics')}
          {kind === 'calendar' && (
            <>
              {' · '}Enabled: {v ? (v.enabled && v.configured ? 'yes' : 'no') : '—'}
              {' · '}Freshness: {offline ? 'Unavailable' : v ? FRESHNESS[v.status] ?? v.status : '—'}
              {' · '}Last update: {when(v?.lastSuccessMs)}
              {v?.streaming ? ` · Streaming: ${v.streaming.state.replace(/_/g, ' ').toLowerCase()}` : ''}
            </>
          )}
          {!ok && (offline ?? v?.detail) ? <span className="dbset__why"> — {offline ?? v?.detail}</span> : null}
        </dd>
      </div>
    );
  };
  return (
    <Panel id="news-providers" title="News Providers" icon={<Newspaper size={15} />} subtitle="Local news backend (bridge/news) → Trading Economics · real data only">
      <form className="sform" onSubmit={submit} data-testid="news-providers-settings">
        <dl className="dbset__caps" data-testid="news-provider-status">
          {(['calendar', 'breaking', 'macro'] as const).map(row)}
        </dl>
        <label className="sform__check">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Enable the TLUXE news backend (default {NEWS_BRIDGE_DEFAULT_URL})
        </label>
        <label className="sform__field">
          <span>Backend URL</span>
          <input type="url" value={cfg.url} onChange={(e) => set('url', e.target.value)} spellCheck={false} />
        </label>
        <label className="sform__field">
          <span>Backend token</span>
          <input type="password" autoComplete="off" value={cfg.token} onChange={(e) => set('token', e.target.value)} placeholder="TLUXE_NEWS_TOKEN from bridge/news/.env" spellCheck={false} />
        </label>
        {looksLikeKey && <p className="sform__warn">That looks like a provider API key. Never enter it in the browser — it belongs only in bridge/news/.env (e.g. TRADING_ECONOMICS_API_KEY).</p>}
        {cfg.token && !looksLikeKey && !tokenOk && <p className="sform__warn">The backend token is at least 32 characters.</p>}
        <p className="sform__note">
          <ShieldCheck size={13} /> Provider credentials stay on the news backend (server-side environment only). This browser stores only the backend URL and backend token.
        </p>
        <div className="sform__actions">
          <button type="submit" className="sbtn" disabled={cfg.enabled && !tokenOk}>
            Save &amp; reconnect
          </button>
        </div>
      </form>
    </Panel>
  );
}
