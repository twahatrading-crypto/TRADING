import { BarChart3 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServices } from '../../app/servicesContext';
import { VP_TF_SECONDS } from '../../engines/volumeProfile/config';
import type { VolumeProfile } from '../../engines/volumeProfile/types';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { useOptionalStore } from '../../hooks/useOptionalStore';
import { usePersistentState } from '../../hooks/usePersistentState';
import type { VPReplaySession } from '../../services/volumeProfile/VPReplay';
import { useStore } from '../../store/createStore';
import type { Timeframe } from '../../types/market';
import { formatPrice } from '../../utils/format';
import { VPChart } from './VPChart';
import { AcceptancePanel, ConfluencePanel, EventLogPanel, LevelsPanel, MtfPanel, NodesPanel, ScorePanel, SessionsPanel, StatsPanel, Tag } from './VPPanels';
import {
  DEFAULT_VP_TOGGLES,
  VP_CHART_TFS,
  VP_PROFILE_CHOICES,
  VP_TOGGLE_GROUPS,
  VP_TOGGLE_LABELS,
  VP_VIEW_TITLE,
  fmtAtr,
  locationTone,
  secToUtcInput,
  utcInputToSec,
  volumeSourceText,
  vpViewState,
  type VPProfileChoice,
  type VPToggles,
} from './vpView';
import '../sr/sr.css';
import '../smc/smc.css';
import './vp.css';

const isTf = (v: unknown): v is Timeframe => typeof v === 'string' && (VP_CHART_TFS as string[]).includes(v);
const isChoice = (v: unknown): v is VPProfileChoice => typeof v === 'string' && VP_PROFILE_CHOICES.some(([k]) => k === v);
const isToggles = (v: unknown): v is VPToggles => !!v && typeof v === 'object' && VP_TOGGLE_LABELS.every(([k]) => typeof (v as Record<string, unknown>)[k] === 'boolean');

/**
 * VOLUME PROFILE page — MARKET ANALYSIS only. React only displays the VolumeProfileService output
 * (the engine runs outside React). No BUY / SELL signals, no entries, no SL / TP, no orders.
 */
