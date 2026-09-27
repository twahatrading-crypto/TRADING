# TLUXE MT5 remote link (Windows VPS)

This link runs on the Windows machine that runs MetaTrader 5. It lets the TLUXE cloud gateway read the local MT5
bridge **without any inbound port**: the link dials out over **WSS** to `wss://<domain>/bridge/mt5` and answers
read-only requests.

* **Read-only.** Only `GET` is accepted, and only on these paths:
  * `/v1/health`
  * `/v1/symbols`
  * `/v1/symbol/<name>`
  * `/v1/quote/<name>`
  * `/v1/rates/<name>?timeframe=..&count=..`

  Anything else is refused with 403 before it reaches MT5. There are no order, trade or close paths.
* **Authentication.** The link sends `TLUXE_MT5_BRIDGE_TOKEN` (at least 32 random characters, different from the
  local bridge token). The gateway stores only its SHA-256 (`TLUXE_MT5_BRIDGE_TOKEN_SHA256`).
* **Token rotation.** Put the new hash next to the old one on the gateway, update this `.env`, restart the link,
  then remove the old hash.
* **Message integrity.** Every message carries a strictly increasing `seq` and a `ts`. Replays, out-of-order
  messages and timestamps more than ±30 s off are rejected, so keep the clock synced.
* **Heartbeat and reconnect.** A heartbeat goes out every 10 s with the terminal state. If the link sees nothing
  from the gateway for 45 s, it treats the connection as stale and reconnects with back-off from 2 s to 60 s. After
  an authentication rejection it waits 300 s.
* **Local bridge.** The local token (`TLUXE_BRIDGE_TOKEN`, read from `..\.env`) stays on this machine. The local
  bridge must be on loopback (`TLUXE_LOCAL_BRIDGE_URL=http://127.0.0.1:8765`).

## Run

1. Start the local MT5 bridge as usual: `..\start_bridge.cmd`.
2. Copy `.env.example` to `.env` and fill it in. Never commit `.env`.
3. Run `start_remote_link.cmd`. The first run creates a `.venv` and installs `websockets`.
4. Make both scripts start at logon with Task Scheduler ("At log on", restart on failure).

## Tests (test data only; needs the gateway package)

```
pip install -r requirements.txt -r ..\..\..\cloud\gateway\requirements.txt
python -m unittest discover -s tests
```

The tests run a stand-in local bridge and the real gateway in-process. Nothing contacts MT5 or the network.

The full deployment guide is `docs/CLOUD_DEPLOYMENT.md`.
