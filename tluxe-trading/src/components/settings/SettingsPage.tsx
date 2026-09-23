import { ArrowLeft, Database, KeyRound, Radio, Search, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { TIMEFRAMES } from '../../config/instrument';
import { useServices } from '../../app/servicesContext';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { CONNECTION_LABEL } from '../../services/market/normalize';
import { loadMt5Config, saveMt5Config, type Mt5Config } from '../../services/mt5/config';
import { FEED_LABEL, FEED_TONE } from '../../services/mt5/freshness';
import type { Mt5Provider, Mt5ProviderState } from '../../services/mt5/Mt5Provider';
import { useNow } from '../../store/clock';
import { useStore } from '../../store/createStore';
import { formatPrice, UNKNOWN } from '../../utils/format';
import { Panel } from '../ui/Panel';
import { StatusPill } from '../ui/StatusPill';
import './settings.css';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** "12s ago" style age; unknown stays unknown. */
function ageText(at: number | null | undefined, now: number): string {
  if (at == null) return UNKNOWN;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const utc = (at: number | null | undefined) => (at == null ? UNKNOWN : `${new Date(at).toISOString().replace('T', ' ').slice(0, 19)} UTC`);

const isPrivateUrl = (u: string) => {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  } catch {
    return false;
  }
};

function Row({ k, v, testId }: { k: string; v: string; testId?: string }) {
  return (
    <div className="kv__row">
      <dt>{k}</dt>
      <dd className={v === UNKNOWN ? 'is-unknown' : ''} data-testid={testId}>{v}</dd>
    </div>
  );
}

/** Settings → Data Providers. MT5 is configured here; nothing is ever simulated. */
export function SettingsPage() {
  const { mt5 } = useServices();
  return (
    <>
      <main className="module-page settings">
        <a className="btn-ghost module-page__back" href="#/">
          <ArrowLeft size={14} /> Dashboard
        </a>
        <div className="module-page__head">
          <div>
            <h1 className="module-page__title">Settings</h1>
            <p className="module-page__desc">Data providers — real market data only. Nothing is simulated.</p>
          </div>
        </div>
        <div className="settings__grid">
          <Mt5ConfigPanel />
          {mt5 ? <BridgePanel provider={mt5} /> : <DisabledPanel />}
          <FeedPanel />
          {mt5 && <DiscoveryPanel provider={mt5} />}
        </div>
      </main>
    </>
  );
}

function Mt5ConfigPanel() {
  const [cfg, setCfg] = useState<Mt5Config>(() => loadMt5Config(storage()));
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof Mt5Config>(k: K, v: Mt5Config[K]) => {
    setSaved(false);
    setCfg((c) => ({ ...c, [k]: v }));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    saveMt5Config(storage(), cfg);
    setSaved(true);
    // Providers are created at start-up: reload so the new settings take effect cleanly.
    window.location.reload();
  };
  const tokenOk = cfg.token.length >= 32;
  return (
    <Panel id="mt5-config" title="MT5 Bridge" icon={<KeyRound size={15} />} subtitle="Private connection to your MetaTrader 5 terminal">
      <form className="sform" onSubmit={submit}>
        <label className="sform__check">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Enable MT5 market data
        </label>
        <label className="sform__field">
          <span>Bridge URL</span>
          <input type="url" value={cfg.bridgeUrl} onChange={(e) => set('bridgeUrl', e.target.value)} spellCheck={false} />
        </label>
        {!isPrivateUrl(cfg.bridgeUrl) && <p className="sform__warn">This URL is not local/private. Only expose the bridge on a private network.</p>}
        <label className="sform__field">
          <span>Access token</span>
          <input
            type="password"
            autoComplete="off"
            value={cfg.token}
            onChange={(e) => set('token', e.target.value)}
            placeholder="TLUXE_BRIDGE_TOKEN from the bridge .env"
            spellCheck={false}
          />
        </label>
        {cfg.token && !tokenOk && <p className="sform__warn">The bridge requires a token of at least 32 characters.</p>}
        <div className="sform__row">
          <label className="sform__field">
            <span>History bars / timeframe</span>
            <input type="number" min={100} max={50000} step={100} value={cfg.historyBars} onChange={(e) => set('historyBars', Number(e.target.value))} />
          </label>
          <label className="sform__field">
            <span>Min. closed bars (S&amp;R)</span>
            <input type="number" min={1} max={5000} value={cfg.minHistoryBars} onChange={(e) => set('minHistoryBars', Number(e.target.value))} />
          </label>
        </div>
        <p className="sform__note">
          <ShieldCheck size={13} /> Stored in this browser only. The token is sent only to the bridge URL above, in the Authorization header.
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

function DisabledPanel() {
  return (
    <Panel id="mt5-status" title="Connection" icon={<Radio size={15} />}>
      <div className="settings__empty" data-testid="mt5-disabled">
        <StatusPill tone="off" label="MT5 NOT ENABLED" compact />
        <p>
          No price provider is connected, so every instrument shows <strong>DATA UNAVAILABLE</strong>. Start the TLUXE MT5 bridge on the PC running
          MetaTrader 5 (see <code>bridge/mt5/README.md</code>), then enable it here with its URL and token.
        </p>
      </div>
    </Panel>
  );
}

function BridgePanel({ provider }: { provider: Mt5Provider }) {
  const st = useStore(provider.state, (s) => s);
  const now = useNow('second');
  const t = st.terminal;
  const bridgeLabel =
    st.error?.code === 'MT5_BRIDGE_OFFLINE' || (st.heartbeatAt === null && st.attempted) ? 'OFFLINE' : st.heartbeatAt === null ? 'CONNECTING' : 'REACHABLE';
  return (
    <Panel id="mt5-status" title="Connection" icon={<Radio size={15} />} subtitle="Bridge · terminal · account">
      <dl className="kv">
        <Row k="Bridge" v={`${bridgeLabel}${st.bridgeVersion ? ` · v${st.bridgeVersion}` : ''}`} testId="bridge-state" />
        <Row k="Bridge heartbeat" v={ageText(st.heartbeatAt, now)} />
        <Row k="Terminal" v={t ? [t.state, t.name, t.build ? `build ${t.build}` : null].filter(Boolean).join(' · ') : UNKNOWN} />
        <Row k="Broker" v={st.account ? `${st.account.company} · ${st.account.server}` : UNKNOWN} />
        <Row k="Account" v={st.account ? `${st.account.loginMasked} · ${st.account.tradeMode.toUpperCase()} · ${st.account.currency}` : UNKNOWN} />
        <Row k="Server time → UTC" v={timeBasisText(st)} />
        <Row k="Symbols in terminal" v={st.symbolCount === null ? UNKNOWN : String(st.symbolCount)} />
        <Row k="Reconnects" v={String(st.reconnects)} />
        {st.error && <Row k="Last error" v={`${st.error.code}: ${st.error.message}`} />}
      </dl>
      {bridgeLabel === 'OFFLINE' && (
        <p className="sform__note settings__hint" data-testid="origin-hint">
          If the bridge window is running, its <code>TLUXE_BRIDGE_ALLOWED_ORIGINS</code> must include <strong>{window.location.origin}</strong>. A
          browser page that is not allowed looks exactly like an offline bridge.
        </p>
      )}
    </Panel>
  );
}

function timeBasisText(st: Mt5ProviderState): string {
  const tb = st.time;
  if (!tb) return UNKNOWN;
  if (tb.basis === 'iana') return `IANA ${tb.timezone}`;
  if (tb.basis === 'detected') return `Detected offset ${tb.offsetSec === null ? '?' : `UTC${tb.offsetSec >= 0 ? '+' : '−'}${Math.abs(tb.offsetSec) / 3600}h`} (set TLUXE_MT5_SERVER_TIMEZONE for DST safety)`;
  return 'UNRESOLVED — set TLUXE_MT5_SERVER_TIMEZONE';
}

function FeedPanel() {
  const def = useActiveInstrument();
  const s = useMarket((m) => m);
  const now = useNow('second');
  const f = s.feed;
  const meta = f?.meta;
  const history = f ? TIMEFRAMES.map((tf) => (f.historyBars[tf] === undefined ? null : `${tf} ${f.historyBars[tf]}${f.historyLimited[tf] ? '*' : ''}`)).filter(Boolean).join(' · ') : '';
  return (
    <Panel
      id="feed-detail"
      title={`Feed · ${def.shortName}`}
      icon={<Database size={15} />}
      subtitle={def.displayName}
      actions={<StatusPill tone={f ? FEED_TONE[f.code] : 'off'} label={f ? FEED_LABEL[f.code] : CONNECTION_LABEL[s.connection]} compact />}
    >
      <dl className="kv" data-testid="feed-detail">
        <Row k="Provider" v={s.provider?.name ?? 'Not Connected'} testId="feed-provider" />
        <Row k="Provider symbol" v={f?.providerSymbol ? `${f.providerSymbol}${f.inverted ? ' (inverted)' : ''}` : UNKNOWN} />
        <Row k="Connection" v={CONNECTION_LABEL[s.connection]} />
        {f?.message && <Row k="Status" v={f.message} />}
        <Row k="Quote freshness" v={ageText(f?.lastQuoteAt, now)} />
        <Row k="Last quote" v={f?.lastQuoteAt ? `${formatPrice(s.quote.bid, s.instrument.priceDecimals)} / ${formatPrice(s.quote.ask, s.instrument.priceDecimals)} · ${utc(f.lastQuoteAt)}` : UNKNOWN} />
        <Row k="Last closed candle" v={utc(f?.lastClosedCandleAt)} />
        <Row k="History bars loaded" v={history || UNKNOWN} />
        <Row k="Digits · point · tick" v={meta ? `${meta.digits} · ${meta.point} · ${meta.tickSize}` : UNKNOWN} />
        <Row k="Contract size" v={meta ? String(meta.contractSize) : UNKNOWN} />
        <Row k="Volume" v={f?.realVolumeAvailable == null ? UNKNOWN : f.realVolumeAvailable ? 'Real volume available' : 'Tick volume only (no real volume)'} />
        <Row k="Integrity" v={f ? `${f.quarantined} bars quarantined · ${f.gaps} non-weekend gaps` : UNKNOWN} />
      </dl>
      {history.includes('*') && <p className="sform__note">* The broker returned fewer bars than requested (history limited).</p>}
    </Panel>
  );
}

function DiscoveryPanel({ provider }: { provider: Mt5Provider }) {
  const st = useStore(provider.state, (s) => s);
  const [cfg] = useState(() => loadMt5Config(storage()));
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(cfg.overrides).map(([k, v]) => [k, v.symbol])));
  const saveOverrides = () => {
    const overrides: Mt5Config['overrides'] = {};
    for (const [k, v] of Object.entries(drafts)) if (v.trim()) overrides[k] = { symbol: v.trim(), inverted: cfg.overrides[k]?.inverted ?? false };
    saveMt5Config(storage(), { ...cfg, overrides });
    window.location.reload();
  };
  return (
    <Panel id="mt5-discovery" title="Symbol discovery" icon={<Search size={15} />} subtitle="Override → exact → alias → suffix/prefix · ambiguity stops" className="settings__wide">
      {st.resolutions.length === 0 ? (
        <p className="settings__empty">Discovery runs once the bridge reports a connected terminal.</p>
      ) : (
        <div className="stable-wrap">
          <table className="stable" data-testid="discovery-table">
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Result</th>
                <th>MT5 symbol</th>
                <th>Candidates / note</th>
                <th>Override</th>
              </tr>
            </thead>
            <tbody>
              {st.resolutions.map((r) => (
                <tr key={r.instrumentId}>
                  <td>{r.displayName}</td>
                  <td>
                    <span className={`stag stag--${r.status}`}>{r.status === 'resolved' ? (r.tier ?? 'resolved') : r.status}</span>
                  </td>
                  <td className="num">{r.providerSymbol ? `${r.providerSymbol}${r.inverted ? ' (inv.)' : ''}` : UNKNOWN}</td>
                  <td className="stable__note">{[r.candidates.join(', '), r.note].filter(Boolean).join(' · ') || UNKNOWN}</td>
                  <td>
                    {r.status !== 'not-mapped' && (
                      <input
                        className="stable__input"
                        aria-label={`Override for ${r.displayName}`}
                        value={drafts[r.instrumentId] ?? ''}
                        placeholder="auto"
                        onChange={(e) => setDrafts((d) => ({ ...d, [r.instrumentId]: e.target.value }))}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="sform__actions">
        <button type="button" className="sbtn" onClick={saveOverrides} disabled={st.resolutions.length === 0}>
          Save overrides &amp; reconnect
        </button>
      </div>
      <h3 className="settings__h3">Possible COMEX futures symbols in this terminal</h3>
      <p className="sform__note">Reported only. GC and SI stay COMEX futures and are never mapped to spot XAUUSD/XAGUSD prices.</p>
      {st.futuresCandidates.length ? (
        <ul className="settings__list">
          {st.futuresCandidates.map((c) => (
            <li key={c.name}>
              <strong>{c.name}</strong> · {c.description || UNKNOWN} · <span className="settings__path">{c.path}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings__empty">{st.lastDiscoveryAt ? 'None found.' : UNKNOWN}</p>
      )}
    </Panel>
  );
}
