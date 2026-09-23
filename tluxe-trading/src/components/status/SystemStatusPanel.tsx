import { HeartPulse } from 'lucide-react';
import { useServices } from '../../app/servicesContext';
import { ENGINES } from '../../config/engines';
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
  const connection = useStore(services.market.store, (s) => s.connection);
  const marketError = useStore(services.market.store, (s) => s.error);
  const ai = useStore(services.ai.store, (s) => s.status);
  const news = useStore(services.news.store, (s) => s.status);
  const calendar = useStore(services.calendar.store, (s) => s.status);

  const items = buildSystemStatus({
    browserOnline: online,
    market: { connection, error: marketError },
    ai,
    database: services.databaseStatus,
    news,
    calendar,
    engines: ENGINES,
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
