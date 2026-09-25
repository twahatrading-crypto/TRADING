"""Start the Trading by TLUXE MT5 bridge.

Windows: use start_bridge.cmd (runs THIS project's .venv interpreter by absolute path — never a bare
"python" resolved through PATH, which may be a different installation without MetaTrader5).
"""
import importlib.util
import logging
import os
import sys
from pathlib import Path

from tluxe_mt5_bridge.config import ConfigError, from_env, load_dotenv
from tluxe_mt5_bridge.instance import InstanceLock
from tluxe_mt5_bridge.server import serve
from tluxe_mt5_bridge.terminal import Terminal

HERE = Path(__file__).resolve().parent

# Exit codes: 0 stopped · 2 bad configuration · 3 another bridge is running · 4 wrong interpreter · 5 port taken
EXIT_CONFIG, EXIT_DUPLICATE, EXIT_INTERPRETER, EXIT_PORT = 2, 3, 4, 5


def preflight_interpreter() -> bool:
    """Refuse to run a bridge that could only ever answer 'MT5 unavailable' (the old silent failure)."""
    if os.environ.get("TLUXE_BRIDGE_ALLOW_NO_MT5") == "1":
        return True
    if importlib.util.find_spec("MetaTrader5") is not None:
        return True
    logging.error(
        "The MetaTrader5 package is not importable by this interpreter: %s. "
        "Start the bridge with start_bridge.cmd (it uses %s) after 'pip install -r requirements.txt' in that venv.",
        sys.executable,
        HERE / ".venv" / "Scripts" / "python.exe",
    )
    return False


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    load_dotenv(HERE / ".env")
    try:
        cfg = from_env()
    except ConfigError as exc:
        logging.error("%s", exc)
        return EXIT_CONFIG
    if not preflight_interpreter():
        return EXIT_INTERPRETER
    lock = InstanceLock(HERE / ".bridge.lock")
    if not lock.acquire():
        logging.error("Another TLUXE MT5 bridge is already running (pid %s). Refusing to start a second instance.", lock.holder())
        return EXIT_DUPLICATE
    try:
        term = Terminal(cfg)
        try:
            httpd = serve(cfg, term)
        except OSError as exc:
            logging.error("Port %s on %s is already in use (%s). The bridge never shares its port — stop the other process first.", cfg.port, cfg.host, exc)
            return EXIT_PORT
        logging.info("TLUXE MT5 bridge listening on http://%s:%s (origins: %s) · interpreter %s · pid %s", cfg.host, cfg.port, ", ".join(cfg.allowed_origins), sys.executable, os.getpid())
        if not cfg.server_timezone:
            logging.warning("TLUXE_MT5_SERVER_TIMEZONE not set: will try to detect the server offset from live ticks.")
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
