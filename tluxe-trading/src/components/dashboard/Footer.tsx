import { useServices } from '../../app/servicesContext';
import { useStore } from '../../store/createStore';

export function Footer() {
  const { market } = useServices();
  const connection = useStore(market.store, (s) => s.connection);
  const live = connection === 'LIVE' || connection === 'DELAYED';
  return (
    <footer className="foot">
      <div className="foot__inner">
        <span className="foot__brand">TLUXE | TRADING</span>
        <span>Phase 1 Dashboard</span>
        <span>Regular-hours sessions</span>
        <span>No simulated data</span>
        <span className="foot__right">
          <span className={`dot ${live ? 'dot--ok' : 'dot--warn'}`} aria-hidden="true" />
          {live ? 'Market data connected' : 'Market data not connected'}
        </span>
      </div>
    </footer>
  );
}
