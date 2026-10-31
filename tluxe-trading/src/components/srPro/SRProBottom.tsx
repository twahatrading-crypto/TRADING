import { ArrowDown, ArrowRight, ArrowUp, CircleSlash, Minus } from 'lucide-react';
import { useState } from 'react';
import { currentZone, mtfMap, scenarios, TIER_LABEL, zoneEvidence, type AnalysisInput, type Scenario } from '../../engines/srPro/analysis';
import { VALID_THROUGH } from '../../engines/srPro/cmeCalendar';
import type { QualityResult } from '../../engines/srPro/dataQuality';
import type { KeyLevelsResult } from '../../engines/srPro/keyLevels';
import { ibkrLabel, type IbkrState } from '../../providers/ibkr/IbkrDepthProvider';
import type { Timeframe } from '../../types/market';
import { fmtP, fmtUtc, roleShort, tierTone } from './srProView';
import { ZoneEvidenceView } from './SRProZone';

interface Props {
  input: AnalysisInput;
  chartTf: Timeframe;
  levels: KeyLevelsResult;
  quality: QualityResult;
  ibkr: IbkrState | null;
  selectedZoneId: string | null;
  onSelectZone: (id: string) => void;
  d: number;
}

export function SRProBottom(p: Props) {
  return (
    <div className="srp-bottom">
      <MtfMapPanel {...p} />
      <CurrentZonePanel {...p} />
      <StructurePanel {...p} />
      <ScenariosPanel {...p} />
    </div>
  );
}

const TrendIcon = ({ t }: { t: string }) =>
  t === 'up' ? <ArrowUp size={14} aria-label="bullish" /> : t === 'down' ? <ArrowDown size={14} aria-label="bearish" /> : t === 'flat' ? <ArrowRight size={14} aria-label="ranging" /> : <Minus size={14} aria-label="insufficient data" />;

function MtfMapPanel(p: Props) {
  const rows = mtfMap(p.input);
  return (
    <section className="panel srp-card" aria-labelledby="srp-mtf">
      <h3 id="srp-mtf">Multi-Timeframe S&amp;R Map</h3>
      <div className="srp-grid" style={{ gridTemplateColumns: `56px repeat(${rows.length}, minmax(0, 1fr))` }} data-testid="srp-mtf-map">
        <span />
        {rows.map((r) => (
          <span key={r.tf} className={`srp-grid__h ${r.tf === p.chartTf ? 'is-on' : ''}`}>
            {r.tf}
          </span>
        ))}
        <span className="srp-grid__l">Structure</span>
        {rows.map((r) => (
          <span key={r.tf} className={`srp-grid__c is-${r.trend}`} title={r.structure}>
            <TrendIcon t={r.trend} />
          </span>
        ))}
        <span className="srp-grid__l">Key zone</span>
        {rows.map((r) => (
          <button
            key={r.tf}
            type="button"
            className={`srp-grid__z ${r.zone ? `is-${r.zone.role}` : 'is-none'}`}
            disabled={!r.zone}
            onClick={() => r.zone && p.onSelectZone(r.zone.id)}
            title={r.zone ? `${roleShort(r.zone)} ${fmtP(r.zone.zoneLow, p.d)}–${fmtP(r.zone.zoneHigh, p.d)}` : 'No rated zone'}
          >
            {r.zone ? (r.zone.role === 'support' ? 'S' : 'R') : '—'}
          </button>
        ))}
        <span className="srp-grid__l">Bias</span>
        {rows.map((r) => (
          <span key={r.tf} className={`srp-grid__c is-${r.trend}`}>
            {r.structure === 'INSUFFICIENT DATA' ? 'n/a' : r.structure.charAt(0) + r.structure.slice(1).toLowerCase()}
          </span>
        ))}
        <span className="srp-grid__l">Strength</span>
        {rows.map((r) => (
          <span key={r.tf} className={`srp-grid__c`}>
            {r.zone && r.tier ? <span className={`srp-score is-${tierTone(r.tier)}`}>{r.zone.score.total}</span> : '—'}
          </span>
        ))}
      </div>
      <p className="srp-src">Structure: SMC engine (closed candles). Zones: S&amp;R engine, rated tiers only.</p>
    </section>
  );
}

function CurrentZonePanel(p: Props) {
  const z = p.input.zones.find((x) => x.id === p.selectedZoneId) ?? currentZone(p.input, p.chartTf);
  return (
    <section className="panel srp-card" aria-labelledby="srp-cz">
      <h3 id="srp-cz">{p.selectedZoneId ? 'Selected Zone Analysis' : 'Current Zone Analysis'}</h3>
      {z ? <ZoneEvidenceView ev={zoneEvidence(z, p.input)} d={p.d} compact /> : <p className="srp-muted">No rated zone on {p.chartTf} or higher.</p>}
    </section>
  );
}

