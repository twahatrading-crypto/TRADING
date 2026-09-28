"""Container entrypoint for tluxe-web / tluxe-auth-gateway: runs the TLUXE gateway and - when DATABENTO_API_KEY is set -
the TLUXE Databento bridge next to it in the SAME container, as two supervised processes.

    python entrypoint.py     (Dockerfile CMD; Railway restarts the container if the gateway exits)

The gateway package itself never starts processes (its tests forbid it) and never receives the Databento key.

Why: the cloud needs real COMEX data without another Railway service or anything on the owner's PC. When the gateway
has DATABENTO_API_KEY and no external TLUXE_DATABENTO_URL, it starts bridge/databento (official `databento` SDK,
GLBX.MDP3, GC / SI via Databento continuous symbology `.v.0` -> the actual active contract) on the container's own
loopback and proxies it exactly like an external Databento service.

Secrets:
  * DATABENTO_API_KEY goes ONLY to the bridge process; the gateway process is started without it, so no gateway endpoint,
    log or AI context can ever contain it. Bridge log lines are redacted again here before they are printed.
  * The gateway <-> bridge token is random per boot (no extra variable, never leaves the container).
Nothing here generates data: if the key is missing / rejected / not entitled, Databento reports NOT CONNECTED /
ERROR / UNAVAILABLE and the UI shows DATA UNAVAILABLE.
"""
from __future__ import annotations

import asyncio
import logging
import os
import secrets
import signal
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tluxe_gateway.config import Secret  # noqa: E402
from tluxe_gateway.logs import Redactor, setup_logging  # noqa: E402

log = logging.getLogger("tluxe.entrypoint")

DEFAULT_DIR = "/app/databento"
DEFAULT_PORT = 8766
# Bridge options the operator may set on the gateway service; everything else in the gateway env stays private to it.
PASS_THROUGH = ("TLUXE_DB_PLAN", "TLUXE_DB_CONTRACT_MODE", "TLUXE_DB_CONTRACT_GC", "TLUXE_DB_CONTRACT_SI", "TLUXE_DB_MAX_TRADES",
                "TLUXE_DB_MAX_FRAMES", "TLUXE_DB_PUBLISH_MS", "TLUXE_DB_REPLAY_HOURS", "TLUXE_DB_REPLAY_MARGIN_MIN", "LOG_LEVEL")
BACKOFF_MIN_S, BACKOFF_MAX_S = 2.0, 60.0
AUTH_EXIT_BACKOFF_S = 300.0  # exit code 2 = bad configuration (e.g. rejected key): do not hammer Databento


