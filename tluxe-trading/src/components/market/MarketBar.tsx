import { Bell } from 'lucide-react';
import { QUOTE_STALE_AFTER_MS } from '../../config/instrument';
import { useMarket } from '../../hooks/useMarket';
import { CONNECTION_LABEL, getQuoteDisplayMode, type QuoteDisplayMode } from '../../services/market/normalize';
import { useNow } from '../../store/clock';
import type { ConnectionState, MarketState } from '../../types/market';
import { directionOf, formatPercent, formatPrice, formatSigned, formatVolume } from '../../utils/format';
import { Logo } from '../branding/Logo';
import { StatusPill } from '../ui/StatusPill';
import { HeaderClock } from './HeaderClock';
import './market.css';

const CONNECTION_TONE: Record<ConnectionState, 'ok' | 'warn' | 'bad' | 'off' | 'info'> = {
  LIVE: 'ok',
  DELAYED: 'info',
  CONNECTING: 'info',
  DISCONNECTED: 'bad',
  UNAVAILABLE: 'warn',
};

function Field({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={`mbar__field ${className ?? ''}`}>
      <span className="mbar__label">{label}</span>
      <span className="mbar__value num">{value}</span>
    </div>
  );
}

export function QuoteBlock({ state, mode }: { state: MarketState; mode: QuoteDisplayMode }) {
  const { quote, instrument } = state;
  const d = instrument.priceDecimals;
  if (mode === 'unavailable' || mode === 'connecting') {
    return (
      <div className="mbar__price mbar__price--empty" data-testid="quote-unavailable">
        <span className="mbar__unavail">{mode === 'connecting' ? 'GC CONNECTING…' : 'GC DATA UNAVAILABLE'}</span>
        <span className="mbar__subtle">No price is shown until a provider supplies one</span>
      </div>
    );
  }
  const dir = directionOf(quote.change);
  return (
    <div className={`mbar__price ${mode === 'stale' ? 'mbar__price--stale' : ''}`} data-testid="quote-values">
      <span className="mbar__last num">{formatPrice(quote.last, d)}</span>
      <span className={`mbar__chg num mbar__chg--${dir}`}>
        {formatSigned(quote.change, d)} ({formatPercent(quote.changePercent)})
      </span>
      {mode !== 'live' && <span className={`mbar__tag mbar__tag--${mode}`}>{mode === 'stale' ? 'STALE' : 'DELAYED'}</span>}
    </div>
  );
}

export function MarketBar() {
  const state = useMarket((s) => s);
  const now = useNow('second');
  const mode = getQuoteDisplayMode(state, now, QUOTE_STALE_AFTER_MS);
  const { quote, instrument, provider, connection } = state;
  const d = instrument.priceDecimals;

  return (
    <header className="mbar" aria-label="GC market bar">
      <div className="mbar__inner">
        <div className="mbar__brand">
          <Logo />
        </div>

        <div className="mbar__instrument">
          <div className="mbar__inst-name">
            <span className="mbar__sym">{instrument.symbol}</span>
            <span className="mbar__inst-title">{instrument.name}</span>
          </div>
          <div className="mbar__inst-meta">
            {instrument.exchange} • {instrument.currency} • Contract {instrument.contract ?? '—'}
          </div>
        </div>

        <QuoteBlock state={state} mode={mode} />

        <div className="mbar__fields">
          <Field label="Bid" value={formatPrice(quote.bid, d)} />
          <Field label="Ask" value={formatPrice(quote.ask, d)} />
          <Field label="High" value={formatPrice(quote.high, d)} />
          <Field label="Low" value={formatPrice(quote.low, d)} />
          <Field label="Volume" value={formatVolume(quote.volume)} />
        </div>

        <div className="mbar__conn">
          <StatusPill
            tone={CONNECTION_TONE[connection]}
            label={CONNECTION_LABEL[connection]}
            pulse={connection === 'LIVE' || connection === 'CONNECTING'}
            compact
          />
          <span className="mbar__provider">
            Provider: <strong>{provider?.name ?? 'Not Connected'}</strong>
          </span>
        </div>

        <button className="mbar__icon-btn" type="button" disabled title="Alerts — available once market data is connected" aria-label="Alerts (unavailable)">
          <Bell size={17} />
        </button>

        <HeaderClock />
      </div>
    </header>
  );
}
