# TLUXE MT5 Bridge (private)

A small local HTTP service that reads **market data only** from your running
MetaTrader 5 terminal and serves it to Trading by TLUXE.

```
MT5 Terminal ──(MetaTrader5 Python API)──▶ TLUXE MT5 bridge ──(HTTP + Bearer token, 127.0.0.1)──▶ TLUXE app
```

- Read-only: it never places, modifies or closes orders and has no endpoint that could.
- Private: it binds to `127.0.0.1` by default and every request needs the Bearer token.
- No secrets in the repo: configuration lives in `.env`, which git ignores. `.env.example` only lists the variable names.
- Credentials never reach the logs. The account login is always masked (`****123`).

## Requirements

- Windows PC with **MetaTrader 5 installed, open and logged in** to your broker. A demo account is fine.
- **Python 3.11 or newer**, 64-bit (from python.org; tick "Add python.exe to PATH").
- The official `MetaTrader5` Python package only runs on Windows.

## Setup (Windows, one time)

```powershell
cd path\to\TRADING\tluxe-trading\bridge\mt5
py -3.11 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Then open `.env` in a text editor and set:

| Variable | Value |
| --- | --- |
| `TLUXE_BRIDGE_TOKEN` | The random string printed above (at least 32 characters). |
| `TLUXE_MT5_SERVER_TIMEZONE` | Your broker's trade-server timezone as an IANA name. Many brokers use `Europe/Athens` or `Asia/Nicosia` (GMT+2/+3 with DST); others use `UTC`. Ask your broker if you're unsure. |
| `TLUXE_BRIDGE_ALLOWED_ORIGINS` | Leave the default (`localhost`/`127.0.0.1` on ports 5181 and 4181). If the bridge logs `Rejected browser origin ...`, add that origin here and restart the bridge. |
| `TLUXE_MT5_TERMINAL_PATH` | Optional. Only needed if several terminals are installed, e.g. `C:\Program Files\MetaTrader 5\terminal64.exe`. |
| `TLUXE_MT5_LOGIN` / `PASSWORD` / `SERVER` | **Leave empty.** The bridge uses the session already logged in to the terminal. |

## Run

1. Start MetaTrader 5 and log in. (The bridge adds the symbols it reads to Market Watch automatically.)
2. Start the bridge:
   ```powershell
   cd path\to\TRADING\tluxe-trading\bridge\mt5
   .venv\Scripts\activate
   python run_bridge.py
   ```
   It should log `TLUXE MT5 bridge listening on http://127.0.0.1:8765`.
3. Start the app on the same PC (`npm install` once, then `npm run dev` in `tluxe-trading`) and open `http://localhost:5181`.
4. In the app, go to **Settings**:
   - Tick **Enable MT5 market data**.
   - Set the bridge URL to `http://127.0.0.1:8765`.
   - Paste the token.
   - Click **Save & reconnect**.
5. Settings now shows the bridge, terminal, account (masked), time basis and the **symbol discovery** table. Fix any `ambiguous` or `not-found` rows with an override (the exact broker symbol name).

## Check it

With the bridge running, this should return JSON. Use your own token:

```powershell
curl.exe -H "Authorization: Bearer YOUR_TOKEN" http://127.0.0.1:8765/v1/health
curl.exe -H "Authorization: Bearer YOUR_TOKEN" "http://127.0.0.1:8765/v1/rates/XAUUSD?timeframe=H1&count=5"
```

To cross-check against the terminal:

- Compare the last few closed XAUUSD M15/H1 candles in the app's chart legend with the MT5 **Data Window**. Times are shown in UTC in TLUXE, but MT5 shows broker server time.
- Compare Bid/Ask in the TLUXE market bar with MT5 **Market Watch**.

## API (all GET, all require `Authorization: Bearer <token>`)

| Endpoint | Returns |
| --- | --- |
| `/v1/health` | bridge version/start/heartbeat, terminal state (`CONNECTED`, `NOT_RUNNING`, `DISCONNECTED`, `INITIALIZING`), masked account, time basis |
| `/v1/symbols` | every terminal symbol with digits, point, tick size, contract size, path |
| `/v1/symbol/{name}` | one symbol's metadata |
| `/v1/quote/{name}` | bid, ask, last (null for spot/CFD), spread in points, tick time in UTC ms |
| `/v1/rates/{name}?timeframe=M1…D1&count=N` | native MT5 bars. `t` is the UTC open time and `st` is the raw server time. Also returns `o h l c`, tick volume `tv`, real volume `rv` (null if the broker has none), spread `sp` and `closed` |

Errors return `{ "error": { "code", "message" } }`, where the code is one of `UNAUTHORIZED`, `MT5_NOT_RUNNING`, `SYMBOL_NOT_FOUND`, `BAD_TIMEFRAME`, `NO_QUOTE`, `TIMEZONE_UNRESOLVED` or `MT5_PACKAGE_MISSING`.

## Time handling

MT5 bar and tick times are **broker server wall-clock time**, not UTC. The bridge converts them to UTC:

1. **IANA timezone** (`TLUXE_MT5_SERVER_TIMEZONE`) is recommended. It is DST-correct for every historical bar.
2. **Detected offset**: if no timezone is set, the offset is measured from a fresh tick (to the nearest 30 min). This is only correct for bars in the same DST period, and the app says so.
3. **Unresolved**: if neither works (e.g. the market is closed and there is no fresh tick), rates and quote times are refused with `TIMEZONE_UNRESOLVED`. They are never mislabelled as UTC.

## Security notes

- Keep the default `TLUXE_BRIDGE_HOST=127.0.0.1`. Binding to `0.0.0.0` is refused unless you also set `TLUXE_BRIDGE_ALLOW_ALL_INTERFACES=1`.
- If the app runs on a different machine, bind to a **private LAN** address only and add that app origin to `TLUXE_BRIDGE_ALLOWED_ORIGINS`. Never port-forward the bridge to the internet.
- Rotate the token by editing `.env` and restarting the bridge, then update it in the app's Settings.

## Tests

```bash
python -m unittest discover -s tests
```

The tests use a fake `MetaTrader5` module defined inside the test file only.
