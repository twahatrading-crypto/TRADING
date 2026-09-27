"""Start the Trading by TLUXE AI backend (READ-ONLY assistant; OpenAI Responses API).

Windows: use start_ai.cmd (runs THIS folder's .venv interpreter by absolute path).
Exit codes: 0 stopped · 2 bad configuration (e.g. TLUXE_AI_TOKEN missing) · 3 another backend running · 5 port taken.
A missing OPENAI_API_KEY is NOT fatal: the backend starts and reports NOT_CONFIGURED ("Not Connected").
"""
import logging
import os
import signal
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from tluxe_ai_bridge.config import ConfigError, from_env, load_dotenv  # noqa: E402
from tluxe_ai_bridge.provider import OpenAIProvider  # noqa: E402
from tluxe_ai_bridge.redact import Redactor, install_log_redaction  # noqa: E402
from tluxe_ai_bridge.server import serve  # noqa: E402

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


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    load_dotenv(HERE / ".env")
    install_log_redaction(Redactor(os.environ.get("OPENAI_API_KEY", ""), os.environ.get("TLUXE_AI_TOKEN", "")))
    try:
        cfg = from_env()
    except ConfigError as exc:
        logging.error("%s", exc)
        return EXIT_CONFIG
    lock = InstanceLock(HERE / ".bridge.lock")
    if not lock.acquire():
        logging.error("Another TLUXE AI backend is already running (pid %s). Refusing to start a second one.", lock.holder())
        return EXIT_DUPLICATE
    try:
        provider = OpenAIProvider(cfg)
        try:
            httpd = serve(cfg, provider, int(time.time() * 1000))
        except OSError as exc:
            logging.error("Port %s on %s is already in use (%s).", cfg.port, cfg.host, exc)
            return EXIT_PORT
        logging.info("TLUXE AI backend on http://%s:%s · OpenAI Responses API · model %s · READ-ONLY (no tools) · origins %s",
                     cfg.host, cfg.port, cfg.model, ", ".join(cfg.allowed_origins))
        if not cfg.configured:
            logging.warning("OPENAI_API_KEY is not set in %s - TLUXE AI reports Not Connected until it is.", HERE / ".env")
        else:
            h = provider.health(force=True)
            logging.info("OpenAI verification: %s%s", h["status"], f" - {h['reason']}" if h.get("reason") else "")
        def _stop(*_):  # SIGTERM / console close -> same clean shutdown as Ctrl+C (lock released)
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, _stop)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            httpd.server_close()
        return 0
    finally:
        lock.release()


if __name__ == "__main__":
    sys.exit(main())
