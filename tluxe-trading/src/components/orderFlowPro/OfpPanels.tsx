import { useEffect, useRef, useState } from 'react';
import { STRONG_PARAMS, type Alert, type OfpView } from '../../engines/orderFlowPro/engine';
import { EVIDENCE_LABEL, type ReversalSignal } from '../../engines/orderFlowPro/reversal';
import type { CapabilityState, SourceStatus, StreamProvenance } from '../../engines/orderFlowPro/types';
import { DEFAULT_OFP_LINK, isLoopbackUrl, loadOfpLink, OFP_BACKEND_AVAILABLE, saveOfpLink, type OfpLinkConfig } from '../../providers/orderFlowPro/config';
import { ProfileMini } from './OfpCanvases';
import { feedLabel, fmtExpiry, fmtNum, fmtSigned, fmtUtcTime } from './ofpFormat';
import { sourceText } from './ofpSourceText';

function Empty({ text }: { text: string }) {
  return <div className="ofp-empty">{text}</div>;
}

/* ---------------- right column ---------------- */

const fmtDur = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s` : `${Math.round(ms / 1000)} s`);

/**
 * Visible IBKR book: cumulative depth from the touch, displayed size with a proportional bar, spread row between the
 * best ask and best bid, and a marker on levels that currently qualify as strong resting liquidity.
 */
export function OrderBookPanel({ view, precision, rows }: { view: OfpView; precision: number; rows: number }) {
  const asksNear = view.book.asks.slice(0, rows); // ascending from best ask
  const bids = view.book.bids.slice(0, rows); // descending from best bid
  const max = Math.max(1, ...asksNear.map((a) => a[1]), ...bids.map((b) => b[1]));
  const strong = new Set(view.strong.map((x) => `${x.side}:${x.tick}`));
  const tick = view.recorder.tick;
  const key = (side: string, p: number) => `${side}:${Math.round(p / tick)}`;
  let cum = 0;
  const askRows = asksNear.map(([p, sz]) => ({ p, sz, cum: (cum += sz) })).reverse();
  cum = 0;
  const bidRows = bids.map(([p, sz]) => ({ p, sz, cum: (cum += sz) }));
  const bestBid = bids[0]?.[0];
  const bestAsk = asksNear[0]?.[0];
  const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : null;
  // Keep the touch (spread row) centred in the scroll box until the user scrolls the book themselves.
  const box = useRef<HTMLDivElement | null>(null);
  const userScrolled = useRef(false);
  const programmatic = useRef(false);
  useEffect(() => {
    const el = box.current;
    const row = el?.querySelector<HTMLElement>('.ofp-book__spread');
    if (!el || !row || userScrolled.current) return;
    programmatic.current = true;
    el.scrollTop = row.offsetTop - el.clientHeight / 2 + row.offsetHeight / 2;
  });
  return (
    <div
      className="ofp-scroll"
      ref={box}
      onScroll={() => {
        if (programmatic.current) programmatic.current = false;
        else userScrolled.current = true;
      }}
    >
      <table className="ofp-book" aria-label="Order book">
        <thead>
          <tr>
            <th title="Cumulative bid size from the best bid">Cum</th>
            <th>Bid size</th>
            <th>Price</th>
            <th>Ask size</th>
            <th title="Cumulative ask size from the best ask">Cum</th>
          </tr>
        </thead>
        <tbody>
          {!view.bookValid && (
            <tr>
              <td colSpan={5} className="ofp-book__none">
                No valid IBKR book {view.status.feed === 'DEMO' ? '' : '(not subscribed / not LIVE)'}
              </td>
            </tr>
          )}
          {askRows.map(({ p, sz, cum: c }, i) => (
            <tr key={`a${p}`} className={`is-ask${i === askRows.length - 1 ? ' is-best' : ''}${strong.has(key('ASK', p)) ? ' is-strong' : ''}`}>
              <td />
              <td />
              <td className="ofp-book__px ask">{p.toFixed(precision)}</td>
              <td className="ofp-book__sz">
                <i className="ofp-book__bar ofp-book__bar--ask" style={{ width: `${(sz / max) * 100}%` }} />
                <span>{sz}</span>
              </td>
              <td className="dim">{c}</td>
            </tr>
          ))}
          {view.bookValid && (
            <tr className="ofp-book__spread">
              <td colSpan={5}>{spread !== null ? `Spread ${spread.toFixed(precision)} (${Math.round(spread / tick)} tick${Math.round(spread / tick) === 1 ? '' : 's'})` : 'Spread —'}</td>
            </tr>
          )}
          {bidRows.map(({ p, sz, cum: c }, i) => (
            <tr key={`b${p}`} className={`is-bid${i === 0 ? ' is-best' : ''}${strong.has(key('BID', p)) ? ' is-strong' : ''}`}>
              <td className="dim">{c}</td>
              <td className="ofp-book__sz ofp-book__sz--bid">
                <i className="ofp-book__bar ofp-book__bar--bid" style={{ width: `${(sz / max) * 100}%` }} />
                <span>{sz}</span>
              </td>
              <td className="ofp-book__px bid">{p.toFixed(precision)}</td>
              <td />
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STRENGTH_LOOKBACK_MS = 30 * 60_000;

/**
 * Liquidity Strength: every level of the CURRENT visible book with what was actually observed - displayed size,
 * relative strength (x median of the visible book), resting time, presence over the last 30 min of VALID book
 * time, 30-min time-weighted average, observed adds / reductions. Book coverage is shown first; metrics the IBKR
 * price-level feed cannot provide are listed as unavailable.
 */
export function LiquidityStrength({ view, precision, now }: { view: OfpView; precision: number; now: number }) {
  const rec = view.recorder;
  const cov = rec.coverage(now, STRENGTH_LOOKBACK_MS);
  const levels = rec.observedLevels(now, { ...STRONG_PARAMS, lookbackMs: STRENGTH_LOOKBACK_MS });
  const bids = levels.filter((l) => l.side === 'BID').length;
  const asks = levels.length - bids;
  const sizes = levels.map((l) => l.size).sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)]! : null;
  const maxRel = Math.max(1, ...levels.map((l) => l.relative));
  return (
    <div className="ofp-strength ofp-scroll" data-testid="ofp-strength">
      <dl className="ofp-strength__head">
        <div>
          <dt>Book coverage (30 min)</dt>
          <dd className={cov.share >= 0.9 ? 'ok' : cov.share > 0 ? 'warn' : 'dim'}>{cov.validMs > 0 ? `${Math.round(cov.share * 100)}% · ${fmtDur(cov.validMs)}` : 'no recorded depth'}</dd>
        </div>
        <div>
          <dt>Levels observed now</dt>
          <dd>{view.bookValid ? `${bids} bid · ${asks} ask` : '—'}</dd>
        </div>
        <div>
          <dt>Median displayed size</dt>
          <dd>{median ?? '—'}</dd>
        </div>
        <div>
          <dt>Recorded since</dt>
          <dd>{cov.firstRecorded !== null ? `${fmtUtcTime(cov.firstRecorded).slice(0, 5)} UTC` : '—'}</dd>
        </div>
      </dl>
      {levels.length === 0 ? (
        <Empty text={view.bookValid ? 'Book is valid but empty' : 'No valid book - nothing observed to rank'} />
      ) : (
        <table className="ofp-table ofp-table--tight">
          <thead>
            <tr>
              <th>Side</th>
              <th>Price</th>
              <th title="Displayed size now">Size</th>
              <th title="Displayed size / median of the visible book (not a probability)">Strength</th>
              <th title="Time this level has been displayed continuously">Resting</th>
              <th title="Share of the last 30 min of VALID book time this price/side was displayed">Present</th>
              <th title="Time-weighted average displayed size, last 30 min">30m avg</th>
              <th title="Observed size increases / decreases (not attributed to orders, cancels or fills)">+ / −</th>
            </tr>
          </thead>
          <tbody>
            {levels.slice(0, 20).map((l) => (
              <tr key={`${l.side}${l.tick}`} className={l.strong ? 'is-strong' : ''}>
                <td className={l.side === 'BID' ? 'bid' : 'ask'}>{l.side}</td>
                <td>{l.price.toFixed(precision)}</td>
                <td>{l.size}</td>
                <td>
                  <span className="ofp-meter">
                    <i className={l.side === 'BID' ? 'bid' : 'ask'} style={{ width: `${(l.relative / maxRel) * 100}%` }} />
                  </span>
                  {l.relative.toFixed(1)}×
                </td>
                <td>{fmtDur(l.persistMs)}</td>
                <td>{cov.validMs > 0 ? `${Math.round(l.coverage * 100)}%` : '—'}</td>
                <td>{cov.validMs > 0 ? l.historicalAvg.toFixed(1) : '—'}</td>
                <td className="dim">
                  +{l.adds} / −{l.reductions}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="ofp-note">
        Highlighted = strong now ({'≥'} {STRONG_PARAMS.minRelative}× median, resting {'≥'} {STRONG_PARAMS.minPersistMs / 1000} s). <b>Unavailable</b> from IBKR price-level depth: order count per
        level, queue position, cancel vs fill attribution, hidden / iceberg size, depth beyond the {view.status.depthRows || 'granted'} rows.
      </p>
    </div>
  );
}

/* ---------------- bottom tabs ---------------- */

export function TradesTable({ view, precision }: { view: OfpView; precision: number }) {
  if (!view.tape.length) return <Empty text="No trade prints received" />;
  const tx = sourceText(view.status, false);
  return (
    <div className="ofp-scroll">
      <p className="ofp-note">{tx.classification}</p>
      <table className="ofp-table">
        <thead>
          <tr>
            <th>Time (UTC)</th>
            <th>Price</th>
            <th title={tx.sideTitle}>{tx.sideHeader}</th>
            <th>Size</th>
            <th title="UNKNOWN prints are never counted as buy or sell volume">Delta</th>
            <th title={tx.basisTitle}>{tx.basisHeader}</th>
          </tr>
        </thead>
        <tbody>
          {view.tape.map((t, i) => (
            <tr key={`${t.t}-${i}`}>
              <td>{fmtUtcTime(t.t, true)}</td>
              <td>{t.price.toFixed(precision)}</td>
              <td className={t.aggressor === 'BUY' ? 'bid' : t.aggressor === 'SELL' ? 'ask' : 'dim'}>{t.aggressor === 'BUY' ? 'Buy' : t.aggressor === 'SELL' ? 'Sell' : 'Unknown'}</td>
              <td>{t.size}</td>
              <td className={t.aggressor === 'BUY' ? 'bid' : t.aggressor === 'SELL' ? 'ask' : 'dim'}>{t.aggressor === 'UNKNOWN' ? '—' : `${t.aggressor === 'BUY' ? '+' : '-'}${t.size}`}</td>
              <td className="dim" title={t.quoteSource ? `reference: ${t.quoteSource} touch` : undefined}>
                {(t.basis ?? 'QUOTE_RULE').replace(/_/g, ' ').toLowerCase()}
                {t.quoteAgeMs !== undefined && t.quoteAgeMs !== null ? ` · ${(t.quoteAgeMs / 1000).toFixed(1)} s` : ''}
                {t.method === 'EXCHANGE' && t.tRecv !== undefined ? ` · ${Math.max(0, t.tRecv - t.t)} ms` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AlertsList({ alerts }: { alerts: readonly Alert[] }) {
  if (!alerts.length) return <Empty text="No alerts yet" />;
  return (
    <ul className="ofp-alerts ofp-scroll">
      {alerts.slice(0, 80).map((a) => (
        <li key={a.id} className={`tone-${a.tone}`}>
          <span>{fmtUtcTime(a.t)}</span>
          <b>{a.kind.replace('_', ' ')}</b>
          <span>{a.text}</span>
        </li>
      ))}
    </ul>
  );
}

const statusTone = (s: ReversalSignal['status']) => (s === 'INVALIDATED' ? 'dim' : s === 'CANDIDATE' ? 'warn' : 'ok');

export function ReversalTable({ signals, compact }: { signals: readonly ReversalSignal[]; compact?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!signals.length) return <Empty text="No reversal evidence in this session" />;
  const list = [...signals].reverse();
  return (
    <div className="ofp-scroll">
      <table className="ofp-table ofp-rev">
        <thead>
          <tr>
            <th>Time</th>
            <th>Direction</th>
            <th>Setup</th>
            <th title="Additive evidence score - NOT a probability of winning">Score</th>
            {!compact && <th>Status</th>}
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {list.map((s) => (
            <RevRow key={s.id} s={s} compact={compact} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RevRow({ s, compact, open, onToggle }: { s: ReversalSignal; compact?: boolean; open: boolean; onToggle: () => void }) {
  const present = s.evidence.filter((e) => e.state === 'PRESENT').map((e) => EVIDENCE_LABEL[e.key]);
  return (
    <>
      <tr className="is-click" onClick={onToggle} aria-expanded={open}>
        <td>{fmtUtcTime(s.knownAt)}</td>
        <td>
          <span className={`ofp-dir ofp-dir--${s.direction === 'BULLISH' ? 'bull' : 'bear'}`}>{s.direction === 'BULLISH' ? 'Bullish' : 'Bearish'}</span>
        </td>
        <td>{s.setup}</td>
        <td>
          <span className="ofp-score" title={`at signal ${s.scoreAtSignal}; now ${s.score} of ${s.maxScore} evaluable`}>
            {s.scoreAtSignal}
          </span>
        </td>
        {!compact && <td className={statusTone(s.status)}>{s.status}</td>}
        <td className="ofp-ev">{present.slice(0, 3).join(' + ')}</td>
      </tr>
      {open && (
        <tr className="ofp-rev__detail">
          <td colSpan={compact ? 5 : 6}>
            <p className="ofp-note">
              Evidence score {s.scoreAtSignal} at signal (now {s.score} / {s.maxScore} evaluable). Research only - not a probability, not a trade instruction. Invalidation
              level {s.invalidation}.
            </p>
            <ul>
              {s.evidence.map((e) => (
                <li key={e.key} className={`ev-${e.state.toLowerCase()}`}>
                  <b>{EVIDENCE_LABEL[e.key]}</b> <span>{e.state}</span> <em>+{e.weight}</em> - {e.detail}
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

export function StrongTable({ view, precision }: { view: OfpView; precision: number }) {
  if (!view.strong.length) return <Empty text="No strong resting liquidity right now" />;
  return (
    <div className="ofp-scroll">
      <p className="ofp-note">Displayed resting size only ({'≥'} 2.5× visible-book median, resting {'≥'} 60 s). Not executed volume; may be pulled at any time.</p>
      <table className="ofp-table">
        <thead>
          <tr>
            <th>Side</th>
            <th>Price</th>
            <th>Size</th>
            <th>× median</th>
            <th>Resting</th>
            <th>Adds / Reductions</th>
            <th>30 m avg</th>
          </tr>
        </thead>
        <tbody>
          {view.strong.map((s) => (
            <tr key={`${s.side}${s.tick}`}>
              <td className={s.side === 'BID' ? 'bid' : 'ask'}>{s.side}</td>
              <td>{s.price.toFixed(precision)}</td>
              <td>{s.size}</td>
              <td>{s.relative.toFixed(1)}</td>
              <td>{Math.round(s.persistMs / 1000)} s</td>
              <td>
                +{s.adds} / -{s.reductions}
              </td>
              <td>{s.historicalAvg.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AbsorptionTable({ signals }: { signals: readonly ReversalSignal[] }) {
  const rows = signals.filter((s) => s.evidence.some((e) => e.key === 'absorption' && e.state === 'PRESENT'));
  if (!rows.length) return <Empty text="No absorption evidence (needs classifiable prints)" />;
  return (
    <div className="ofp-scroll">
      <table className="ofp-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Direction</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((s) => (
            <tr key={s.id}>
              <td>{fmtUtcTime(s.knownAt)}</td>
              <td className={s.direction === 'BULLISH' ? 'bid' : 'ask'}>{s.direction === 'BULLISH' ? 'Bullish' : 'Bearish'}</td>
              <td>{s.evidence.find((e) => e.key === 'absorption')!.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Session-history coverage: shown whenever the session's prints are not completely loaded, so session statistics
 * (volume, delta, CVD, profile) are never presented as complete. Offers the on-demand load of earlier prints.
 */
export function HistoryCoverage({ st, onLoad, onCancel }: { st: SourceStatus; onLoad?: () => void; onCancel?: () => void }) {
  const h = st.provenance?.history;
  if (!h || h.complete) return null;
  const hhmm = (t: number) => `${fmtUtcTime(t).slice(0, 5)} UTC`;
  return (
    <div className="ofp-note ofp-note--warn" role="status" data-testid="ofp-history-coverage">
      <b>PARTIAL SESSION</b> · prints loaded from {h.loadedFrom !== null ? hhmm(h.loadedFrom) : '—'} (session from {hhmm(h.sessionStart)}); earlier bars are
      Databento OHLCV only (no footprint), so session volume, delta, CVD and profile cover the loaded part only.
      {h.historyThrough !== null && h.loadedFrom !== null && ` Earlier prints merged ${hhmm(h.sessionStart)} → ${hhmm(h.historyThrough)}; ${hhmm(h.historyThrough)} → ${hhmm(h.loadedFrom)} not loaded yet.`}
      {h.unavailable && ` Prints ${hhmm(h.unavailable.from)} → ${hhmm(h.unavailable.to)} are no longer available from the gateway.`}
      {h.loading && ` Loading earlier prints… ${h.historyLoaded.toLocaleString('en-US')} so far.`}
      {h.error && ` ${h.error}.`}{' '}
      {!h.loading && onLoad && !h.unavailable && (
        <button type="button" className="ofp-btn" onClick={onLoad}>
          Load earlier prints
        </button>
      )}
      {h.loading && onCancel && (
        <button type="button" className="ofp-btn ofp-btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}

export function SessionStatsPanel({ view, onLoadHistory, onCancelHistory }: { view: OfpView; onLoadHistory?: () => void; onCancelHistory?: () => void }) {
  const s = view.stats;
  return (
    <dl className="ofp-kv ofp-scroll">
      <HistoryCoverage st={view.status} onLoad={onLoadHistory} onCancel={onCancelHistory} />
      <dt>Session window</dt>
      <dd>
        {fmtUtcTime(s.window.start)} → {fmtUtcTime(s.window.end)} UTC ({s.window.session})
      </dd>
      <dt>Executed volume</dt>
      <dd>{fmtNum(s.volume)}</dd>
      <dt>{sourceText(view.status, false).buySell}</dt>
      <dd>
        <span className="bid">{fmtNum(s.buy)}</span> / <span className="ask">{fmtNum(s.sell)}</span>
      </dd>
      <dt>Unknown side</dt>
      <dd>
        {fmtNum(s.unknown)} ({(s.unknownShare * 100).toFixed(1)} %)
      </dd>
      <dt>Session delta</dt>
      <dd className={s.delta >= 0 ? 'bid' : 'ask'}>{fmtSigned(s.delta)}{s.unknown > 0 ? ' (partial)' : ''}</dd>
      <dt>Prints</dt>
      <dd>{fmtNum(s.trades)}</dd>
      <dt>Late prints excluded</dt>
      <dd>{s.lateExcluded}</dd>
      <dt>Data gaps</dt>
      <dd>{s.gaps}</dd>
      <dt>Depth events / heat columns</dt>
      <dd>
        {fmtNum(s.depthEvents)} / {s.heatColumns}
      </dd>
    </dl>
  );
}

const capTone = (c: CapabilityState) => (c === 'AVAILABLE' ? 'ok' : c === 'DEMO' || c === 'UNVERIFIED' ? 'warn' : 'bad');

export function DiagnosticsPanel({ view, demo, onLinkChange }: { view: OfpView; demo: boolean; onLinkChange: () => void }) {
  const st = view.status;
  const fl = feedLabel(st);
  const [link, setLink] = useState<OfpLinkConfig>(() => loadOfpLink());
  const [saved, setSaved] = useState(false);
  const urlOk = isLoopbackUrl(link.backendUrl);
  return (
    <div className="ofp-diag ofp-scroll">
      <dl className="ofp-kv">
        <dt>Feed</dt>
        <dd className={`tone-${fl.tone}`}>
          {fl.text} — {fl.detail}
        </dd>
        <dt>Market data type</dt>
        <dd>{st.marketDataType ?? 'not reported'}</dd>
        <dt>Contract</dt>
        <dd>
          {st.contract
            ? st.provenance
              ? `${st.contract.localSymbol} · ${st.contract.exchange} · class ${st.contract.tradingClass} · ×${st.contract.multiplier} · contract month ${st.contract.expiry.slice(0, 4)}-${st.contract.expiry.slice(4, 6)} · ${st.contract.verified ? 'MATCHED: Databento trades = IBKR depth' : 'trades only - IBKR depth not matched'}`
              : `${st.contract.localSymbol} · ${st.contract.exchange} · class ${st.contract.tradingClass} · ×${st.contract.multiplier} · expiry ${fmtExpiry(st.contract.expiry)} · conId ${st.contract.conId ?? '—'} · ${st.contract.verified ? 'VERIFIED (reqContractDetails)' : 'NOT VERIFIED'}`
            : 'none'}
        </dd>
        <dt>Depth rows granted</dt>
        <dd>{st.depthRows || '—'}</dd>
        {(['depth', 'trades', 'aggressor', 'historicalBars'] as const).map((k) => (
          <FragmentKV key={k} k={k === 'aggressor' ? sourceText(st, demo).aggressorCap : k === 'historicalBars' ? 'Historical bars' : k[0]!.toUpperCase() + k.slice(1)} v={st.capabilities[k]} />
        ))}
        {st.health && (
          <>
            <dt>Connection</dt>
            <dd>
              {st.health.connection} · account {st.health.accountVerified ? 'verified' : 'NOT verified'} · heartbeat {st.health.heartbeatAgeMs !== null ? `${Math.round(st.health.heartbeatAgeMs / 1000)} s ago` : '—'} · IBKR link {st.health.ibkrLink}
            </dd>
            <dt>Subscriptions</dt>
            <dd>
              quotes {st.health.streams.mkt} · depth {st.health.streams.depth} · trades {st.health.streams.trades} · bars {st.health.streams.hist}
              {st.health.depthPacing.pending ? ` · depth re-subscription waiting (back-off ${st.health.depthPacing.backoffS} s)` : ''}
              {st.health.depthPacing.suspended ? ` · depth SUSPENDED: ${st.health.depthPacing.suspended}` : ''}
            </dd>
            {(['quotes', 'depth'] as const).map((k) => {
              const f = st.health![k];
              return f ? (
                <FragmentText key={k} k={k === 'quotes' ? 'Quote freshness' : 'Depth freshness'} v={f.state === 'NONE' ? 'no message yet' : `${f.state} · last message ${((f.ageMs ?? 0) / 1000).toFixed(1)} s ago`} />
              ) : null;
            })}
            {st.health.trades && (
              <FragmentText k="Trade activity" v={st.health.trades.activity === null ? 'no print yet' : `${st.health.trades.activity} · last print ${((st.health.trades.ageMs ?? 0) / 1000).toFixed(1)} s ago`} />
            )}
            <dt>Overall data activity</dt>
            <dd>{st.health.activity === null ? '—' : st.health.activity === 'QUIET' ? `QUIET for ${Math.round((st.health.quietForMs ?? 0) / 1000)} s (not a gap)` : 'ACTIVE'}</dd>
            {st.health.gaps && (
              <FragmentText
                k="Recording gaps"
                v={`${st.health.gaps.count}${st.health.gaps.last ? ` · last: ${st.health.gaps.last.reason}` : ''}${st.health.gaps.recorderDropped ? ` · recorder dropped ${st.health.gaps.recorderDropped}` : ''}`}
              />
            )}
            <dt>Schedule</dt>
            <dd>{st.health.schedule.replace('_', ' ').toLowerCase()} (CME Globex schedule only, not exchange status)</dd>
          </>
        )}
        {st.classification && (
          <>
            <dt>Side classification</dt>
            <dd>
              {st.classification.method === 'EXCHANGE'
                ? 'EXCHANGE-REPORTED aggressor (CME via Databento; N → UNKNOWN, never inferred)'
                : `INFERRED (quote rule vs ${st.classification.touchSource ?? '—'} touch, max quote age ${st.classification.maxQuoteAgeMs ?? '—'} ms)`}{' '}
              · UNKNOWN volume{' '}
              {st.classification.unknownVolumePct === null ? '—' : `${st.classification.unknownVolumePct}%`}
              {st.classification.unknownVolumeByReason && Object.keys(st.classification.unknownVolumeByReason).length
                ? ` (${Object.entries(st.classification.unknownVolumeByReason)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(', ')})`
                : ''}{' '}
              ·{' '}
              {Object.entries(st.classification.reasons)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${k} ${n}`)
                .join(' · ') || 'no prints yet'}
            </dd>
          </>
        )}
        <dt>Engine memory</dt>
        <dd>
          bars {view.bars.length} · heat columns {view.stats.heatColumns} · gaps {view.gaps.length} · depth ignored while invalid {view.stats.ignoredDepthWhileInvalid}
        </dd>
      </dl>
      {st.provenance && <ProvenanceBlock st={st} />}
      <p className="ofp-note">{sourceText(st, demo).depthLimits}</p>
      <p className="ofp-note">{sourceText(st, demo).classification}</p>
      <p className="ofp-note">Read-only: this page and its backend have no order, account or position functions. Scores are evidence scores, not probabilities.</p>
      {st.diagnostics.length > 0 && (
        <ul className="ofp-diag__list">
          {st.diagnostics.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      {!demo && OFP_BACKEND_AVAILABLE && (
        <form
          className="ofp-link"
          onSubmit={(e) => {
            e.preventDefault();
            if (!urlOk) return;
            saveOfpLink(link);
            setSaved(true);
            onLinkChange();
          }}
        >
          <b>Backend link (this browser only)</b>
          <label className="ofp-check">
            <input type="checkbox" checked={link.enabled} onChange={(e) => (setLink({ ...link, enabled: e.target.checked }), setSaved(false))} /> Enabled
          </label>
          <label>
            URL (loopback only)
            <input value={link.backendUrl} onChange={(e) => (setLink({ ...link, backendUrl: e.target.value }), setSaved(false))} aria-invalid={!urlOk} />
          </label>
          <label>
            Token
            <input type="password" autoComplete="off" value={link.token} onChange={(e) => (setLink({ ...link, token: e.target.value }), setSaved(false))} />
          </label>
          <button type="submit" className="ofp-btn" disabled={!urlOk}>
            Save
          </button>
          <button type="button" className="ofp-btn ofp-btn--ghost" onClick={() => setLink({ ...DEFAULT_OFP_LINK })}>
            Defaults
          </button>
          {saved && <span className="ok">Saved</span>}
          {!urlOk && <span className="ask">Only 127.0.0.1 / localhost URLs are accepted</span>}
        </form>
      )}
    </div>
  );
}

function FragmentText({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function FragmentKV({ k, v }: { k: string; v: CapabilityState }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className={`tone-${capTone(v)}`}>{v}</dd>
    </>
  );
}

export function SessionVpPanel({ view, precision }: { view: OfpView; precision: number }) {
  const p = view.stats.profile;
  const tick = view.recorder.tick;
  const f = (k: number | null) => (k === null ? '—' : (k * tick).toFixed(precision));
  return (
    <div className="ofp-svp">
      <dl className="ofp-kv ofp-kv--tight">
        <dt className="poc">POC</dt>
        <dd className="poc">{f(p.poc)}</dd>
        <dt className="va">VAH</dt>
        <dd className="va">{f(p.vah)}</dd>
        <dt className="va">VAL</dt>
        <dd className="va">{f(p.val)}</dd>
        <dt>Value Area</dt>
        <dd>70%</dd>
        <dt>Total Volume</dt>
        <dd>{p.total.toLocaleString('en-US')}</dd>
        <dt>Range High</dt>
        <dd>{f(p.high)}</dd>
        <dt>Range Low</dt>
        <dd>{f(p.low)}</dd>
      </dl>
      <div className="ofp-vpmini">
        <ProfileMini profile={p} version={view.version} />
      </div>
    </div>
  );
}

const fmtAge = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);
const TIME_BASIS: Record<StreamProvenance['timeBasis'], string> = { EXCHANGE_EVENT: 'exchange event time', VPS_DEPTH_UPDATE: 'VPS depth-service update time', BAR_OPEN: 'bar open time' };

/** Gateway source: independent state + freshness of every upstream stream, and the data-quality counters. */
function ProvenanceBlock({ st }: { st: SourceStatus }) {
  const p = st.provenance!;
  const q = p.quality;
  const rows: Array<[string, StreamProvenance]> = [
    ['Trades', p.trades],
    ['Depth', p.depth],
    ['Bars', p.bars],
  ];
  return (
    <dl className="ofp-kv" data-testid="ofp-provenance">
      {rows.map(([k, s]) => (
        <FragmentText
          key={k}
          k={`${k} source`}
          v={`${s.state.replace('_', ' ')} · ${s.provider} · contract ${s.contract ?? '—'} · ${TIME_BASIS[s.timeBasis]}${s.lastMs !== null ? ` · last ${fmtUtcTime(s.lastMs, true)} UTC (${fmtAge(s.ageMs)} ago)` : ''}${s.detail ? ` · ${s.detail}` : ''}`}
        />
      ))}
      <FragmentText k="Aggressor source" v={p.aggressor === 'EXCHANGE' ? 'exchange-reported (CME via Databento)' : 'none'} />
      <FragmentText
        k="Data quality"
        v={`trades accepted ${q.tradesAccepted} · duplicate ${q.tradesDuplicate} · rejected ${q.tradesRejected} · out of order ${q.tradesOutOfOrder} · unknown side ${q.unknownSide} · depth changes ${q.depthChanges} · resyncs ${q.depthResyncs} · sequence gaps ${q.depthSeqGaps} · depth rejected ${q.depthRejected} · gaps ${q.gaps} · request errors ${q.requestErrors} · rate-limited ${q.rateLimited}`}
      />
      <FragmentText k="Gateway requests" v={`${p.requests} GET since subscription (read-only)`} />
    </dl>
  );
}
