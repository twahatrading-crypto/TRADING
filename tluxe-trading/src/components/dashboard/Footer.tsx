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
        <span>Institutional Trading Terminal</span>
        <span>Real data only — nothing simulated</span>
        <span>v0.1</span>
        <span className="foot__right">
          <span className={`dot ${live ? 'dot--ok' : 'dot--warn'}`} aria-hidden="true" />
          {live ? 'Market data connected' : 'Market data not connected'}
        </span>
      </div>
    </footer>
  );
}
