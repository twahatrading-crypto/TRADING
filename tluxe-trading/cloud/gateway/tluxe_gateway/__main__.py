"""Run the TLUXE gateway:  python -m tluxe_gateway   (container CMD; Railway restarts it on failure).

Graceful shutdown: SIGTERM / SIGINT stop accepting connections, close browser streams and the MT5 link with a
"going away" code, cancel background workers and close the database pool (shutdown timeout 15 s).
Exit codes: 0 stopped · 2 bad configuration.
"""
import logging
import os
import sys
from pathlib import Path

from aiohttp import web

from .app import make_app, redactor_for
from .config import ConfigError, from_env, load_dotenv
from .logs import Redactor, setup_logging


def main() -> int:
    load_dotenv(Path.cwd() / ".env")
    try:
        cfg = from_env()
    except ConfigError as exc:
        setup_logging("json" if os.environ.get("TLUXE_ENV") == "production" else "text", Redactor())
        logging.error("configuration error: %s", exc)
        return 2
    setup_logging(cfg.log_format, redactor_for(cfg), os.environ.get("LOG_LEVEL", "INFO"))
    logging.getLogger("tluxe.gateway").info("TLUXE gateway starting (%s) on [%s]:%s · origins %s · services ai=%s databento=%s news=%s · mt5 keys %d",
                                            cfg.env, cfg.host, cfg.port, ", ".join(cfg.allowed_origins), cfg.ai.configured, cfg.databento.configured,
                                            cfg.news.configured, len(cfg.mt5_bridge_keys))
    web.run_app(make_app(cfg), host=cfg.host, port=cfg.port, access_log=None, shutdown_timeout=15, print=None, handle_signals=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
