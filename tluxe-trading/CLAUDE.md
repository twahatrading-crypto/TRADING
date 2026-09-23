# Trading by TLUXE — standing rules for Claude

Scope: this repository's `tluxe-trading/` project ONLY
(on the user's PC: `C:\Users\twaha\TRADING\tluxe-trading`).

## Never touch the old project
- Do NOT touch, modify, start, stop, reuse, import from, or depend on
  `C:\Users\twaha\OneDrive\Desktop\xauusd-liquidity-engine` (or any other old trading-engine code).
- Port 5180 belongs to that old project. TLUXE never uses it, and the bridge does not authorise it.
- Never kill a Node/Vite/Python process before identifying its command line AND project path.
  Only ever restart this project's own dev server.

## Data integrity (always)
- Never fabricate market data, show fixture data as live, or claim a connection that does not exist.
  If MT5 is unavailable, show DATA UNAVAILABLE / OFFLINE. Unknown data stays `null` / `—`.
- No BUY/SELL signals, no order placement, no auto-trading.
- Never commit, log, print, screenshot or report secrets (`bridge/mt5/.env`, the bridge token, broker logins).

## Ports
| What | Address |
| --- | --- |
| TLUXE dev server (HMR) | http://localhost:5181 (`npm run dev`, strictPort) |
| TLUXE production preview | http://localhost:4181 (`npm run preview`) |
| MT5 bridge (separate process) | http://127.0.0.1:8765 |

The bridge's `TLUXE_BRIDGE_ALLOWED_ORIGINS` must list `http://localhost:5181` and `http://127.0.0.1:5181`
(plus 4181 for the production preview). A browser origin that is not allowed looks exactly like an
offline bridge. The bridge logs `Rejected browser origin ...` when that happens.

## Permanent rule: local live preview
1. Keep this project's dev server running with HMR for the whole session (`npm run dev`, port 5181).
   Check whether it is already up (`curl -s localhost:5181`) before starting it. Never start a second copy.
2. Every code change must reach the preview through HMR. Restart only when required
   (vite config, dependencies, env, failed HMR). Never make the user restart it.
3. If the server stops, restart THIS project's server only.

## Permanent rule: ONE canonical Claude preview
- Canonical artifact: https://claude.ai/artifact/QK44Njt3D8GibYBY5UWepE
- After every meaningful, verified UI/frontend change, rebuild
  (`npx vite build --base=./ --outDir <scratchpad>/preview-dist`) and republish to THIS URL,
  never as a new artifact. Report the new version number.
- The artifact is a static, hosted preview. It cannot reach the user's Windows MT5 bridge, so it must show
  DATA UNAVAILABLE / NOT CONNECTED. Never insert fake prices or candles to make it look live.
  localhost:5181 on the user's PC is the authoritative REAL application.
- The cloud dev server in this container is not reachable from the user's devices. Say so honestly.

## MT5 bridge rules
- The bridge is a separate process from the frontend. Keep its token/security configuration as is
  (Bearer token ≥32 chars, bound to 127.0.0.1, origin allowlist).
- Providers are connected ONCE in `src/main.tsx` (outside React), with an `import.meta.hot.dispose` teardown.
  Never connect providers from a React effect.
- `connectServices` is idempotent, and `Mt5Provider.connect` clears existing timers. So there are never duplicate
  polling loops, subscriptions or timers after HMR.
- Candles are upserted by timestamp (no duplicates). Stores are per instrument (no cross-instrument leakage).

## Sidebar (must be kept)
Dashboard · Trading Strategy (Support & Resistance · Liquidity SOON · Order Blocks SOON · Sweep / Reversal SOON) · Settings.
- `AppShell` wraps every page and stays mounted across routes.
- Strategy entries live in `src/config/navigation.ts` (`route: null` = disabled SOON).
  Support & Resistance must open the real S&R page.

## Automatic verification after every meaningful change
1. `npm run typecheck`, the relevant tests (`npm test`), and `npm run build`.
   For bridge changes, also run `python -m unittest discover -s tests` in `bridge/mt5`.
2. `npm run preview:check`: renders every page, fails on console errors, checks for exactly one bridge
   polling loop, and confirms HMR works without a full reload or losing state.
3. Check routing: Dashboard ↔ Support & Resistance via the sidebar.
4. Check `git status` only shows changes inside `tluxe-trading/` (the old project is untouched).
5. For market-data changes: confirm REAL MT5 data (with the user, on localhost:5181) before reporting success.
   Never report LIVE from this container, which cannot reach the user's MT5.
6. Republish the canonical artifact and report its version.
