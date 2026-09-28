"""Start the Trading by TLUXE Databento market-data bridge (MARKET DATA ONLY - no order entry).

Windows: use start_bridge.cmd (runs THIS folder's .venv interpreter by absolute path).
Exit codes: 0 stopped · 2 bad configuration (e.g. DATABENTO_API_KEY missing) · 3 another bridge running · 5 port taken.
"""
import logging
import os
import signal
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from tluxe_databento_bridge.config import ConfigError, from_env, load_dotenv  # noqa: E402
from tluxe_databento_bridge.manager import Manager  # noqa: E402
from tluxe_databento_bridge.redact import Redactor, install_log_redaction  # noqa: E402
from tluxe_databento_bridge.server import serve  # noqa: E402

EXIT_CONFIG, EXIT_DUPLICATE, EXIT_PORT = 2, 3, 5


class InstanceLock:
    """One bridge per folder (pid lock file, stale locks are taken over)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.held = False

    def holder(self) -> str:
        try:
            return self.path.read_text().strip()
        except OSError:
            return "?"

    def acquire(self) -> bool:
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            pid = self.holder()
            if pid.isdigit() and _alive(int(pid)):
                return False
            self.path.unlink(missing_ok=True)
            return self.acquire()
        with os.fdopen(fd, "w") as f:
            f.write(str(os.getpid()))
        self.held = True
        return True

    def release(self) -> None:
        if self.held:
            self.path.unlink(missing_ok=True)
            self.held = False


def _status_log(hub, every_s: float = 60.0) -> None:
    """Once a minute, write what was ACTUALLY received (contract, last event, last real trade / OHLCV bar) to the
    service's own log - the operator's real-data proof in the Railway log view. Never the key or the bridge token."""
    import threading

    def loop() -> None:
        while True:
            time.sleep(every_s)
            try:
                s = hub.status_summary("GC", with_prices=True)
                t, b = s.get("lastTrade") or {}, s.get("lastBar") or {}
                logging.info("GC status: contract=%s status=%s lastEvent=%s ageMs=%s trades=%s ohlcvBars=%s verifiedByRealData=%s "
                             "lastTrade=%s x%s @%s lastBar[%s] O=%s H=%s L=%s C=%s V=%s",
                             s["activeContract"], s["status"], s["lastEventUtc"], s["lastEventAgeMs"], s["received"]["trades"],
                             s["received"]["ohlcvBars"], s["verifiedByRealData"], t.get("price"), t.get("size"), t.get("timeUtc"),
                             b.get("timeUtc"), b.get("open"), b.get("high"), b.get("low"), b.get("close"), b.get("volume"))
            except Exception:  # noqa: BLE001 - status logging must never stop the bridge
                logging.exception("status log failed")

    threading.Thread(target=loop, name="gc-status-log", daemon=True).start()


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _setup_logging() -> None:
    """LOG_FORMAT=json (containers) -> one JSON object per line; text otherwise. Redaction is added afterwards."""
    if os.environ.get("LOG_FORMAT", "").lower() == "json":
        import json as _json

        class _Json(logging.Formatter):
            def format(self, r: logging.LogRecord) -> str:
                return _json.dumps({"ts": self.formatTime(r, "%Y-%m-%dT%H:%M:%S"), "level": r.levelname, "logger": r.name, "msg": r.getMessage()})

        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(_Json())
        logging.basicConfig(level=logging.INFO, handlers=[h])
    else:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def main() -> int:
    _setup_logging()
    load_dotenv(HERE / ".env")
    install_log_redaction(Redactor(os.environ.get("DATABENTO_API_KEY", ""), os.environ.get("TLUXE_DB_BRIDGE_TOKEN", "")))
    try:
        cfg = from_env()
    except ConfigError as exc:
        logging.error("%s", exc)
        return EXIT_CONFIG
    lock = InstanceLock(HERE / ".bridge.lock")
    if not lock.acquire():
        logging.error("Another TLUXE Databento bridge is already running (pid %s). Refusing to start a second one.", lock.holder())
        return EXIT_DUPLICATE
    try:
        mgr = Manager(cfg)
        try:
            httpd = serve(cfg, mgr.hub)
        except OSError as exc:
            logging.error("Cannot listen on %s:%s (%s) - is the port already in use?", cfg.host, cfg.port, exc)
            return EXIT_PORT
        mgr.start()
        _status_log(mgr.hub)
        logging.info("TLUXE Databento bridge on http://%s:%s · dataset GLBX.MDP3 · plan %s (schemas %s; never mbp-10%s) · mode %s · origins %s", cfg.host, cfg.port, cfg.plan, ", ".join(["trades", "ohlcv-1m"] + (["mbo"] if cfg.depth_plan else [])), "" if cfg.depth_plan else ", never mbo", cfg.contract_mode, ", ".join(cfg.allowed_origins))
        def _stop(*_):  # SIGTERM (container stop / redeploy) -> same clean shutdown as Ctrl+C
            # Once only: a repeated SIGTERM (e.g. sent to the whole process group) must not interrupt the cleanup.
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, _stop)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            mgr.stop()
            httpd.server_close()
        return 0
    finally:
        lock.release()


if __name__ == "__main__":
    sys.exit(main())
