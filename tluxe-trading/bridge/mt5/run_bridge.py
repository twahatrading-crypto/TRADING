"""Start the Trading by TLUXE MT5 bridge.  Usage (Windows, MT5 running):  python run_bridge.py"""
import logging
import sys
from pathlib import Path

from tluxe_mt5_bridge.config import ConfigError, from_env, load_dotenv
from tluxe_mt5_bridge.server import serve
from tluxe_mt5_bridge.terminal import Terminal


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    load_dotenv(Path(__file__).with_name(".env"))
    try:
        cfg = from_env()
    except ConfigError as exc:
        logging.error("%s", exc)
        return 2
    term = Terminal(cfg)
    httpd = serve(cfg, term)
    logging.info("TLUXE MT5 bridge listening on http://%s:%s (origins: %s)", cfg.host, cfg.port, ", ".join(cfg.allowed_origins))
    if not cfg.server_timezone:
        logging.warning("TLUXE_MT5_SERVER_TIMEZONE not set: will try to detect the server offset from live ticks.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
