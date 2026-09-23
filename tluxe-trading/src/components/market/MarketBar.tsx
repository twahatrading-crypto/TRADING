import { QUOTE_STALE_AFTER_MS } from '../../config/instrument';
import { UPCOMING_WINDOW_MS } from '../../config/sessions';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { CONNECTION_LABEL, getQuoteDisplayMode, type QuoteDisplayMode } from '../../services/market/normalize';
import { FEED_LABEL } from '../../services/mt5/freshness';
import { useNow } from '../../store/clock';
import type { ConnectionState, FeedStatusCode, MarketState } from '../../types/market';
import { directionOf, formatPercent, formatPrice, formatSigned, formatVolume, UNKNOWN } from '../../utils/format';
import { Logo } from '../branding/Logo';
import { StatusPill } from '../ui/StatusPill';
import { getSessionState } from '../../utils/sessions';
import { HeaderClock } from './HeaderClock';
import { SymbolSelector } from './SymbolSelector';
import './market.css';

const CONNECTION_TONE: Record<ConnectionState, 'ok' | 'warn' | 'bad' | 'off' | 'info'> = {
  LIVE: 'ok',
  DELAYED: 'info',
  CONNECTING: 'info',
  DISCONNECTED: 'bad',
  UNAVAILABLE: 'warn',
};

function Field({ label, value }: { label: string; value: string }) {
  const unknown = value === UNKNOWN;
  return (
    <div className={`mbar__field ${unknown ? 'is-unknown' : ''}`}>
      <span className="mbar__label">{label}</span>
      <span className="mbar__value num" title={unknown ? 'Not supplied — no provider connected' : undefined}>{value}</span>
    </div>
  );
}

export function QuoteBlock({ state, mode }: { state: MarketState; mode: QuoteDisplayMode }) {
  const { quote, instrument } = state;
  const d = instrument.priceDecimals;
  if (mode === 'unavailable' || mode === 'connecting') {
    return (
      <div className="mbar__price mbar__price--empty" data-testid="quote-unavailable">
        <span className="mbar__unavail">
          {instrument.symbol} {mode === 'connecting' ? 'CONNECTING…' : 'DATA UNAVAILABLE'}
        </span>
        <span className="mbar__subtle">{mode === 'connecting' ? 'Waiting for first quote' : 'Awaiting market-data provider'}</span>
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

/** Market hours for the active instrument, from its own schedule (never assumed). */
export function MarketHours({ now }: { now: number }) {
  const def = useActiveInstrument();
  if (def.tradingHours === '24/7') return <span className="mbar__hours is-open">Market open · 24/7</span>;
  if (def.tradingHours === null) return <span className="mbar__hours">Hours: provider-dependent</span>;
  const st = getSessionState(def.tradingHours, now, UPCOMING_WINDOW_MS);
  const open = st.status === 'OPEN';
  return (
    <span className={`mbar__hours ${open ? 'is-open' : ''}`} title={def.tradingHours.rule}>
      Market {open ? 'open' : 'closed'} · regular hours
    </span>
  );
}

const FEED_TONE: Record<FeedStatusCode, 'ok' | 'warn' | 'bad' | 'off' | 'info'> = {
  LIVE: 'ok',
  MT5_CONNECTED: 'info',
  MT5_CONNECTING: 'info',
  INSUFFICIENT_HISTORY: 'warn',
  MARKET_CLOSED: 'warn',
  STALE: 'warn',
  SYMBOL_NOT_FOUND: 'warn',
  AMBIGUOUS_SYMBOL: 'warn',
  MT5_BRIDGE_OFFLINE: 'bad',
  MT5_NOT_RUNNING: 'bad',
  ERROR: 'bad',
};

const DEPTH_LABEL: Record<ConnectionState, string> = {
  LIVE: 'Connected',
  DELAYED: 'Delayed',
  CONNECTING: 'Connecting',
  DISCONNECTED: 'Disconnected',
  UNAVAILABLE: 'Not connected',
};

export function MarketBar() {
  const state = useMarket((s) => s);
  const now = useNow('second');
  const mode = getQuoteDisplayMode(state, now, QUOTE_STALE_AFTER_MS);
  const { quote, instrument, provider, connection, depth, feed } = state;
  const d = instrument.priceDecimals;

  return (
    <header className="mbar" aria-label="Market bar">
      <div className="mbar__inner">
        <div className="mbar__brand">
          <Logo />
        </div>

        <div className="mbar__instrument">
          <SymbolSelector />
        </div>

        <QuoteBlock key={instrument.id} state={state} mode={mode} />

        <div className="mbar__fields" key={`f-${instrument.id}`}>
          <Field label="Bid" value={formatPrice(quote.bid, d)} />
          <Field label="Ask" value={formatPrice(quote.ask, d)} />
          <Field label="High" value={formatPrice(quote.high, d)} />
          <Field label="Low" value={formatPrice(quote.low, d)} />
          <Field label="Volume" value={formatVolume(quote.volume)} />
        </div>

        <div className="mbar__conn">
          <StatusPill
            tone={feed ? FEED_TONE[feed.code] : CONNECTION_TONE[connection]}
            label={feed ? FEED_LABEL[feed.code] : CONNECTION_LABEL[connection]}
            pulse={feed ? feed.code === 'LIVE' : connection === 'LIVE' || connection === 'CONNECTING'}
            title={feed?.message ?? undefined}
            compact
          />
          <span className="mbar__provider" data-testid="provider-line">
            Provider: <strong>{provider?.name ?? 'Not Connected'}</strong>
            {feed?.providerSymbol && <> · <strong>{feed.providerSymbol}</strong></>}
            {feed?.code === 'LIVE' && quote.spreadPoints != null && <> · spread {quote.spreadPoints} pts</>}
          </span>
          <span className="mbar__provider mbar__depth" data-testid="depth-status">
            Depth: <strong>{depth.supported ? DEPTH_LABEL[depth.connection] : 'Unsupported'}</strong>
          </span>
          <MarketHours now={now} />
        </div>

        <HeaderClock />
      </div>
    </header>
  );
}
