import { HeartPulse } from 'lucide-react';
import { useServices } from '../../app/servicesContext';
import { ENGINES } from '../../config/engines';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { useOnline } from '../../hooks/useOnline';
import { buildSystemStatus, STATUS_TONE } from '../../services/status/systemStatus';
import { useStore } from '../../store/createStore';
import type { SystemStatusItem } from '../../types/status';
import { Panel } from '../ui/Panel';
import { StatusDot } from '../ui/StatusPill';
import './status.css';

export function StatusList({ items }: { items: SystemStatusItem[] }) {
  return (
    <ul className="status__list">
      {items.map((i) => {
        const tone = STATUS_TONE[i.value];
        return (
          <li key={i.id} className="status__row" data-testid={`status-${i.id}`}>
            <span className="status__label">{i.label}</span>
            <span className={`status__value status__value--${tone}`} title={i.detail}>
              <StatusDot tone={tone} />
              {i.value}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function SystemStatusPanel() {
  const services = useServices();
  const online = useOnline();
  const symbol = useMarket((s) => s.instrument.symbol);
  const connection = useMarket((s) => s.connection);
  const priceError = useMarket((s) => s.error);
  const def = useActiveInstrument();
  const depth = useMarket((s) => s.depth);
  const ai = useStore(services.ai.store, (s) => s.status);
  const news = useStore(services.news.store, (s) => s.status);
  const calendar = useStore(services.calendar.store, (s) => s.status);
  const srRunning = useStore(services.sr.store(def.id), (s) => Object.values(s.byTimeframe).some((t) => t?.state === 'READY'));

  const items = buildSystemStatus({
    browserOnline: online,
    instrument: symbol,
    // A category with no mappings (e.g. NASDAQ) has no price source until a variant is chosen.
    price: { connection, error: priceError, supported: def.providerMappings.some((m) => m.role === 'price') },
    depth: { connection: depth.connection, error: depth.error, supported: depth.supported },
    ai,
    database: services.databaseStatus,
    news,
    calendar,
    engines: ENGINES,
    engineRuntime: { 'support-resistance': srRunning ? 'running' : 'waiting' },
  });
  const core = items.filter((i) => !i.id.startsWith('engine-'));
  const engines = items.filter((i) => i.id.startsWith('engine-'));
  const okCount = core.filter((i) => STATUS_TONE[i.value] === 'ok').length;

  return (
    <Panel
      id="status"
      title="System Status"
      icon={<HeartPulse size={18} />}
      actions={<span className="status__summary num">{okCount}/{core.length} online</span>}
      className="status-panel"
    >
      <div className="status__groups">
        <div>
          <div className="status__group">Services</div>
          <StatusList items={core} />
        </div>
        <div>
          <div className="status__group">Strategy Engines</div>
          <StatusList items={engines} />
        </div>
      </div>
    </Panel>
  );
}
