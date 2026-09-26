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
  VP_TOGGLE_LABELS,
  VP_VIEW_TITLE,
  acceptanceTone,
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

  return (
    <main className="srmain smcmain vpmain" data-testid="vp-page">
      <div className="smchead">
        <div className="smchead__brand">
          <span className="smchead__icon" aria-hidden="true">
            <BarChart3 size={20} />
          </span>
          <div>
            <h1 className="smchead__title">Volume Profile</h1>
            <p className="smchead__sub">Where volume traded by price — POC, value area, HVN / LVN, acceptance and multi-timeframe profiles from real closed candles and their reported volume. Analysis only: no signals, no orders.</p>
          </div>
        </div>
        <div className="smccards vpcards" data-testid="vp-top">
          <div className="panel smccard">
            <span className="smccard__k">Symbol</span>
            <strong>{instrument.symbol}</strong>
            <span className="num smccard__big">{price === null ? '—' : formatPrice(price, d)}</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Volume Source</span>
            <strong data-testid="vp-source" className={src.unavailable ? 'vpwarn' : ''}>
              {src.label}
            </strong>
            <span className="smccard__sub">{src.unavailable ? 'never estimated or simulated' : profile?.source.missingBars ? `${profile.source.missingBars} bars without volume excluded` : ''}</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Data status</span>
            <strong data-testid="vp-data-status" className={`smcstatus is-${viewState.toLowerCase()}`}>
              {VP_VIEW_TITLE[viewState]}
            </strong>
            <span className="smccard__sub">
              {provider ? provider.name : 'Provider: not connected'}
              {live.revisions ? ` · ${live.revisions} revised` : ''}
            </span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Session</span>
            <strong>{snap?.sessionName ?? 'No major session'}</strong>
            <span className="smccard__sub">{head ? head.label : ''}</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">POC</span>
            <strong className="num vppoc" data-testid="vp-poc">
              {f(head?.poc)}
            </strong>
            <span className="smccard__sub">{snap?.location ? fmtAtr(snap.location.distPocAtr) : ''}</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">VAH / VAL</span>
            <strong className="num vpva">
              {f(head?.vah)} / {f(head?.val)}
            </strong>
            <span className="smccard__sub">{head ? `${Math.round(head.valueAreaTarget * 100)}% value area` : ''}</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Price location</span>
            <span data-testid="vp-location">{snap?.location ? <Tag v={snap.location.location} tone={locationTone(snap.location.location)} /> : <Tag v="NO DATA" />}</span>
            <span className="smccard__sub">{snap?.location ? 'vs current session' : ''}</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Acceptance</span>
            <span data-testid="vp-acceptance-state">
              <Tag v={snap?.acceptance?.state ?? 'NO CONFIRMATION'} tone={acceptanceTone(snap?.acceptance?.state)} />
            </span>
            <span className="smccard__sub">{snap?.acceptance ? `vs ${snap.acceptance.referenceLabel}` : ''}</span>
          </div>
          <div className="panel smccard">
            <span className="smccard__k">Profile state</span>
            <Tag v={snap?.profileState ?? 'NO DATA'} tone={snap?.profileState === 'IMBALANCED UP' ? 'bull' : snap?.profileState === 'IMBALANCED DOWN' ? 'bear' : snap?.profileState === 'TRANSITION' ? 'warn' : 'muted'} />
            <span className="smccard__sub" />
          </div>
          <div className="panel smccard smccard--state">
            <span className="smccard__k">VP Score</span>
            <strong className="num" data-testid="vp-score-card">
              {score?.total ?? '—'}
              {score?.total !== null && score?.total !== undefined ? '/100' : ''}
            </strong>
            <span className="smccard__sub">not a probability</span>
          </div>
        </div>
      </div>

      <div className="smcgrid">
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
        <aside className="panel smctoggles" aria-label="Chart overlays" data-testid="vp-toggles">
          <h3>CHART OVERLAYS</h3>
          {VP_TOGGLE_LABELS.map(([k, label]) => (
            <label key={k} className="smctoggle">
              <span>{label}</span>
              <input type="checkbox" role="switch" checked={toggles[k]} onChange={() => setToggles({ ...toggles, [k]: !toggles[k] })} />
            </label>
          ))}
          <p className="smcnote">Profile overlays come from the Volume Profile engine. Liquidity, Sweeps, Order Blocks, FVG and BOS / CHOCH are the SMC engine's published {chartTf} output; S / R is the S&R engine's — all read-only.</p>
          {replay && (choice === 'VISIBLE' || choice === 'FIXED') && <p className="smcnote smcnote--warn">Visible / fixed range profiles are available on the live chart only.</p>}
        </aside>
      </div>

      <div className="smcrow4">
        <StatsPanel profile={profile} snapshot={snap} d={d} />
        <AcceptancePanel snapshot={snap} />
        <ScorePanel score={score} />
        <SessionsPanel snapshot={snap} d={d} />
      </div>
      <MtfPanel rows={snap?.mtf ?? []} chartTf={chartTf} onTf={(tf) => (isTf(tf) ? setChartTf(tf) : undefined)} d={d} />
      <div className="vprow3">
        <NodesPanel nodes={snap?.nodes ?? []} d={d} />
        <LevelsPanel levels={snap?.keyLevels ?? []} d={d} />
        <ConfluencePanel items={replay ? [] : live.confluence} d={d} />
      </div>
      <EventLogPanel log={log} d={d} />
      <p className="smcnote smcdisclaimer">
        Volume Profile v1 — market analysis only. MT5 tick volume counts price updates, not contracts traded; it is labelled as such and never presented as COMEX exchange volume. The score is not a probability of winning or expected profit. No orders, no automatic SL / TP.
      </p>
    </main>
  );
}
