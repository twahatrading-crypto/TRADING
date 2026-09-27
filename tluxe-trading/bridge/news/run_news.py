"""Start the Trading by TLUXE news backend (Trading Economics calendar / news - read-only market information).

Windows: use start_news.cmd (runs THIS folder's .venv interpreter by absolute path).
Exit codes: 0 stopped · 2 bad configuration (e.g. TLUXE_NEWS_TOKEN missing) · 3 another backend running · 5 port taken.
A missing TRADING_ECONOMICS_API_KEY is NOT fatal: every feed then reports NOT CONFIGURED (DATA UNAVAILABLE in TLUXE).
"""
import logging
import os
import signal
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from tluxe_news_bridge.config import ConfigError, from_env, load_dotenv  # noqa: E402
from tluxe_news_bridge.feeds import NewsService  # noqa: E402
from tluxe_news_bridge.redact import Redactor, install_log_redaction  # noqa: E402
from tluxe_news_bridge.server import serve  # noqa: E402

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
    install_log_redaction(Redactor(os.environ.get("TRADING_ECONOMICS_API_KEY", ""), os.environ.get("TLUXE_NEWS_TOKEN", "")))
    try:
        cfg = from_env()
    except ConfigError as exc:
        logging.error("%s", exc)
        return EXIT_CONFIG
    lock = InstanceLock(HERE / ".bridge.lock")
    if not lock.acquire():
        logging.error("Another TLUXE news backend is already running (pid %s). Refusing to start a second one.", lock.holder())
        return EXIT_DUPLICATE
    try:
        svc = NewsService(cfg)
        try:
            httpd = serve(cfg, svc, int(time.time() * 1000))
        except OSError as exc:
            logging.error("Cannot listen on %s:%s (%s) - is the port already in use?", cfg.host, cfg.port, exc)
            return EXIT_PORT
        svc.start()
        logging.info("TLUXE news backend on http://%s:%s · calendar %s · macro news %s · breaking news NOT CONFIGURED · streaming %s · origins %s",
                     cfg.host, cfg.port, "Trading Economics" if cfg.te_configured and cfg.calendar_enabled else "NOT CONFIGURED",
                     "Trading Economics" if cfg.te_configured and cfg.news_enabled else "NOT CONFIGURED", cfg.streaming, ", ".join(cfg.allowed_origins))
        if not cfg.te_configured:
            logging.warning("TRADING_ECONOMICS_API_KEY is not set in %s - all news feeds report NOT CONFIGURED.", HERE / ".env")

        def _stop(*_):
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, _stop)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            svc.stop()
            httpd.server_close()
        return 0
    finally:
        lock.release()


if __name__ == "__main__":
    sys.exit(main())
