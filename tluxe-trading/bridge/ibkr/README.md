# TLUXE IBKR COMEX Level-2 depth bridge (cloud Windows VPS)

IBKR is TLUXE's **depth / Level-2 source only**. Trades, history, OHLCV, exchange volume, footprint and CVD stay on
**Databento** — nothing about Databento changes.

```
IB Gateway (VPS, 127.0.0.1:4001)  --TWS API-->  TLUXE IBKR depth bridge (VPS)  --outbound wss-->  TLUXE gateway (Railway) /bridge/ibkr
                                                                                                         |
any browser, any device  --same-origin HTTPS-->  /api/ibkr/status | /api/ibkr/book | /api/ibkr/updates  <--+
```

- **Home PC required: NO** — once this runs on the VPS, nothing on your home computer is involved.
- **Cloud VPS required: YES** — IB Gateway needs a Windows (or Linux) desktop session to log in.
- **Permanent zero-touch authentication: NOT CLAIMED.** IB Gateway requires an authenticated login. Its daily
  auto-restart normally carries the session through the trading week, but IBKR can require a fresh login (with 2FA)
  after the weekly reset. TLUXE then shows **IBKR AUTH REQUIRED** and stops depth features — it never shows stale depth.

## What the bridge does (and does not)

- `reqContractDetails` resolves the **genuine** COMEX contract that Databento is trading (the gateway sends e.g.
  `GCZ6` / `SIZ6`): exact root, local symbol, exchange COMEX, USD, trading class (SI — never the micro SIL), standard
  multiplier. No contract id is hard-coded; no "front month" is guessed (the earliest listed expiry is often not the
  traded one).
- `reqMktDepth(reqId, contract{conId, exchange=COMEX}, rows=10, isSmartDepth=False)` — **direct** COMEX depth, not SMART.
- `updateMktDepth` / `updateMktDepthL2` rows (position, operation 0/1/2 = insert/update/delete, side 0/1 = ask/bid,
  price, size, market-maker tag when supplied) are applied with IBKR's **row** semantics and converted to price-level
  changes (new size per price, 0 = removed), numbered with a contiguous per-root sequence.
- IBKR depth rows carry **no exchange timestamp**; TLUXE uses the **VPS receive time**.
- Depth type: **MBP (aggregated price levels)**. IBKR's depth API provides no order ids → **MBO: NOT PROVEN** and
  never labelled MBO.
- The book is **cleared** (and rebuilt from a fresh subscription) on: API connect / disconnect, IBKR 317 (depth reset),
  1101 / 1102 (connectivity restored), 1100 / 2110 (server link lost), farm loss, an inconsistent row operation,
  20 s without depth (STALE), a contract change. Uncertain depth is never kept.
- States: `CONNECTING` `LIVE` `STALE` `RECONNECTING` `AUTH_REQUIRED` `OFFLINE` `NOT_ENTITLED` (354 / 10092 / 10090 / 309).
  `AUTH_REQUIRED` = IB Gateway is running but its API refuses connections (it is at the login screen).
- Market data only: the code never calls an order / account / position method (enforced by a test), and IB Gateway
  should run with **Read-Only API** on. Error texts are scrubbed of account ids before they are logged or sent.

## One-time VPS setup (you do this — Claude never logs in to IBKR)

1. Windows VPS (always on). Install **IB Gateway (stable)** and **Python 3.11**. Clone this repo (e.g. `C:\TLUXE\TRADING`).
2. Start IB Gateway and **log in yourself** (username, password, 2FA — typed only into IB Gateway).
   *Configure → Settings → API → Settings*: Enable ActiveX and Socket Clients **ON**, **Read-Only API ON**,
   Socket port **4001** (live) / 4002 (paper), Allow connections from localhost only **ON**.
   *Configure → Settings → Lock and Exit*: **Auto restart** at a quiet time (daily).
3. Install IBKR's official Python API from the TWS API download (`IBJts\source\pythonclient`).
4. Link token (never paste it into chat or Git): on the VPS run
   `python -c "import secrets,hashlib; t=secrets.token_urlsafe(48); print('TOKEN (VPS .env only):', t); print('SHA256 (Railway):', hashlib.sha256(t.encode()).hexdigest())"`
   - put the TOKEN into `bridge\ibkr\.env` as `TLUXE_IBKR_BRIDGE_TOKEN` (copy `.env.example` first);
   - put ONLY the SHA256 into Railway → TRADING service → Variables → `TLUXE_IBKR_BRIDGE_TOKEN_SHA256`, then deploy.
5. Elevated PowerShell: `powershell -ExecutionPolicy Bypass -File bridge\ibkr\vps\install-ibkr-bridge.ps1 -IbApiPythonClient C:\TWS API\source\pythonclient`
   (creates the venv, verifies `ibapi`, registers the auto-start task "TLUXE IBKR Depth Bridge", disables sleep).
   Add IB Gateway to this user's Startup and enable Windows auto-logon (Sysinternals Autologon) for reboot recovery.

## Evidence first (before trusting the heatmap)

With IB Gateway logged in: `.venv\Scripts\python.exe -m tluxe_ibkr_bridge.capture --gc GCZ6 --si SIZ6 --seconds 120`
records every raw depth callback (depth fields only) and prints which fields IBKR actually supplied for GC and SI
(bid / ask rows, insert / update / delete, market-maker tag, error codes such as 354 / 10092 = not entitled).
If entitlement is missing or fields are absent: **stop** — TLUXE shows NOT ENTITLED / DATA UNAVAILABLE, nothing is faked.

## Acceptance test (home PC off)

1. Railway: `TLUXE_IBKR_BRIDGE_TOKEN_SHA256` set → `/api/config` reports `ibkrDepth: true`.
2. VPS: IB Gateway logged in, task running → `/api/ibkr/status`: `link.connected: true`, GC and SI `LIVE`, contracts = Databento's.
3. Trading by TLUXE → Liquidity Heatmap: `TRADES · DATABENTO LIVE`, `DEPTH · IBKR LIVE`, IBKR SESSION strip, COB populated, heatmap bands.
4. Close every browser on the home PC, shut it down / disconnect it.
5. From another device: GC → SI → GC — depth keeps updating (last depth time advancing); browser network log shows only
   the TLUXE domain (no localhost / 127.0.0.1 / home IP).
6. Stop IB Gateway on the VPS → `DEPTH · IBKR AUTH REQUIRED` or `OFFLINE`, COB unavailable, no bands; Databento trades stay LIVE.
