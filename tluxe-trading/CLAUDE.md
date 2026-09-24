# Trading by TLUXE — permanent project rules for Claude (STRICT)

## 1. The only project you may touch
`C:\Users\twaha\TRADING\tluxe-trading` (this `tluxe-trading/` folder of the repo, branch `claude/busy-bohr-n02jao`).
All opening, inspecting, editing, building, running, previewing, testing, restarting, publishing and debugging
stays inside this project.

## 2. Old project: completely off limits
`C:\Users\twaha\OneDrive\Desktop\xauusd-liquidity-engine` must be treated as if it does not exist.
Never open, inspect, edit, run, build, preview, import from, copy from, compare with, use as a fallback,
auto-detect, launch, stop or start it, its processes, or its localhost address.
If an old-project process or preview is detected, do not interact with it. Report it only if it directly blocks this project.
Never add or change anything in the old project's files or CLAUDE.md.

## 3. Never open the old preview
Never open or redirect to `http://localhost:5180` or any preview belonging to xauusd-liquidity-engine.
The project never auto-opens a browser (`open: false` in `vite.config.ts`).

## 4. One active local preview
- Canonical local preview: **http://localhost:5181** (`npm run dev`, HMR, `strictPort`). Production preview: http://localhost:4181.
- Before opening or using a preview, verify that the listening process belongs to this project.
  Never assume a port belongs to this project just because something is listening on it.
- Exactly ONE TLUXE dev server may run at a time.

## 5. If the preview address changes
Stop ONLY the previous TLUXE preview process (never the old project's). Start TLUXE at the new address.
Update every setting that depends on the origin: `vite.config.ts`, the bridge default origins in
`bridge/mt5/tluxe_mt5_bridge/config.py`, `bridge/mt5/.env.example`, the user's bridge `.env` (give the user the command),
READMEs, `scripts/preview-check.cjs` and this file. Remove the old TLUXE address when it is no longer needed.
Open ONLY the newest preview. Leave exactly one TLUXE preview running.

## 6. MT5
- Bridge: **http://127.0.0.1:8765**, a separate process from the frontend (`tluxe-trading\bridge\mt5`).
- The bridge must allow the current preview origin: `http://localhost:5181`, `http://127.0.0.1:5181`
  (plus 4181 for the production preview). A refused origin looks exactly like an offline bridge.
  The bridge logs `Rejected browser origin ...`, and Settings shows which origin is required.
- Keep the token/security setup (Bearer token ≥32 chars, bound to 127.0.0.1, origin allowlist).
  Never expose the token in logs, UI, commits, screenshots or reports.
- REAL MT5 DATA or DATA UNAVAILABLE. Never fabricate market data. Never modify the old project to make MT5 work.

## 7. Live development (HMR)
- Keep the TLUXE dev server running. SAVE → HMR → preview updates. Restart only when required
  (vite config, dependencies, env, failed HMR).
- No duplicate MT5 connections, polling timers, WebSockets, subscriptions or listeners during HMR:
  - Providers are connected ONCE in `src/main.tsx` (outside React), with an `import.meta.hot.dispose` teardown.
    Never connect providers from a React effect.
  - `connectServices` is idempotent, and `Mt5Provider.connect` clears existing timers.
  - Candles are upserted by timestamp. Stores are per instrument.

## 8. One canonical Claude preview
- Canonical: **https://claude.ai/artifact/QK44Njt3D8GibYBY5UWepE**. Update it in place after meaningful, verified UI changes
  (`npx vite build --base=./ --outDir <scratchpad>/preview-dist`, then republish to this URL). Report its version.
- If a new URL is ever unavoidable, make it canonical here, remove the old one from docs/config, never open the old one again,
  and report only the new one.
- The Claude preview is visual/shareable only. The REAL application is the TLUXE local preview plus the MT5 bridge.
  The hosted preview cannot reach the user's MT5, so it shows DATA UNAVAILABLE. Never use fake candles or prices to make it look connected.

## 9. Sidebar (all pages, via `AppShell`)
Dashboard · Trading Strategy (Support & Resistance · Liquidity · Order Blocks SOON · Sweep / Reversal SOON) · Settings.
Support & Resistance and Liquidity open their real pages. Entries live in `src/config/navigation.ts` (`route: null` = disabled SOON).

## 10. Safety check before any process command
Before starting or stopping any Node/Vite/Python process, identify its PID, command line, working/project path and port.
Only act when it is confirmed to belong to `tluxe-trading` (or `tluxe-trading\bridge\mt5` for the MT5 bridge).
Never kill a process based only on its port number.

## 11. Verification after meaningful changes
Check: the correct repository and branch · `npm run typecheck` · relevant tests (`npm test`; for bridge changes also
`python -m unittest discover -s tests` in `bridge/mt5`) · `npm run build` · `npm run preview:check`
(console errors, routing, HMR, a single polling loop) · the sidebar · the MT5 connection where applicable (REAL data,
confirmed with the user on localhost:5181, before saying it works) · that only the correct preview is used ·
that `git status` shows changes only inside `tluxe-trading/` (old project untouched).

## 12. End-of-task report (only these)
1. Files changed in the NEW project
2. Current NEW local preview address
3. Current canonical Claude preview address
4. MT5 status (if relevant)
5. Test/build results
6. Confirmation: OLD PROJECT UNTOUCHED

## Always
No BUY/SELL signals, no order placement, no auto-trading. Never commit secrets (`bridge/mt5/.env`).

## Engines (independent — never mix)
- S&R v1 is LOCKED (`src/engines/sr`, `src/services/sr`, `src/components/sr`). Do not change its behaviour.
- Liquidity v1 (`src/engines/liquidity`, `src/services/liquidity`, `src/components/liquidity`, route `/engines/liquidity`)
  is independent of S&R: its own engines, stores, settings, score and replay. Liquidity never creates trade signals.
