# Trading by TLUXE — Phase 1 Dashboard

Standalone institutional-style GC (COMEX Gold) terminal. Phase 1 is the dashboard
foundation only: no strategy engines, signals or execution.

## Run

```bash
npm install
npm run dev        # http://localhost:5182
npm run check      # typecheck + lint + tests + production build
npm run preview    # serve dist/ at http://localhost:4181
```

## Data integrity

Out of the box no provider is connected: every slot reports "not connected" and emits
nothing. Real prices come only from a real provider — currently **MetaTrader 5** via the
private bridge in [`bridge/mt5`](bridge/mt5/README.md), enabled in **Settings**. See
[`docs/MT5_DATA.md`](docs/MT5_DATA.md) for the data pipeline and time handling. Unknown values are `null` and render as `—`.
Nothing is simulated.

**TLUXE AI** (Chat, read-only) talks to a local backend in [`bridge/ai`](bridge/ai/README.md) (127.0.0.1:8767,
`bridge\ai\start_ai.cmd`), which calls the OpenAI Responses API. The OpenAI key lives only in `bridge/ai/.env`;
without it the panel stays **Not Connected**.

**News Analysis** receives real data only through a local news backend in [`bridge/news`](bridge/news/README.md)
(127.0.0.1:8768, `bridge\news\start_news.cmd`): Trading Economics economic calendar (and optionally its news API).
Without a Trading Economics credential in `bridge/news/.env` the page stays **DATA UNAVAILABLE**.

## Instruments

Canonical registry: `src/config/instruments.ts` — GC, SI (COMEX futures), XAUUSD,
XAGUSD (MT5 spot/CFD), EURUSD, GBPUSD, AUDUSD, USDCAD (MT5), BTCUSD, ETHUSD, SOLUSD
(provider-dependent), DXY and the NASDAQ category. Internal ids are never assumed to
equal a provider's symbol: mappings carry discovery hints only, and
`services/market/symbolMapping.ts` resolves the real symbol (override → fixed →
discovered from the provider's list; ambiguity is reported, reciprocal FX pairs such
as CADUSD are mapped onto USDCAD as inverted).

Every instrument has its own market state with independent **price** and **depth**
feed status. The selected instrument is persisted and drives the whole dashboard.

## Connecting a real provider later

Implement the interface and add it in `src/services/registry.ts` (`defaultProviders`):

| Slot     | Interface                                                              |
| -------- | ---------------------------------------------------------------------- |
| Price    | `services/market/MarketDataProvider.ts` (family: `mt5`, `futures-feed`, `crypto-feed`, `index-feed`) |
| Depth    | `services/market/DepthProvider.ts` (family: `depth-feed`, e.g. Bookmap) |
| News     | `services/news/NewsProvider.ts` (`FeedProvider<NewsItem>`)             |
| Calendar | `services/calendar/CalendarProvider.ts` (`FeedProvider<EconomicEvent>`) |
| AI       | `services/ai/AiProvider.ts` (requests carry `instrumentId`)             |

Providers can only update instruments routed to them, and only with capabilities
their mapping declares. Future engines implement `types/engine.ts` and run through
`services/engines/runEngine.ts`, which requires an explicit `instrumentId`.
