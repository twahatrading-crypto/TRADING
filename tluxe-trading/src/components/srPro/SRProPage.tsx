import { useState } from 'react';
import { DEFAULT_TIMEFRAME, TIMEFRAMES } from '../../config/instrument';
import { usePersistentState } from '../../hooks/usePersistentState';
import { ibkrLabel } from '../../providers/ibkr/IbkrDepthProvider';
import type { Timeframe } from '../../types/market';
import { SRProBottom } from './SRProBottom';
import { SRProChart } from './SRProChart';
import { SRProPanel, type ProTab } from './SRProPanel';
import { DEFAULT_OVERLAYS, isOverlays, type OverlayKey } from './srProView';
import { useSRPro } from './useSRPro';
import '../sr/sr.css';
import './srPro.css';

const isTf = (v: unknown): v is Timeframe => TIMEFRAMES.includes(v as Timeframe);

/** Engines → Support & Resistance (Pro view). Explanation layer over the existing engines; real candles only. */
export function SRProPage() {
  const pro = useSRPro();
  const { def, input, feed, quality, keyLevels, d } = { ...pro, d: pro.decimals };
  const [chartTf, setChartTf] = usePersistentState<Timeframe>(`tluxe.srpro.tf.${def.id}`, DEFAULT_TIMEFRAME, isTf);
  const [overlays, setOverlays] = usePersistentState('tluxe.srpro.overlays', DEFAULT_OVERLAYS, isOverlays);
  const [tab, setTab] = useState<ProTab>('overview');
  const [selected, setSelected] = useState<string | null>(null);
  const toggle = (k: OverlayKey) => setOverlays({ ...overlays, [k]: !overlays[k] });
  const select = (id: string | null) => {
    setSelected(id);
    if (id) setTab((t) => (t === 'overview' || t === 'zones' || t === 'mtf' ? 'analysis' : t));
  };

  return (
    <div className="srp" data-testid="srp-page">
      <div className="srp-strip" role="status">
        <span className={`srp-badge is-${feed.state.toLowerCase()}`}>{feed.label}</span>
        <span className="srp-muted">{feed.detail}</span>
        <span className="srp-chip">{input.sources.candleSource}</span>
        <span className={`srp-chip ${quality.activeSince ? 'is-warn' : ''}`} title={quality.explanation}>
          {quality.state !== 'OK' ? `Liquidity check: ${quality.state.replace('_', ' ')}` : quality.activeSince ? `Contract liquid since ${quality.activeSinceDay}` : 'Contract liquidity: OK'}
        </span>
        <span className={`srp-chip ${pro.ibkr === 'LIVE' ? '' : 'is-bad'}`}>IBKR depth: {pro.ibkr ? ibkrLabel(pro.ibkr) : 'UNKNOWN'}</span>
      </div>
      <div className="srp-main">
        <SRProChart
          chartTf={chartTf}
          onChartTf={(tf) => {
            setChartTf(tf);
            setSelected(null);
          }}
          input={input}
          feed={feed}
          levels={keyLevels.levels}
          asia={pro.asia}
          overlays={overlays}
          onToggle={toggle}
          selectedZoneId={selected}
          onSelectZone={select}
        />
        <SRProPanel
          tab={tab}
          onTab={setTab}
          input={input}
          chartTf={chartTf}
          levels={keyLevels}
          quality={quality}
          asia={pro.asia}
          onAsia={pro.setAsia}
          overlays={overlays}
          onToggle={toggle}
          selectedZoneId={selected}
          onSelectZone={select}
          d={d}
        />
      </div>
      <SRProBottom input={input} chartTf={chartTf} levels={keyLevels} quality={quality} ibkr={pro.ibkr} selectedZoneId={selected} onSelectZone={select} d={d} />
      <footer className="foot srfoot">
        <div className="foot__inner">
          <span className="foot__brand">TLUXE | TRADING</span>
          <span>Support &amp; Resistance Pro</span>
          <span>{def.displayName}</span>
          <span>Real candles only — no simulated data, no probabilities, no orders</span>
        </div>
      </footer>
    </div>
  );
}
