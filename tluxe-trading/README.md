# Trading by TLUXE — Phase 1 Dashboard

Standalone institutional-style GC (COMEX Gold) terminal. Phase 1 is the dashboard
foundation only: no strategy engines, signals or execution.

## Run

```bash
npm install
npm run dev        # http://localhost:5180
npm run check      # typecheck + lint + tests + production build
npm run preview    # serve dist/ at http://localhost:4180
```

## Data integrity

No provider is connected yet. Every provider slot uses a `Null*` implementation that
reports "not connected" and emits nothing. Unknown values are `null` and render as `—`.
Nothing is simulated.

## Connecting a real provider later

Implement the interface and swap it in `src/services/registry.ts` (`defaultProviders`):

| Slot     | Interface                                              |
| -------- | ------------------------------------------------------ |
| Market   | `services/market/MarketDataProvider.ts`                |
| News     | `services/news/NewsProvider.ts` (`FeedProvider<NewsItem>`) |
| Calendar | `services/calendar/CalendarProvider.ts` (`FeedProvider<EconomicEvent>`) |
| AI       | `services/ai/AiProvider.ts`                            |

Flow: provider → normalization (`normalize.ts`, feed `normalize*`) → store → UI.
Candles bypass React and go straight to `components/chart/ChartController.ts`, which
also defines `setOverlays()` for future engine output (`types/overlays.ts`).
