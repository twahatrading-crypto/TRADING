import { ChevronDown, ChevronUp, Database } from 'lucide-react';
import { useState } from 'react';
import { useServices } from '../../app/servicesContext';
import { useActiveInstrument } from '../../hooks/useMarket';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import { DB_ROOTS, type DbInstrumentStatus, type DbRoot } from '../../providers/databento/protocol';
import { capLabel, depthNotice, planLabel } from './capabilities';
import { useNow } from '../../store/clock';
import './databento.css';

const isRoot = (id: string): id is DbRoot => (DB_ROOTS as readonly string[]).includes(id);
const utc = (ns: number | null | undefined) => (ns == null ? '—' : `${new Date(Math.floor(ns / 1e6)).toISOString().replace('T', ' ').slice(0, 23)} UTC`);
const age = (ms: number | null | undefined) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);

const capTone = (v: string) => (v === 'LIVE' ? 'ok' : v === 'STALE' || v === 'WAITING' || v === 'SYNCING' || v === 'DEGRADED' ? 'warn' : v === 'OFFLINE' || v === 'UNAVAILABLE' ? 'bad' : 'off');

const TONE: Record<string, string> = { LIVE: 'ok', DEGRADED: 'warn', SYNCING: 'info', CONNECTING: 'info', RECONNECTING: 'bad', STALE: 'warn', UNAVAILABLE: 'bad', AUTH_ERROR: 'bad', OFFLINE: 'bad', 'NOT CONFIGURED': 'off' };

/**
 * Compact provider strip for GC / SI (COMEX futures): shows plainly whether the data is REAL LIVE Databento data,
 * the ACTUAL contract consumed, and an expandable diagnostics panel. Hidden for every other instrument
 * (XAUUSD / XAGUSD stay MT5 - the providers are never mixed or relabelled).
 */
