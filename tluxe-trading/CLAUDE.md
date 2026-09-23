# Trading by TLUXE — standing rules for Claude

## Data integrity (always)
- Never fabricate market data, show fixture data as live, or claim a connection that does not exist. Unknown data stays unknown (`null` / `—`).
- No BUY/SELL signals, no order placement, no auto-trading.
- Never touch the user's old trading-engine code outside `tluxe-trading/`.
- Never commit secrets (`bridge/mt5/.env`, tokens, broker logins).

## Permanent rule: automatic live preview
Live-preview maintenance is part of EVERY development task. Do it without being asked.

1. Keep the Vite dev server running for the whole session: `npm run dev` (port 5180, HMR on), started in the background.
   Before starting it, check whether it is already up (`curl -s localhost:5180`). Never start a second copy.
2. After each meaningful change: save → let HMR update → run `npm run preview:check`
   (renders each page, fails on console/page errors, checks there is exactly one bridge polling loop,
   and makes a component edit to confirm HMR works without a full reload or losing state).
3. Restart the dev server only when required (vite config, dependencies, env, failed HMR). Do not restart it after every edit.
4. The external artifact preview (claude.ai artifact) is a static build and cannot receive HMR.
   After a meaningful, verified change, rebuild with `npx vite build --base=./ --outDir <scratchpad>/preview-dist`
   and republish it to the same artifact URL. Do not claim it updates live.
   Current artifact: https://claude.ai/artifact/QK44Njt3D8GibYBY5UWepE
5. The cloud dev server (localhost:5180 in the container) is not reachable from the user's own devices.
   Say so honestly. On their PC, `npm run dev` gives true HMR.

## HMR / data-safety architecture (keep it this way)
- Providers are connected ONCE in `src/main.tsx` (outside React), with `import.meta.hot.dispose` teardown.
  Never connect providers from a React effect: React Refresh re-runs effects and would reconnect feeds.
- `connectServices` is idempotent, and `Mt5Provider.connect` clears existing timers first, so there are never duplicate polling loops.
- Candles are upserted by timestamp, so there are no duplicate candles. Stores are per instrument, so there is no cross-instrument leakage.
- The selected instrument, chart timeframes, S&R settings and MT5 config persist in localStorage, so they survive reloads.
- When a real provider is connected, after edits verify: one subscription per stream, no duplicate candles or quotes,
  no stale old connection, no cross-instrument data (Settings → Feed panel, plus `preview:check`).

## Checks before committing
`npm run check` (typecheck, lint, tests, build) and `python -m unittest discover -s tests` in `bridge/mt5`.
