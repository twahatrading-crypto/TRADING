import { AlertTriangle, BellRing, CalendarDays, Clock3, FileSearch, Grid3x3, Radio, ShieldAlert, Unplug, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { COLUMN_CATEGORIES, SCHEDULED_WINDOWS } from '../../engines/news/config';
import { countdown } from '../../engines/news/time';
import type { Aggregate, InstrumentRisk, MatrixColumn, MatrixRow, NewsAlert, NewsEventView, ReactionResult } from '../../engines/news/types';
import type { NewsAnalysisState, NewsFeedView } from '../../services/newsAnalysis/NewsAnalysisService';
import { formatPrice } from '../../utils/format';
import { CURRENCY_FILTERS, RISK_LABEL, STATUS_LABEL, arrow, filterCalendar, localTz, riskTone, surpriseText, times, timelineOf, tone, type CurrencyFilter, type ImpactFilter, type RangeFilter } from './newsView';

export function Panel({ title, icon, right, children, testId, className }: { title: string; icon: ReactNode; right?: ReactNode; children: ReactNode; testId?: string; className?: string }) {
  return (
    <section className={`panel nwpanel ${className ?? ''}`} data-testid={testId} aria-label={title}>
      <div className="nwpanel__head">
        <h2>
          {icon} {title}
        </h2>
        {right}
      </div>
      <div className="nwpanel__body">{children}</div>
    </section>
  );
}
export const Tag = ({ v, t }: { v: string; t?: string }) => <span className={`nwtag nwtag--${t ?? tone(v)}`}>{v}</span>;
const Unavailable = ({ title, detail }: { title: string; detail?: string | null }) => (
  <div className="nwna" role="status">
    <Unplug size={16} aria-hidden="true" />
    <strong>{title}</strong>
    {detail && <span>{detail}</span>}
  </div>
);
const impactTag = (i: string) => <Tag v={i} t={i === 'HIGH' ? 'bear' : i === 'MEDIUM' ? 'warn' : 'muted'} />;
const statusTag = (e: NewsEventView) => <Tag v={STATUS_LABEL[e.status]} t={e.status === 'LIVE' ? 'bear' : e.status === 'PRE_NEWS' || e.status === 'POST_NEWS' || e.status === 'STALE' ? 'warn' : e.status === 'RELEASED' ? 'bull' : e.status === 'CANCELLED' ? 'muted' : 'info'} />;
const feedTag = (f: NewsFeedView) => <Tag v={f.status.replace('_', ' ')} t={f.status === 'LIVE' ? 'bull' : f.status === 'DELAYED' || f.status === 'STALE' || f.status === 'CONNECTING' ? 'warn' : f.status === 'NOT_CONNECTED' ? 'muted' : 'bear'} />;
const cd = (ms: number) => {
  const c = countdown(ms);
  return `${c.negative ? '−' : ''}${c.days ? `${c.days}d ` : ''}${c.hours}h ${String(c.minutes).padStart(2, '0')}m ${String(c.seconds).padStart(2, '0')}s`;
};
const surpriseClass = (e: NewsEventView) => {
  const i = e.surprise?.interpretation;
  return i === 'HOTTER' || i === 'STRONGER' || i === 'HAWKISH' ? 'nwup' : i === 'COOLER' || i === 'WEAKER' || i === 'DOVISH' ? 'nwdown' : '';
};
const when = (ms: number | null) => (ms === null ? '—' : `${times(ms).denver.date} ${times(ms).denver.time} ${times(ms).denver.zone}`);

/* ------------------------------- summary ------------------------------- */

export function SummaryCards({ st }: { st: NewsAnalysisState }) {
  const s = st.snapshot;
  const n = s.nextHigh;
  const risk = s.risk['XAUUSD'];
  const noCal = !st.feeds.calendar.provider;
  const noNews = !st.feeds.breaking.provider && !st.feeds.macro.provider;
  const c = n?.scheduledAt ? countdown(n.scheduledAt - st.now) : null;
  const card = (k: string, body: ReactNode, testId?: string) => (
    <div className="panel nwcard" data-testid={testId}>
      <span className="nwcard__k">{k}</span>
      {body}
    </div>
  );
  return (
    <div className="nwcards" data-testid="nw-cards">
      {card(
        'Next high-impact event',
        noCal ? <Tag v="ECONOMIC CALENDAR UNAVAILABLE" t="muted" /> : n ? (
          <>
            <strong>{n.title}</strong>
            <span className="nwcard__sub">{n.currency ?? n.country ?? ''} · {when(n.scheduledAt)} {impactTag(n.impact)}</span>
          </>
        ) : <span className="nwcard__sub">No upcoming HIGH-impact event in the calendar data.</span>,
        'nw-next-card',
      )}
      {card(
        'Countdown',
        c && !c.negative ? (
          <div className="nwcount" data-testid="nw-countdown">
            {[['DAYS', c.days], ['HOURS', c.hours], ['MIN', c.minutes], ['SEC', c.seconds]].map(([l, v]) => (
              <div key={l as string}><b className="num">{String(v).padStart(2, '0')}</b><span>{l}</span></div>
            ))}
          </div>
        ) : n ? <strong className="nwwarn">{STATUS_LABEL[n.status]}</strong> : <span className="nwcard__sub">—</span>,
      )}
      {card('Current news risk · XAUUSD', <><Tag v={RISK_LABEL[risk?.state ?? 'NORMAL']} t={riskTone(risk?.state ?? 'NORMAL')} /><span className="nwcard__sub">{noCal && noNews ? 'NEWS DATA UNAVAILABLE — risk cannot be assessed' : risk?.reasons[0]?.text ?? 'No HIGH-impact window active.'}</span></>, 'nw-risk-card')}
      {card('USD macro bias', noCal && noNews ? <Tag v="NEWS DATA UNAVAILABLE" t="muted" /> : <><Tag v={s.aggregates.USD.state} /><span className="nwcard__sub">{s.aggregates.USD.evidence}</span></>, 'nw-usd-card')}
      {card('Gold news pressure', noCal && noNews ? <Tag v="NEWS DATA UNAVAILABLE" t="muted" /> : <><Tag v={s.aggregates.GOLD.state} /><span className="nwcard__sub">{s.aggregates.GOLD.evidence}</span></>, 'nw-gold-card')}
      {card('Breaking news status', <>{feedTag(st.feeds.breaking)}<span className="nwcard__sub">{st.feeds.breaking.name ?? st.feeds.breaking.detail}{st.feeds.breaking.latency === 'DELAYED' ? ` · delayed ${st.feeds.breaking.delaySec ?? '?'} s` : ''}</span></>, 'nw-breaking-card')}
    </div>
  );
}

/* ------------------------------- calendar ------------------------------ */

function Seg<T extends string>({ list, value, onChange, label }: { list: readonly T[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="nwseg" role="group" aria-label={label}>
      {list.map((x) => (
        <button key={x} type="button" aria-pressed={value === x} onClick={() => onChange(x)}>
          {x === 'WEEK' ? 'This Week' : x === 'TODAY' ? 'Today' : x === 'TOMORROW' ? 'Tomorrow' : x === 'ALL' ? 'All' : x}
        </button>
      ))}
    </div>
  );
}

export function CalendarPanel({ st, onSelect, selected }: { st: NewsAnalysisState; onSelect: (k: string) => void; selected: string | null }) {
  const [range, setRange] = useState<RangeFilter>('WEEK');
  const [impact, setImpact] = useState<ImpactFilter>('ALL');
  const [ccy, setCcy] = useState<CurrencyFilter>('ALL');
  const tz = localTz();
  const rows = useMemo(() => filterCalendar(st.snapshot.calendar, { range, impact, currency: ccy, now: st.now, tz }), [st.snapshot.calendar, range, impact, ccy, st.now, tz]);
  const feed = st.feeds.calendar;
  return (
    <Panel
      title="Economic Calendar"
      icon={<CalendarDays size={15} />}
      testId="nw-calendar"
      className="nwcal"
      right={
        <div className="nwfilters">
          <Seg list={['TODAY', 'TOMORROW', 'WEEK', 'ALL'] as const} value={range} onChange={setRange} label="Date range" />
          <Seg list={['ALL', 'HIGH', 'MEDIUM', 'LOW'] as const} value={impact} onChange={setImpact} label="Impact" />
          <Seg list={CURRENCY_FILTERS} value={ccy} onChange={setCcy} label="Currency" />
        </div>
      }
    >
      {!feed.provider ? (
        <Unavailable title="ECONOMIC CALENDAR UNAVAILABLE" detail="No economic-calendar provider is configured. No events, values or times are ever invented." />
      ) : (
        <>
          <div className="nwfeedline">{feed.name} · {feedTag(feed)} {feed.latency && <span className="nwdim">{feed.latency}{feed.delaySec ? ` ${feed.delaySec}s` : ''}</span>} {feed.detail && <span className="nwdim">{feed.detail}</span>}</div>
          {!rows.length ? (
            <p className="nwempty">No calendar events for this filter.</p>
          ) : (
            <div className="nwtable-wrap">
              <table className="nwtable">
                <thead>
                  <tr>{['Time', 'Country', 'Event', 'Impact', 'Actual', 'Forecast', 'Previous', 'Surprise', 'Status'].map((h) => <th key={h}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map((e) => {
                    const t = times(e.scheduledAt!, tz);
                    return (
                      <tr key={e.key} className={selected === e.key ? 'is-sel' : ''} onClick={() => onSelect(e.key)} tabIndex={0} onKeyDown={(k) => k.key === 'Enter' && onSelect(e.key)} data-testid="nw-cal-row">
                        <td className="num"><b>{t.local.time}</b><span className="nwdim"> {t.local.date}</span></td>
                        <td>{e.country ?? '—'} <span className="nwdim">{e.currency ?? ''}</span></td>
                        <td>{e.title}{e.revisions.length ? <span className="nwdim"> (revised)</span> : null}</td>
                        <td>{impactTag(e.impact)}</td>
                        <td className="num">{e.actual?.raw ?? '—'}</td>
                        <td className="num">{e.forecast?.raw ?? '—'}</td>
                        <td className="num">{e.previous?.raw ?? '—'}</td>
                        <td className={`num ${surpriseClass(e)}`}>{surpriseText(e)}</td>
                        <td>{statusTag(e)}{e.status === 'UPCOMING' || e.status === 'PRE_NEWS' ? <span className="nwdim num"> {cd(e.scheduledAt! - st.now)}</span> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="nwnote">Times in your local zone ({tz}); Denver and UTC in the event detail. Impact: provider value, else the documented rule.</p>
        </>
      )}
    </Panel>
  );
}

/* ------------------------------ next event ------------------------------ */

export function NextEventPanel({ st, reaction, onSelect }: { st: NewsAnalysisState; reaction: ReactionResult | null; onSelect: (k: string) => void }) {
  const e = st.snapshot.nextHigh;
  if (!st.feeds.calendar.provider) return <Panel title="Next Event" icon={<Clock3 size={15} />} testId="nw-next"><Unavailable title="ECONOMIC CALENDAR UNAVAILABLE" /></Panel>;
  if (!e) return <Panel title="Next Event" icon={<Clock3 size={15} />} testId="nw-next"><p className="nwempty">No upcoming HIGH-impact event in the calendar data.</p></Panel>;
  const t = times(e.scheduledAt!);
  const w = SCHEDULED_WINDOWS[e.impact];
  const released = e.scheduledAt! <= st.now;
  return (
    <Panel title="Next Event Details" icon={<Clock3 size={15} />} testId="nw-next" right={<button type="button" className="nwbtn" onClick={() => onSelect(e.key)}>Detail</button>}>
      <div className="nwnext__title"><strong>{e.title}</strong>{impactTag(e.impact)}{statusTag(e)}</div>
      <dl className="nwkv">
        <div><dt>Local</dt><dd>{t.local.date} {t.local.time} {t.local.zone}</dd></div>
        <div><dt>Denver</dt><dd>{t.denver.date} {t.denver.time} {t.denver.zone}</dd></div>
        <div><dt>UTC</dt><dd>{t.utc.date} {t.utc.time}</dd></div>
        <div><dt>{released ? 'Since release' : 'Countdown'}</dt><dd className="num">{cd(e.scheduledAt! - st.now)}</dd></div>
        <div><dt>Forecast</dt><dd className="num">{e.forecast?.raw ?? '—'}</dd></div>
        <div><dt>Previous</dt><dd className="num">{e.previous?.raw ?? '—'}</dd></div>
        {released && <div><dt>Actual</dt><dd className="num">{e.actual?.raw ?? '—'}</dd></div>}
        {released && <div><dt>Surprise</dt><dd>{e.surprise?.vsForecast ?? '—'}{e.surprise?.interpretation ? ` · ${e.surprise.interpretation.replace('_', ' ')}` : ''}</dd></div>}
      </dl>
      <div className="nwassets">{e.affected.map((a) => <span key={a}>{a}</span>)}</div>
      <p className="nwnote">Risk window: pre {w.preMs / 60000} min · live {w.liveMs / 60000} min · post-news to {w.postMs / 60000} min.</p>
      {released && <p className="nwnote">Initial interpretation (expected, not observed): USD {e.implications.USD.state.toLowerCase()}, gold {e.implications.GOLD.state.toLowerCase()}. Observed: {reaction ? (reaction.status === 'UNAVAILABLE' ? reaction.reason : `${reaction.horizons.filter((h) => h.state === 'OK').map((h) => `+${h.minutes}m ${h.change! >= 0 ? '+' : ''}${h.change!.toFixed(2)}`).join(' · ') || 'pending'}`) : '—'}</p>}
    </Panel>
  );
}

/* ---------------------------- breaking feed ---------------------------- */

export function BreakingPanel({ st, onSelect }: { st: NewsAnalysisState; onSelect: (k: string) => void }) {
  const hasFeed = !!st.feeds.breaking.provider || !!st.feeds.macro.provider;
  const rows = st.snapshot.headlines.slice(0, 40);
  return (
    <Panel title="Breaking News Feed" icon={<Radio size={15} />} testId="nw-breaking" right={feedTag(st.feeds.breaking.provider ? st.feeds.breaking : st.feeds.macro)}>
      {!hasFeed ? (
        <Unavailable title="BREAKING NEWS UNAVAILABLE" detail="No breaking-news or macro-news provider is configured. Headlines are never invented." />
      ) : !rows.length ? (
        <p className="nwempty">No headlines received.</p>
      ) : (
        <div className="nwtable-wrap">
          <table className="nwtable">
            <thead><tr>{['Time', 'Headline', 'Category', 'Impact', 'Assets', 'Status', 'Source'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.key} onClick={() => onSelect(h.key)} data-testid="nw-headline-row">
                  <td className="num">{times(h.publishedAt!).local.time}</td>
                  <td className="nwheadline">{h.title}</td>
                  <td>{h.category.replace('_', ' ')}</td>
                  <td>{impactTag(h.impact)}</td>
                  <td className="nwdim">{h.affected.slice(0, 4).join(' ')}{h.affected.length > 4 ? ' …' : ''}</td>
                  <td>{statusTag(h)}</td>
                  <td>{h.sourceUrl ? <a href={h.sourceUrl} target="_blank" rel="noreferrer noopener">{h.provider}</a> : h.provider}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* --------------------------- XAUUSD analysis --------------------------- */

export function XauPanel({ st, reaction, reactionEvent }: { st: NewsAnalysisState; reaction: ReactionResult | null; reactionEvent: NewsEventView | null }) {
  const s = st.snapshot;
  const none = !st.feeds.calendar.provider && !st.feeds.breaking.provider && !st.feeds.macro.provider;
  const risk = s.risk['XAUUSD']!;
  const nextX = s.calendar.find((e) => !e.duplicateOf && e.impact === 'HIGH' && e.affected.includes('XAUUSD') && (e.scheduledAt ?? 0) > st.now);
  const row = (k: string, a: Aggregate | null, extra?: string) => (
    <div className="nwxau__row" key={k}>
      <span>{k}</span>
      <span title={a?.evidence}>{a ? <Tag v={a.state} /> : '—'}{extra ? <span className="nwdim"> {extra}</span> : null}</span>
    </div>
  );
  return (
    <Panel title="XAUUSD News Analysis" icon={<FileSearch size={15} />} testId="nw-xau">
      {none ? (
        <Unavailable title="NEWS DATA UNAVAILABLE" />
      ) : (
        <>
          {row('Current news pressure', s.aggregates.GOLD)}
          {row('USD driver', s.aggregates.USD)}
          {row('Yield / rates driver', s.aggregates.RATES)}
          {row('Risk-off / risk-on driver', s.byGroup.geopolitical.GOLD)}
          {row('Gold-specific driver', null, s.headlines.some((h) => h.category === 'METALS' && h.status !== 'RELEASED') ? 'recent metals headline — direction not inferred' : 'none')}
          <div className="nwxau__row"><span>Conflicts</span><span>{s.aggregates.GOLD.conflict ? <Tag v="CONFLICTING DRIVERS" t="warn" /> : 'none'}</span></div>
          <div className="nwxau__row"><span>Upcoming risk</span><span><Tag v={RISK_LABEL[risk.state]} t={riskTone(risk.state)} /> <span className="nwdim">{nextX ? `${nextX.title} in ${cd(nextX.scheduledAt! - st.now)}` : 'no HIGH event ahead'}</span></span></div>
          <div className="nwxau__row">
            <span>Observed price reaction</span>
            <span className="nwdim">
              {st.instrumentId !== 'XAUUSD' ? 'REACTION DATA UNAVAILABLE — select XAUUSD to measure it from MT5' : !reaction || !reactionEvent ? 'no released event selected' : reaction.status === 'UNAVAILABLE' ? reaction.reason : `${reactionEvent.title}: ${reaction.horizons.filter((h) => h.state === 'OK').map((h) => `+${h.minutes}m ${h.change! >= 0 ? '+' : ''}${h.change!.toFixed(2)}`).join(' · ') || 'pending'}`}
            </span>
          </div>
          <p className="nwnote">Expected macro effects (rule-based) — not observed reactions and not trade signals.</p>
        </>
      )}
    </Panel>
  );
}

/* ---------------------------- impact matrix ---------------------------- */

const COLS: [MatrixColumn, string][] = [['macro', 'Macro'], ['rates', 'Rates'], ['inflation', 'Inflation'], ['employment', 'Employment'], ['geopolitical', 'Geopolitical'], ['current', 'Current']];
export function MatrixPanel({ rows, none }: { rows: MatrixRow[]; none: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel title="Market Impact Matrix" icon={<Grid3x3 size={15} />} testId="nw-matrix">
      {none ? (
        <Unavailable title="NEWS DATA UNAVAILABLE" />
      ) : (
        <>
          <div className="nwtable-wrap">
            <table className="nwtable nwmatrix">
              <thead><tr><th>Asset</th>{COLS.map(([, l]) => <th key={l}>{l}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.asset}>
                    <td><button type="button" className="nwlink" onClick={() => setOpen(open === r.asset ? null : r.asset)} aria-expanded={open === r.asset} title="Show evidence">{r.asset}</button></td>
                    {COLS.map(([c]) => (
                      <td key={c} title={r.cells[c].evidence} className={`nw${tone(r.cells[c].state)}`}>{c === 'current' ? <Tag v={r.cells[c].state} /> : arrow(r.cells[c].state)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {open && (
            <ul className="nwdrivers" data-testid="nw-matrix-evidence">
              {rows.find((r) => r.asset === open)!.cells.current.drivers.map((d) => <li key={d.eventKey}><Tag v={d.state} /> <b>{d.title}</b> — {d.evidence}</li>)}
              {!rows.find((r) => r.asset === open)!.cells.current.drivers.length && <li>No qualifying HIGH / MEDIUM driver in the last 24 h.</li>}
            </ul>
          )}
          <p className="nwnote">Click an asset for its evidence. ▲ bullish pressure · ▼ bearish pressure · ◆ mixed / conflicting · – neutral. Columns group drivers: {Object.entries(COLUMN_CATEGORIES).map(([k, v]) => `${k} = ${v.join('/').toLowerCase().replace(/_/g, ' ')}`).join('; ')}. Contextual pressure, not trade signals.</p>
        </>
      )}
    </Panel>
  );
}

/* ------------------------------ risk / alerts ------------------------------ */

export function RiskPanel({ risk, assets }: { risk: Record<string, InstrumentRisk>; assets: string[] }) {
  return (
    <Panel title="News-Risk Windows" icon={<ShieldAlert size={15} />} testId="nw-riskpanel">
      <ul className="nwrisk">
        {assets.map((a) => {
          const r = risk[a];
          if (!r) return null;
          return (
            <li key={a}>
              <b>{a}</b> <Tag v={RISK_LABEL[r.state]} t={riskTone(r.state)} />
              {r.until && <span className="nwdim num"> until {times(r.until).local.time}</span>}
              {r.reasons.map((x) => <div key={`${x.eventKey}:${x.state}`} className="nwdim">{x.text} ({times(x.from).local.time}–{times(x.to).local.time})</div>)}
            </li>
          );
        })}
      </ul>
      <p className="nwnote">HIGH-impact windows: pre-news 30 min · news live 15 min · post-news to 90 min (headlines: live 15, post to 60). Exposed read-only for other engines — trading is never blocked here.</p>
    </Panel>
  );
}

export function AlertsPanel({ alerts, suppressed }: { alerts: NewsAlert[]; suppressed: number }) {
  return (
    <Panel title="News Alerts" icon={<BellRing size={15} />} testId="nw-alerts">
      {!alerts.length ? <p className="nwempty">No live alerts raised.</p> : (
        <ul className="nwalerts">{alerts.map((a) => <li key={a.id} data-testid="nw-alert"><span className="num nwdim">{times(a.raisedAt).local.time}</span> {a.message}</li>)}</ul>
      )}
      <p className="nwnote">One alert per event and type, ever; recovered / late history never alerts ({suppressed} suppressed). In-app only — email is not configured.</p>
    </Panel>
  );
}

export function ProvidersPanel({ st }: { st: NewsAnalysisState }) {
  return (
    <Panel title="News Data Providers" icon={<AlertTriangle size={15} />} testId="nw-providers">
      <ul className="nwprov">
        {(['calendar', 'breaking', 'macro'] as const).map((k) => {
          const f = st.feeds[k];
          return (
            <li key={k}>
              <b>{k === 'calendar' ? 'Economic calendar' : k === 'breaking' ? 'Breaking news' : 'Macro news'}</b> {feedTag(f)}
              <div className="nwdim">{f.provider ? `${f.name} · ${f.latency}${f.delaySec ? ` (${f.delaySec}s delay)` : ''}${f.test ? ' · TEST DATA' : ''}` : f.detail}</div>
            </li>
          );
        })}
      </ul>
      <p className="nwnote">{st.updates} updates received · {st.duplicatesDropped} duplicate deliveries dropped · {st.snapshot.duplicates} cross-provider duplicates linked.</p>
    </Panel>
  );
}

/* ------------------------------ event detail ------------------------------ */

export function EventDetail({ e, reaction, now, onClose }: { e: NewsEventView; reaction: ReactionResult | null; now: number; onClose: () => void }) {
  const t0 = e.kind === 'SCHEDULED' ? e.scheduledAt! : e.publishedAt!;
  const t = times(t0);
  const steps = timelineOf(e, reaction, now);
  return (
    <Panel title="Event Detail" icon={<FileSearch size={15} />} testId="nw-detail" className="nwdetail" right={<button type="button" className="nwbtn" onClick={onClose} aria-label="Close event detail"><X size={13} /></button>}>
      <div className="nwnext__title"><strong>{e.title}</strong>{impactTag(e.impact)}{statusTag(e)}</div>
      <dl className="nwkv">
        <div><dt>Provider / source</dt><dd>{e.provider}{e.sourceUrl ? <> · <a href={e.sourceUrl} target="_blank" rel="noreferrer noopener">source</a></> : ''}</dd></div>
        <div><dt>{e.kind === 'SCHEDULED' ? 'Release' : 'Published'} (local)</dt><dd>{t.local.date} {t.local.time} {t.local.zone}</dd></div>
        <div><dt>Denver</dt><dd>{t.denver.time} {t.denver.zone}</dd></div>
        <div><dt>UTC</dt><dd>{t.utc.date} {t.utc.time}</dd></div>
        <div><dt>Impact</dt><dd>{e.impact} <span className="nwdim">({e.impactRule})</span></dd></div>
        {e.kind === 'SCHEDULED' && (
          <>
            <div><dt>Actual</dt><dd className="num">{e.actual?.raw ?? '—'}</dd></div>
            <div><dt>Forecast</dt><dd className="num">{e.forecast?.raw ?? '—'}</dd></div>
            <div><dt>Previous</dt><dd className="num">{e.previous?.raw ?? '—'}</dd></div>
            <div><dt>Revision</dt><dd>{e.revisions.length ? e.revisions.map((r) => `${r.field} ${r.original.raw} → ${r.revised.raw} (${times(r.revisedAt).local.date} ${times(r.revisedAt).local.time})`).join('; ') : '—'}</dd></div>
            <div><dt>Surprise</dt><dd>{e.surprise ? `${e.surprise.vsForecast} · ${e.surprise.vsPrevious}${e.surprise.interpretation ? ` · ${e.surprise.interpretation.replace('_', ' ')}` : ''}` : '—'}</dd></div>
          </>
        )}
        <div><dt>Affected</dt><dd>{e.affected.join(', ')}</dd></div>
        <div><dt>Freshness</dt><dd>{e.latency} · last update {times(e.lastKnownAt).local.time} · {e.updates} update(s)</dd></div>
      </dl>
      <h3 className="nwh3">Expected macro mechanism (rule-based)</h3>
      <ul className="nwdrivers">{(Object.entries(e.implications) as [string, { state: string; evidence: string }][]).map(([k, v]) => <li key={k}><Tag v={v.state} /> <b>{k}</b> — {v.evidence}</li>)}</ul>
      <h3 className="nwh3">Observed market reaction {reaction ? `· ${reaction.instrumentId}` : ''}</h3>
      {!reaction || reaction.status === 'UNAVAILABLE' ? (
        <p className="nwnote nwwarn" data-testid="nw-reaction-na">{reaction?.reason ?? 'REACTION DATA UNAVAILABLE'}</p>
      ) : (
        <dl className="nwkv" data-testid="nw-reaction">
          <div><dt>Pre-event price</dt><dd className="num">{reaction.prePrice === null ? '—' : formatPrice(reaction.prePrice, 2)}</dd></div>
          {reaction.horizons.map((h) => <div key={h.minutes}><dt>+{h.minutes} min</dt><dd className="num">{h.state === 'OK' ? `${h.change! >= 0 ? '+' : ''}${h.change!.toFixed(2)} (${h.changePct!.toFixed(3)}%)` : h.state}</dd></div>)}
          <div><dt>Max up / down (60 min)</dt><dd className="num">{reaction.maxUp?.toFixed(2) ?? '—'} / {reaction.maxDown?.toFixed(2) ?? '—'}</dd></div>
          <div><dt>Volatility expansion</dt><dd className="num">{reaction.volExpansion ? `${reaction.volExpansion.toFixed(2)}×` : '—'}</dd></div>
          <div><dt>Displacement</dt><dd className="num">{reaction.displacementAtr ? `${reaction.displacementAtr.toFixed(2)} ATR` : '—'}</dd></div>
          <div><dt>Pattern</dt><dd>{reaction.pattern ?? '—'}{reaction.retracePct !== null ? ` · retrace ${reaction.retracePct.toFixed(0)}%` : ''}</dd></div>
        </dl>
      )}
      <h3 className="nwh3">News timeline</h3>
      <ol className="nwtimeline" data-testid="nw-timeline">
        {steps.map((s, i) => (
          <li key={i} className={s.done ? 'is-done' : ''}><span className="num">{s.time === null ? '—' : times(s.time).local.time}</span> {s.label}{s.detail ? <span className="nwdim"> · {s.detail}</span> : null}</li>
        ))}
      </ol>
      <details className="nwraw"><summary>Raw evidence metadata</summary><pre>{JSON.stringify({ key: e.key, providerEventId: e.providerEventId, kind: e.kind, category: e.category, indicator: e.indicator, scheduledAt: e.scheduledAt, publishedAt: e.publishedAt, firstKnownAt: e.firstKnownAt, firstReceivedAt: e.firstReceivedAt, actualKnownAt: e.actualKnownAt, lastKnownAt: e.lastKnownAt, duplicateOf: e.duplicateOf, surpriseRule: e.surprise?.rule ?? null }, null, 2)}</pre></details>
    </Panel>
  );
}

