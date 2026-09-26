import { BellRing, Newspaper } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useServices } from '../app/servicesContext';
import { DENVER_TZ, zoneParts } from '../engines/news/time';
import type { NewsEventView } from '../engines/news/types';
import { useStore } from '../store/createStore';
import { AlertsPanel, BreakingPanel, CalendarPanel, EventDetail, MatrixPanel, NextEventPanel, ProvidersPanel, RiskPanel, SummaryCards, XauPanel } from '../components/newsAnalysis/NewsPanels';
import { ReactionChart } from '../components/newsAnalysis/ReactionChart';
import { localTz } from '../components/newsAnalysis/newsView';
import '../components/sr/sr.css';
import '../components/newsAnalysis/news.css';

/**
 * NEWS ANALYSIS page — an analysis dashboard only (no orders, no signals, nothing blocked).
 * React only displays NewsAnalysisService output; every formula lives in engines/news.
 */
export function NewsAnalysisPage() {
  const { newsAnalysis } = useServices();
  const st = useStore(newsAnalysis.store, (s) => s);
  const [selected, setSelected] = useState<string | null>(null);
  const events = st.snapshot.events;
  const sel: NewsEventView | null = selected ? (events.find((e) => e.key === selected) ?? null) : null;
  // Reaction focus: the selected event, else the most recent released HIGH scheduled event.
  const focus = useMemo<NewsEventView | null>(
    () => sel ?? [...st.snapshot.calendar].reverse().find((e) => !e.duplicateOf && e.impact === 'HIGH' && (e.scheduledAt ?? Infinity) <= st.now) ?? null,
    [sel, st.snapshot.calendar, st.now],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- candleVersion: recompute when the active instrument's M1 candles change
  const reaction = useMemo(() => (focus ? newsAnalysis.reaction(focus.key, st.now) : null), [newsAnalysis, focus, st.now, st.candleVersion]);
  useEffect(() => {
    if (selected && !sel) setSelected(null);
  }, [selected, sel]);
  const none = !st.feeds.calendar.provider && !st.feeds.breaking.provider && !st.feeds.macro.provider;
  const tz = localTz();
  const clock = (label: string, zone: string) => {
    const z = zoneParts(st.now, zone);
    return (
      <div className="nwclock" key={label}>
        <span>{label}</span>
        <strong className="num">{z.time}</strong>
        <span className="nwdim">{z.zone}</span>
      </div>
    );
  };
  return (
    <main className="srmain nwmain" data-testid="nw-page">
      <div className="nwhead">
        <div className="nwhead__brand">
          <span className="nwhead__icon" aria-hidden="true"><Newspaper size={20} /></span>
          <div>
            <h1 className="nwhead__title">News Analysis</h1>
            <p className="nwhead__sub">Economic calendar, breaking news and event-impact analysis across TLUXE markets. Real provider data only — analysis, never orders.</p>
          </div>
        </div>
        <div className="nwclocks" data-testid="nw-clocks">
          {clock('Local', tz)}
          {clock('Denver', DENVER_TZ)}
          {clock('UTC', 'UTC')}
        </div>
        <div className="nwhead__alerts"><BellRing size={15} /> {st.alerts.length} alert{st.alerts.length === 1 ? '' : 's'}</div>
      </div>
      {none && (
        <div className="panel nwbanner" role="status" data-testid="nw-unavailable">
          <strong>NEWS DATA UNAVAILABLE</strong> — no economic-calendar, breaking-news or macro-news provider is configured. Nothing is simulated: no headlines, events, values, times or sentiment are ever invented. Connect a licensed provider adapter (see News Data Providers) to enable this page.
        </div>
      )}
      <SummaryCards st={st} />
      <div className="nwgrid">
        <CalendarPanel st={st} onSelect={setSelected} selected={selected} />
        <NextEventPanel st={st} reaction={focus && st.snapshot.nextHigh?.key === focus.key ? reaction : null} onSelect={setSelected} />
      </div>
      <div className="nwgrid3">
        <BreakingPanel st={st} onSelect={setSelected} />
        <XauPanel st={st} reaction={reaction} reactionEvent={focus} />
        <MatrixPanel rows={st.snapshot.matrix} none={none} />
      </div>
      <div className="nwgrid">
        <ReactionChart event={focus} reaction={reaction} />
        {sel ? <EventDetail e={sel} reaction={reaction} now={st.now} onClose={() => setSelected(null)} /> : focus ? <EventDetail e={focus} reaction={reaction} now={st.now} onClose={() => setSelected(null)} /> : <RiskPanel risk={st.snapshot.risk} assets={['XAUUSD', 'XAGUSD', 'DXY', 'NASDAQ', 'BTCUSD', 'EURUSD']} />}
      </div>
      <div className="nwgrid3">
        <RiskPanel risk={st.snapshot.risk} assets={['XAUUSD', 'XAGUSD', 'GC', 'DXY', 'NASDAQ', 'BTCUSD', 'EURUSD', 'GBPUSD']} />
        <AlertsPanel alerts={st.alerts} suppressed={st.suppressedAlerts} />
        <ProvidersPanel st={st} />
      </div>
      <p className="nwnote nwdisclaimer">Expected macro effects are rule-based context, separate from observed market reactions; neither is a trade signal. Impact, surprise, risk-window and conflict rules are documented in the engine and shown with each result.</p>
    </main>
  );
}
