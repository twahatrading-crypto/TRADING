import { useMemo, useState } from 'react';
import { DEFAULT_TIMEFRAME, TIMEFRAMES } from '../../config/instrument';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { usePersistentState } from '../../hooks/usePersistentState';
import type { Timeframe } from '../../types/market';
import { BrandHero } from '../branding/BrandHero';
import { SRChart } from './SRChart';
import { ConfluencePanel, ScoreComponentsPanel, ZoneDetails } from './SRDetails';
import { SRPanel, type SRTab } from './SRPanel';
import { SR_VIEW_TITLE, srViewState, type SortSpec, type ZoneFilters } from './srView';
import { useSRSettings, useSRState } from './useSR';
import './sr.css';

const isTf = (v: unknown): v is Timeframe => TIMEFRAMES.includes(v as Timeframe);

/** Engines → Support & Resistance. All zones come from the S&R service (engine snapshots). */
export function SRPage() {
  const def = useActiveInstrument();
  return (
    <div className="srapp">
      {/* Keyed by instrument: selections/filters reset, so no zone from another symbol can linger. */}
      <SRWorkspace key={def.id} />
      <footer className="foot srfoot">
        <div className="foot__inner">
          <span className="foot__brand">TLUXE | TRADING</span>
          <span>Support &amp; Resistance Engine</span>
          <span>{def.displayName}</span>
          <span>Real candles only — no simulated data</span>
        </div>
      </footer>
    </div>
  );
}

function SRWorkspace() {
  const def = useActiveInstrument();
  const decimals = useMarket((s) => s.instrument.priceDecimals);
  const connection = useMarket((s) => s.connection);
  const multi = useSRState((s) => s.multi);
  const byTf = useSRState((s) => s.byTimeframe);
  const [settings, setSettings, resetSettings] = useSRSettings();

  const [chartTf, setChartTf] = usePersistentState<Timeframe>(`tluxe.sr.chartTf.${def.id}`, DEFAULT_TIMEFRAME, isTf);
  const [filters, setFilters] = useState<ZoneFilters>({ type: 'all', tf: 'ALL', status: 'ALL' });
  const [sort, setSort] = useState<SortSpec>({ key: 'score', dir: 'desc' });
  const [showAll, setShowAll] = useState(false);
  const [showZones, setShowZones] = useState(true);
  const [tab, setTab] = useState<SRTab>('zones');
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [selectedConfluenceId, setSelectedConfluenceId] = useState<string | null>(null);

  const zones = useMemo(() => multi?.zones ?? [], [multi]);
  const confluences = useMemo(() => multi?.confluences ?? [], [multi]);
  const viewState = srViewState({
    tradable: def.tradable,
    connection,
    snapshots: filters.tf === 'ALL' ? TIMEFRAMES.map((tf) => byTf[tf]) : [byTf[filters.tf]],
  });
  const zone = zones.find((z) => z.id === selectedZoneId) ?? null;
  const confluence =
    confluences.find((c) => c.id === selectedConfluenceId) ?? (zone ? (confluences.find((c) => c.zoneIds.includes(zone.id)) ?? null) : null);

  const selectZone = (id: string) => {
    setSelectedZoneId(id);
    setSelectedConfluenceId(null);
  };
  const selectConfluence = (id: string) => setSelectedConfluenceId((cur) => (cur === id ? null : id));
  const emptyText =
    viewState === 'READY' || viewState === 'STALE' ? 'Select a zone in the table to see its details.' : `${SR_VIEW_TITLE[viewState]} — no zones for ${def.shortName}.`;

  return (
    <main className="srmain">
      <div className="srmain__top">
        <div className="srhero-wrap">
          <BrandHero />
        </div>
      </div>
      <div className="srgrid">
        <div className="sr-area-chart">
          <SRChart
            chartTf={chartTf}
            onChartTf={setChartTf}
            zones={zones}
            filters={filters}
            showZones={showZones}
            onToggleZones={() => setShowZones((v) => !v)}
            selectedZoneId={selectedZoneId}
            confluence={selectedConfluenceId ? confluence : null}
            onOpenSettings={() => setTab('settings')}
          />
        </div>
        <div className="sr-area-panel">
          <SRPanel
            tab={tab}
            onTab={setTab}
            viewState={viewState}
            multi={multi}
            decimals={decimals}
            filters={filters}
            onFilters={(f) => {
              setFilters(f);
              setShowAll(false);
            }}
            sort={sort}
            onSort={setSort}
            showAll={showAll}
            onShowAll={setShowAll}
            selectedZoneId={selectedZoneId}
            onSelectZone={selectZone}
            selectedConfluenceId={selectedConfluenceId}
            onSelectConfluence={selectConfluence}
            settings={settings}
            onSettings={setSettings}
            onResetSettings={resetSettings}
            symbol={def.shortName}
          />
        </div>
        <div className="sr-area-details">
          <ZoneDetails zone={zone} decimals={decimals} emptyText={emptyText} />
          <ScoreComponentsPanel zone={zone} />
          <ConfluencePanel confluences={confluences} selected={confluence} zones={zones} decimals={decimals} onSelect={selectConfluence} />
        </div>
      </div>
    </main>
  );
}