function StructurePanel(p: Props) {
  const [tab, setTab] = useState<'structure' | 'liquidity' | 'volume' | 'context'>('structure');
  const price = p.input.price;
  const pools = p.input.pools.filter((x) => x.state !== 'CONSUMED' && x.state !== 'INVALIDATED');
  const above = price === null ? [] : pools.filter((x) => x.side === 'BSL' && x.level > price).sort((a, b) => a.level - b.level).slice(0, 3);
  const below = price === null ? [] : pools.filter((x) => x.side === 'SSL' && x.level < price).sort((a, b) => b.level - a.level).slice(0, 3);
  const tfRows = (['M15', 'H1', 'H4'] as Timeframe[]).map((tf) => ({ tf, s: p.input.smc?.byTimeframe[tf] }));
  const vp = p.input.vp;
  return (
    <section className="panel srp-card" aria-labelledby="srp-st">
      <h3 id="srp-st">Structure &amp; Liquidity Evidence</h3>
      <div className="srp-tabs is-small" role="tablist">
        {(['structure', 'liquidity', 'volume', 'context'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>
            {k.charAt(0).toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'structure' && (
        <ul className="srp-list">
          {tfRows.map(({ tf, s }) => {
            const b = s?.breaks[s.breaks.length - 1];
            return (
              <li key={tf}>
                <b>{tf}</b> {s && s.dataState === 'READY' ? s.state : 'INSUFFICIENT DATA'}
                {b && (
                  <span className="srp-muted">
                    {' '}
                    · last {b.direction} {b.kind} through {fmtP(b.level, p.d)} confirmed {fmtUtc(b.confirmedAt)}
                  </span>
                )}
                {s?.stateEvidence && <div className="srp-src">{s.stateEvidence}</div>}
              </li>
            );
          })}
          <li className="srp-src">SMC engine — BOS / CHOCH need a candle CLOSE through a confirmed swing; nothing repaints.</li>
        </ul>
      )}
      {tab === 'liquidity' && (
        <ul className="srp-list">
          <li>
            <b>Above (buy-side)</b> {above.length ? above.map((x) => `${fmtP(x.level, p.d)} (${x.timeframe}${x.source === 'equal' ? ', equal highs' : ''})`).join(' · ') : '—'}
          </li>
          <li>
            <b>Below (sell-side)</b> {below.length ? below.map((x) => `${fmtP(x.level, p.d)} (${x.timeframe}${x.source === 'equal' ? ', equal lows' : ''})`).join(' · ') : '—'}
          </li>
          <li className="srp-src">
            <span className="srp-tag is-inferred">INFERRED</span> from swing structure by the Liquidity engine — not resting orders.
          </li>
          <li>
            <b>Order book</b> IBKR depth: <span className={p.ibkr === 'LIVE' ? 'srp-ok' : 'srp-warn'}>{p.ibkr ? ibkrLabel(p.ibkr) : 'UNKNOWN'}</span>
            <div className="srp-src">{p.ibkr === 'LIVE' ? 'Live COMEX depth is connected; it is not used to rate zones.' : 'No order-book evidence is shown or used while depth is not live.'}</div>
          </li>
        </ul>
      )}
      {tab === 'volume' && (
        <ul className="srp-list">
          {vp && !vp.unavailable ? (
            <>
              {vp.keyLevels
                .filter((k) => k.kind === 'POC' || k.kind === 'VAH' || k.kind === 'VAL')
                .slice(0, 6)
                .map((k) => (
                  <li key={k.id}>
                    <b>{k.kind}</b> {fmtP(k.price, p.d)} <span className="srp-muted">· {k.profileLabel}</span>
                  </li>
                ))}
              <li className="srp-src">{vp.source.label} · volume per bar allocated across the bar's high–low range (no trade-level prices).</li>
            </>
          ) : (
            <li className="srp-muted">{vp?.unavailable ?? 'Volume profile not available yet.'}</li>
          )}
        </ul>
      )}
      {tab === 'context' && (
        <ul className="srp-list">
          <li>
            <b>Feed</b> {p.input.feed.label} — {p.input.feed.detail}
          </li>
          <li>
            <b>Contract liquidity</b> {p.quality.activeSinceDay ? `liquid since ${p.quality.activeSinceDay}${p.quality.stable ? '' : ' (ambiguous transition)'}` : p.quality.state}
          </li>
          <li>
            <b>Session day</b> {p.levels.stats.sessionDate ?? '—'} (CME 18:00–17:00 ET) · calendar verified through {VALID_THROUGH}
          </li>
          <li>
            <b>Source</b> {p.input.sources.candleSource}
          </li>
        </ul>
      )}
    </section>
  );
}

const STATE_ICON: Record<string, string> = { MET: '✓', NOT_MET: '✗', UNKNOWN: '?' };

function ScenarioCard({ s, d }: { s: Scenario; d: number }) {
  const icon = s.kind === 'BULLISH' ? <ArrowUp size={18} /> : s.kind === 'BEARISH' ? <ArrowDown size={18} /> : <CircleSlash size={18} />;
  return (
    <div className={`srp-scn is-${s.kind.toLowerCase()}`} data-testid={`srp-scenario-${s.kind}`}>
      <div className="srp-scn__head">
        {icon}
        <b>{s.title}</b>
        <span className="srp-tag">{s.status}</span>
      </div>
      <ul className="srp-conds">
        {s.conditions.map((c) => (
          <li key={c.text} className={`is-${c.state.toLowerCase()}`}>
            <span aria-hidden="true">{STATE_ICON[c.state]}</span> {c.text}
          </li>
        ))}
      </ul>
      {s.levels.length > 0 && (
        <div className="srp-scn__lv">
          {s.levels.map((l) => (
            <span key={l.label}>
              {l.label} <b>{fmtP(l.price, d)}</b>
            </span>
          ))}
        </div>
      )}
      <p className="srp-src">{s.note}</p>
    </div>
  );
}

function ScenariosPanel(p: Props) {
  const list = scenarios(p.input, p.chartTf);
  return (
    <section className="panel srp-card srp-card--wide" aria-labelledby="srp-sc">
      <h3 id="srp-sc">Next-Move Scenarios</h3>
      <div className="srp-scns">
        {list.map((s) => (
          <ScenarioCard key={s.kind} s={s} d={p.d} />
        ))}
      </div>
      <p className="srp-src">
        Conditions are checked on closed candles. No probability is shown because none has been statistically calibrated. Nothing here is an order or a buy/sell signal. Tier names: {TIER_LABEL.STRONG} ≥ 80,{' '}
        {TIER_LABEL.MEDIUM} 60–79, {TIER_LABEL.WEAK} 40–59.
      </p>
    </section>
  );
}