@dataclass
class EmbeddedDatabento:
    api_key: Secret = field(repr=False)
    token: Secret = field(repr=False)
    port: int = DEFAULT_PORT
    bridge_dir: str = DEFAULT_DIR
    python: str = sys.executable  # TLUXE_DB_PYTHON: local testing with another interpreter; the image uses its own
    options: dict = field(default_factory=dict)
    state: dict = field(default_factory=lambda: {"running": False, "starts": 0, "lastExit": None, "pid": None})

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @classmethod
    def from_env(cls, env: dict) -> "EmbeddedDatabento | None":
        """None unless a key is present, no external Databento service is configured and embedding is not disabled."""
        key = (env.get("DATABENTO_API_KEY") or "").strip()
        if not key or (env.get("TLUXE_DATABENTO_URL") or "").strip() or (env.get("TLUXE_DATABENTO_EMBEDDED") or "1").strip() == "0":
            return None
        port_raw = (env.get("TLUXE_DB_EMBEDDED_PORT") or "").strip()
        port = int(port_raw) if port_raw.isdigit() and 1 <= int(port_raw) <= 65535 else DEFAULT_PORT
        return cls(api_key=Secret(key), token=Secret(secrets.token_urlsafe(48)), port=port,
                   bridge_dir=(env.get("TLUXE_DB_BRIDGE_DIR") or DEFAULT_DIR).strip(),
                   python=(env.get("TLUXE_DB_PYTHON") or sys.executable).strip(),
                   options={k: env[k] for k in PASS_THROUGH if (env.get(k) or "").strip()})

    def install(self, env: dict) -> None:
        """Point the gateway at the embedded bridge and remove the key from the gateway's own environment."""
        env.pop("DATABENTO_API_KEY", None)
        env["TLUXE_DATABENTO_URL"] = self.url
        env["TLUXE_DB_BRIDGE_TOKEN"] = self.token.reveal()

    def child_env(self) -> dict:
        base = {k: os.environ[k] for k in ("PATH", "HOME", "LANG", "TZ", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE") if k in os.environ}
        return {
            **base,
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "LOG_FORMAT": "json",
            "TLUXE_DB_PLAN": "standard",
            **self.options,
            # Fixed: real CME Globex MDP 3.0 only, loopback only, key + token for this child only.
            "TLUXE_DB_DATASET": "GLBX.MDP3",
            "TLUXE_DB_BRIDGE_HOST": "127.0.0.1",
            "TLUXE_DB_BRIDGE_PORT": str(self.port),
            "DATABENTO_API_KEY": self.api_key.reveal(),
            "TLUXE_DB_BRIDGE_TOKEN": self.token.reveal(),
        }

    def command(self) -> list[str]:
        return [self.python, str(Path(self.bridge_dir) / "run_bridge.py")]

    async def supervise(self, stop: asyncio.Event, redact=lambda s: s) -> None:
        """Keep the bridge running until `stop` is set; restart with back-off; stream its (already redacted) logs."""
        backoff = BACKOFF_MIN_S
        while not stop.is_set():
            try:
                proc = await asyncio.create_subprocess_exec(*self.command(), cwd=self.bridge_dir, env=self.child_env(),
                                                            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            except OSError as exc:
                log.error("cannot start the embedded Databento bridge (%s)", type(exc).__name__)
                code = None
            else:
                self.state.update(running=True, pid=proc.pid, starts=self.state["starts"] + 1)
                log.info("embedded Databento bridge started (pid %s, GLBX.MDP3, loopback :%s)", proc.pid, self.port)
                pump = asyncio.create_task(self._pump(proc, redact))
                waiter = asyncio.create_task(proc.wait())
                stopper = asyncio.create_task(stop.wait())
                await asyncio.wait({waiter, stopper}, return_when=asyncio.FIRST_COMPLETED)
                if not waiter.done():
                    await self._terminate(proc)
                stopper.cancel()
                code = proc.returncode
                await asyncio.gather(pump, return_exceptions=True)
                self.state.update(running=False, pid=None, lastExit=code)
                if stop.is_set():
                    return
                log.warning("embedded Databento bridge exited (code %s) - restarting", code)
            wait = AUTH_EXIT_BACKOFF_S if code == 2 else backoff
            backoff = min(BACKOFF_MAX_S, backoff * 2)
            try:
                await asyncio.wait_for(stop.wait(), wait)
            except asyncio.TimeoutError:
                pass

    async def _pump(self, proc, redact) -> None:
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                return
            text = redact(line.decode("utf-8", "replace").rstrip())
            if text:
                log.info("[databento] %s", text[:2000])

    @staticmethod
    async def _terminate(proc) -> None:
        try:
            proc.send_signal(signal.SIGTERM)
            await asyncio.wait_for(proc.wait(), 10)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
        except ProcessLookupError:
            pass


def gateway_env(env: dict, embedded: "EmbeddedDatabento | None") -> dict:
    """The gateway's environment: everything EXCEPT the Databento key; pointed at the embedded bridge when there is one."""
    out = {k: v for k, v in env.items() if k != "DATABENTO_API_KEY"}
    if embedded is not None:
        embedded.install(out)
        out["TLUXE_DATABENTO_SOURCE"] = "embedded"
    return out


async def run(env: dict | None = None, gateway_cmd: list[str] | None = None) -> int:
    env = dict(os.environ if env is None else env)
    embedded = EmbeddedDatabento.from_env(env)
    redact = Redactor(*((embedded.api_key.reveal(), embedded.token.reveal()) if embedded else ()))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            pass
    bridge = asyncio.create_task(embedded.supervise(stop, redact)) if embedded else None
    log.info("Databento: %s", "embedded bridge (GLBX.MDP3, key held by the bridge process only)" if embedded
             else ("external service (TLUXE_DATABENTO_URL)" if env.get("TLUXE_DATABENTO_URL") else "not configured (DATABENTO_API_KEY not set) - NOT CONNECTED"))
    gw = await asyncio.create_subprocess_exec(*(gateway_cmd or [sys.executable, "-m", "tluxe_gateway"]), env=gateway_env(env, embedded),
                                              cwd=str(Path(__file__).resolve().parent))
    waiter = asyncio.create_task(gw.wait())
    stopper = asyncio.create_task(stop.wait())
    await asyncio.wait({waiter, stopper}, return_when=asyncio.FIRST_COMPLETED)
    if not waiter.done():
        await EmbeddedDatabento._terminate(gw)
    stopper.cancel()
    stop.set()  # gateway gone (or SIGTERM): stop the bridge too, so Railway restarts a clean container
    if bridge is not None:
        await asyncio.gather(bridge, return_exceptions=True)
    return gw.returncode or 0


def main() -> int:
    setup_logging((os.environ.get("LOG_FORMAT") or "json").lower(), Redactor(), os.environ.get("LOG_LEVEL", "INFO"))
    return asyncio.run(run())


if __name__ == "__main__":
    sys.exit(main())
