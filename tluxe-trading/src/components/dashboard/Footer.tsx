import { useMarket } from '../../hooks/useMarket';

export function Footer() {
  const connection = useMarket((s) => s.connection);
  const symbol = useMarket((s) => s.instrument.symbol);
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
          {symbol} market data {live ? 'connected' : 'not connected'}
        </span>
      </div>
    </footer>
  );
}