export function VolumeProfilePage() {
  const { volumeProfile, smc, sr } = useServices();
  const def = useActiveInstrument();
  const instrument = useMarket((s) => s.instrument);
  const quote = useMarket((s) => s.quote);
  const provider = useMarket((s) => s.provider);
  const d = instrument.priceDecimals;
  const live = useStore(volumeProfile.store, (s) => s);
  const smcState = useStore(smc.store, (s) => s);
  const srZones = useStore(sr.store(def.id), (s) => s.multi?.zones ?? null);
  const [chartTf, setChartTf] = usePersistentState<Timeframe>('tluxe.vp.chartTf', 'M15', isTf);
  const [choice, setChoice] = usePersistentState<VPProfileChoice>('tluxe.vp.profile', 'CURRENT_SESSION', isChoice);
  const [toggles, setToggles] = usePersistentState<VPToggles>('tluxe.vp.toggles.v1', DEFAULT_VP_TOGGLES, isToggles);
  const [visible, setVisible] = useState<{ from: number; to: number } | null>(null);
  const [fixed, setFixed] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [replay, setReplay] = useState<VPReplaySession | null>(null);
  const replaySnap = useOptionalStore(replay?.store, (s) => s.snapshot, null);

  // A symbol change ends any replay (it belongs to the previous instrument's candles).
  useEffect(() => {
    setReplay((r) => {
      r?.dispose();
      return null;
    });
  }, [def.id]);
  useEffect(() => () => replay?.dispose(), [replay]);
  const startReplay = useCallback(() => setReplay(volumeProfile.createReplay(chartTf)), [volumeProfile, chartTf]);
  const exitReplay = useCallback(() => {
    replay?.dispose();
    setReplay(null);
  }, [replay]);

  const liveSnap = live.instrumentId === def.id ? live.snapshot : null;
  const snap = replay ? replaySnap : liveSnap;
  const smcSnap = smcState.instrumentId === def.id ? smcState.snapshot : null;

  // Fixed range defaults to the last 48 closed candles of the chart timeframe (user-editable, UTC).
  const lastTime = liveSnap?.knowledgeTime ?? null;
  const fixedFrom = utcInputToSec(fixed.from) ?? (lastTime !== null ? lastTime - 48 * VP_TF_SECONDS[chartTf] : null);
  const fixedTo = utcInputToSec(fixed.to) ?? lastTime;
  const fixedValue = { from: fixed.from || (fixedFrom !== null ? secToUtcInput(fixedFrom) : ''), to: fixed.to || (fixedTo !== null ? secToUtcInput(fixedTo) : '') };

  const profile: VolumeProfile | null = useMemo(() => {
    if (!snap) return null;
    if (choice === 'VISIBLE' || choice === 'FIXED') {
      if (replay) return null; // range profiles are built from the live engine only
      const r = choice === 'VISIBLE' ? (visible ? { from: visible.from, to: visible.to + VP_TF_SECONDS[chartTf] } : null) : fixedFrom !== null && fixedTo !== null && fixedTo > fixedFrom ? { from: fixedFrom, to: fixedTo } : null;
      return r ? volumeProfile.rangeProfile(chartTf, r.from, r.to, choice === 'VISIBLE' ? `Visible range (${chartTf})` : `Fixed range (${chartTf})`) : null;
    }
    return snap.profiles[choice] ?? null;
  }, [snap, choice, replay, visible, chartTf, fixedFrom, fixedTo, volumeProfile]);

  const viewState = vpViewState({ feed: live.feed, snapshot: snap, profile, replay: !!replay, hasProvider: !!provider });
  const src = volumeSourceText({ snapshot: snap, profile, symbol: instrument.symbol, isFuture: def.kind === 'future' });
  const log = replay ? (replaySnap?.events ?? []) : live.instrumentId === def.id ? live.log : [];
  const price = replay ? (replaySnap?.price ?? null) : (quote.last ?? liveSnap?.price ?? null);
  const head = snap?.profiles.CURRENT_SESSION ?? snap?.profiles.DAILY ?? null;
  const f = (p: number | null | undefined) => (p === null || p === undefined ? '—' : formatPrice(p, d));
  const score = replay ? null : live.instrumentId === def.id ? live.score : null;

  const stateTone = snap?.profileState === 'IMBALANCED UP' ? 'bull' : snap?.profileState === 'IMBALANCED DOWN' ? 'bear' : snap?.profileState === 'TRANSITION' ? 'warn' : 'muted';

  return (
    <main className="srmain smcmain vpmain" data-testid="vp-page">
      <header className="vphead">
        <div className="smchead__brand">
          <span className="smchead__icon" aria-hidden="true">
            <BarChart3 size={20} />
          </span>
          <div>
            <h1 className="smchead__title">Volume Profile</h1>
            <p className="smchead__sub">Where volume traded by price — value area, POC and volume nodes from real closed candles. Analysis only: no signals, no orders.</p>
          </div>
        </div>
        <div className="vphead__meta">
          <span className="vphead__sym">
            {instrument.symbol} <b className="num">{price === null ? '—' : formatPrice(price, d)}</b>
          </span>
          <span className={`vpstatus smcstatus is-${viewState.toLowerCase()}`} title={provider ? provider.name : 'Provider: not connected'}>
            <i aria-hidden="true" />
            <strong data-testid="vp-data-status">{VP_VIEW_TITLE[viewState]}</strong>
          </span>
          {live.revisions ? <span className="vpsrc">{live.revisions} revised</span> : null}
        </div>
      </header>

      <section className="vpsummary" data-testid="vp-top" aria-label="Volume profile summary">
        <div className="panel vpsum vpsum--source" title={profile?.source.detail ?? src.label}>
          <span className="vpsum__k">Volume source</span>
          <strong data-testid="vp-source" className={src.unavailable ? 'vpwarn' : 'vpsum__src'}>
            {src.label}
          </strong>
          <span className="vpsum__sub">{src.unavailable ? 'never estimated or simulated' : profile?.source.missingBars ? `${profile.source.missingBars} bars without volume excluded` : (provider?.name ?? '')}</span>
        </div>
        <div className="panel vpsum">
          <span className="vpsum__k">Session</span>
          <strong className="vpsum__txt">{snap?.sessionName ?? 'No major session'}</strong>
          <span className="vpsum__sub">{head ? head.label : ''}</span>
        </div>
        <div className="panel vpsum">
          <span className="vpsum__k">POC</span>
          <strong className="num vpsum__big vppoc" data-testid="vp-poc">
            {f(head?.poc)}
          </strong>
          <span className="vpsum__sub">{snap?.location ? fmtAtr(snap.location.distPocAtr) : 'point of control'}</span>
        </div>
        <div className="panel vpsum">
          <span className="vpsum__k">VAH</span>
          <strong className="num vpsum__big vpva" data-testid="vp-vah">
            {f(head?.vah)}
          </strong>
          <span className="vpsum__sub">value area high{head ? ` · ${Math.round(head.valueAreaTarget * 100)}%` : ''}</span>
        </div>
        <div className="panel vpsum">
          <span className="vpsum__k">VAL</span>
          <strong className="num vpsum__big vpva" data-testid="vp-val">
            {f(head?.val)}
          </strong>
          <span className="vpsum__sub">value area low</span>
        </div>
        <div className="panel vpsum">
          <span className="vpsum__k">Price location</span>
          <span data-testid="vp-location">{snap?.location ? <Tag v={snap.location.location} tone={locationTone(snap.location.location)} /> : <Tag v="NO DATA" />}</span>
          <span className="vpsum__sub">{snap?.location ? 'vs current session' : ''}</span>
        </div>
        <div className="panel vpsum">
          <span className="vpsum__k">Profile state</span>
          <Tag v={snap?.profileState ?? 'NO DATA'} tone={stateTone} />
          <span className="vpsum__sub">{snap?.acceptance ? `${snap.acceptance.state.toLowerCase()} · vs ${snap.acceptance.referenceLabel}` : ''}</span>
        </div>
      </section>

      <div className="smcgrid vpgrid">
        <VPChart
          chartTf={chartTf}
          onChartTf={setChartTf}
          choice={choice}
          onChoice={setChoice}
          fixed={fixedValue}
          onFixed={setFixed}
          onVisibleRange={setVisible}
          snapshot={snap}
          profile={profile}
          smc={smcSnap}
          srZones={srZones}
          toggles={toggles}
          viewState={viewState}
          replay={replay}
          onStartReplay={startReplay}
          onExitReplay={exitReplay}
        />
        <aside className="panel smctoggles vptoggles" aria-label="Chart overlays" data-testid="vp-toggles">
          <h3>CHART OVERLAYS</h3>
          {VP_TOGGLE_GROUPS.map((g) => (
            <div key={g.title} className="vptoggles__group" role="group" aria-label={g.title}>
              <h4>{g.title}</h4>
              {g.keys.map((k) => (
                <label key={k} className="smctoggle">
                  <span>{VP_TOGGLE_LABELS.find(([x]) => x === k)?.[1]}</span>
                  <input type="checkbox" role="switch" checked={toggles[k]} onChange={() => setToggles({ ...toggles, [k]: !toggles[k] })} />
                </label>
              ))}
            </div>
          ))}
          <p className="smcnote">Profile overlays come from the Volume Profile engine. Confluence overlays are the SMC / S&R engines' published {chartTf} output — read-only.</p>
          {replay && (choice === 'VISIBLE' || choice === 'FIXED') && <p className="smcnote smcnote--warn">Visible / fixed range profiles are available on the live chart only.</p>}
        </aside>
      </div>

      <div className="vprowA">
        <StatsPanel profile={profile} snapshot={snap} d={d} />
        <LevelsPanel levels={snap?.keyLevels ?? []} d={d} />
        <MtfPanel rows={snap?.mtf ?? []} chartTf={chartTf} onTf={(tf) => (isTf(tf) ? setChartTf(tf) : undefined)} d={d} />
        <SessionsPanel snapshot={snap} d={d} />
      </div>
      <div className="vprowB">
        <AcceptancePanel snapshot={snap} />
        <ScorePanel score={score} />
        <NodesPanel nodes={snap?.nodes ?? []} d={d} />
        <ConfluencePanel items={replay ? [] : live.confluence} d={d} />
      </div>
      <EventLogPanel log={log} d={d} />
      <p className="smcnote smcdisclaimer">
        Volume Profile v1 — market analysis only. MT5 tick volume counts price updates, not contracts traded; it is labelled as such and never presented as COMEX exchange volume. The score is not a probability of winning or expected profit. No orders, no automatic SL / TP.
      </p>
    </main>
  );
}