export function DatabentoStrip() {
  const def = useActiveInstrument();
  const { databento } = useServices();
  const feed = useOptionalStore(databento?.state, (s) => s, null);
  const [open, setOpen] = useState(false);
  const now = useNow('second');
  if (!isRoot(def.id)) return null;
  const st: DbInstrumentStatus | null = feed?.health?.instruments[def.id] ?? null;
  const bridgeDown = !databento ? 'NOT CONFIGURED' : feed?.bridge === 'OFFLINE' ? 'OFFLINE' : feed?.bridge === 'UNAUTHORIZED' ? 'UNAVAILABLE' : null;
  const status = bridgeDown ?? st?.status ?? 'CONNECTING';
  const m = feed?.health?.metrics ?? {};
  const book = st?.book;
  const caps = st?.capabilities ?? null;
  const plan = st?.plan ?? feed?.health?.plan ?? null;
  const depth = databento ? depthNotice(caps, plan) : null;
  const sessions = feed?.health?.sessions;
  const seqIssues = book ? (book.counts.outOfOrder ?? 0) + (book.counts.maybeBadBook ?? 0) : 0;
  return (
    <div className={`dbstrip is-${TONE[status] ?? 'info'}`} data-testid="databento-strip">
      <div className="dbstrip__row">
        <span className="dbstrip__badge" data-testid="databento-badge">
          <Database size={13} /> DATABENTO • GLBX.MDP3 • {status}
        </span>
        <span className="dbstrip__contract" data-testid="databento-contract">
          {def.id} • {st?.contract ?? (databento ? 'resolving contract…' : 'no provider')}
        </span>
        {!databento && <span className="dbstrip__note">COMEX order flow needs the Databento bridge (Settings → Databento). DATA UNAVAILABLE — never MT5, never simulated.</span>}
        {databento && st && <span className="dbstrip__note">{st.freshness === 'LIVE' ? `REAL LIVE DATA · last event ${age(st.lastEventAgeMs)} ago` : st.freshness}{st.reasons[0] ? ` · ${st.reasons[0]}` : ''}</span>}
        {databento && feed?.error && <span className="dbstrip__note">{feed.error}</span>}
        {databento && caps && (
          <span className="dbstrip__caps" data-testid="databento-capabilities">
            {(
              [
                ['Trades', caps.trades],
                ['OHLCV', caps.ohlcv],
                ['Volume', caps.volume],
                ['Depth', caps.depth],
                ['MBO', caps.mbo],
                ['MBP-10', caps.mbp10],
              ] as const
            ).map(([k, v]) => (
              <span key={k} className={`dbcap is-${capTone(v)}`}>
                {k}: {capLabel(v)}
              </span>
            ))}
          </span>
        )}
        {databento && (
          <button type="button" className="dbstrip__toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="databento-diagnostics">
            Diagnostics {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
      </div>
      {depth && (
        <p className="dbstrip__depth" role="status" data-testid="databento-depth-unavailable">
          <strong>DEPTH DATA UNAVAILABLE</strong> — {depth.reason}. {depth.required}
        </p>
      )}
      {open && databento && (
        <dl className="dbstrip__diag" id="databento-diagnostics" data-testid="databento-diagnostics">
          {(
            [
              ['Provider', 'DATABENTO'],
              ['Dataset', feed?.health?.dataset ?? 'GLBX.MDP3'],
              ['Plan mode', planLabel(plan)],
              ['Schemas requested', feed?.health?.schemas ? Object.values(feed.health.schemas.requested).flat().join(', ') || 'none' : '—'],
              ['Instrument', `${def.id} — ${def.name}`],
              ['Subscribed symbol', st ? `${st.subscribed} (${st.stypeIn})` : '—'],
              ['Actual contract', st?.contract ?? '—'],
              ['Instrument ID', st?.instrumentId != null ? String(st.instrumentId) : '—'],
              ['Connection', `${sessions?.tape.state ?? status} · bridge ${feed?.bridge ?? '—'} · trades/OHLCV session ${sessions?.tape.state ?? '—'}${plan === 'standard' ? '' : ` · MBO book session ${sessions?.book.state ?? '—'}`}`],
              ['Capabilities', caps ? `Trades ${capLabel(caps.trades)} · OHLCV ${capLabel(caps.ohlcv)} · Volume ${capLabel(caps.volume)} · Depth ${capLabel(caps.depth)} · MBO ${capLabel(caps.mbo)} · MBP-10 ${capLabel(caps.mbp10)}` : '—'],
              ['Level-2 provider', caps?.level2Provider === 'DATABENTO_MBO' ? 'Databento MBO' : 'Not Connected'],
              ['Book status', plan === 'standard' ? 'No order book (Standard plan: MBO / MBP-10 not included)' : book ? `${book.state}${book.reason ? ` — ${book.reason}` : ''} · ${book.orders} orders · ${book.bidLevels}/${book.askLevels} levels` : '—'],
              ['Last event time', utc(st?.lastEventNs)],
              ['Last receive time', utc(st?.lastRecvNs)],
              ['Last update age', age(st?.lastEventAgeMs)],
              ['Freshness', st?.freshness ?? '—'],
              ['Sequence health', plan === 'standard' ? 'n/a (no MBO book)' : book ? `${seqIssues === 0 ? 'OK' : 'ISSUES'} · out-of-order ${book.counts.outOfOrder ?? 0} · maybe-bad-book ${book.counts.maybeBadBook ?? 0} · anomalies ${book.counts.anomalies ?? 0} · malformed ${book.counts.malformed ?? 0}` : '—'],
              ['Reconnects / resyncs', `${(feed?.health?.sessions.book.reconnects ?? 0) + (feed?.health?.sessions.tape.reconnects ?? 0)} / ${(feed?.health?.sessions.book.resyncs ?? 0) + (feed?.health?.sessions.tape.resyncs ?? 0)}`],
              ['Duplicates dropped', st ? `MBO ${st.counts.mboDuplicates ?? 0} · trades ${st.tape.counts.duplicates ?? 0} (replay de-dup)` : '—'],
              ['Trades / unknown side', st ? `${st.tape.counts.accepted ?? 0} / ${st.tape.counts.unknownSide ?? 0} · gaps ${st.counts.tapeGaps ?? 0}${st.tape.replaying ? ' · REPLAYING history' : ''}` : '—'],
              ['Ingest', `${m.ingestRatePerSec ?? 0} rec/s · queue ${m.queueDepth ?? 0} (max ${m.maxQueueDepth ?? 0}) · lag ${m.ingestLagMs ?? '—'} ms`],
              ['Browser publish', `${feed?.framesPerSec ?? 0} frames/s · cursor ${feed?.cursor ?? 0} · resets ${feed?.resets ?? 0}`],
              ['Contract rolls', (feed?.health?.rolls ?? []).filter((r) => r.root === def.id).map((r) => `${r.from}→${r.to}`).join(', ') || 'none'],
              ['Bridge heartbeat', feed?.lastOkAt ? `${Math.max(0, Math.round((now - feed.lastOkAt) / 1000))} s ago` : '—'],
            ] as [string, string][]
          ).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
