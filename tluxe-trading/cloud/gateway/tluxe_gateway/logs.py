"""Structured logging with secret redaction (every handler, every record, exceptions included)."""
from __future__ import annotations

import json
import logging
import re
import sys
import time

_KEY_LIKE = re.compile(r"\b(sk-[A-Za-z0-9_\-]{8,}|db-[A-Za-z0-9]{8,})")
_URL_KEY = re.compile(r"([?&](?:c|client|key|apikey|api_key|token)=)[^&\s\"']+", re.I)
_DSN_PW = re.compile(r"(postgres(?:ql)?://[^:/\s]+:)[^@\s]+@", re.I)
_BEARER = re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]{8,}")


class Redactor:
    def __init__(self, *secrets: str) -> None:
        self._secrets = sorted({s for s in secrets if s and len(s) >= 4}, key=len, reverse=True)

    def __call__(self, text: object) -> str:
        s = str(text)
        for secret in self._secrets:
            s = s.replace(secret, "****")
        s = _DSN_PW.sub(r"\1****@", s)
        s = _URL_KEY.sub(r"\1****", s)
        s = _BEARER.sub(r"\1****", s)
        return _KEY_LIKE.sub("****", s)


class _Filter(logging.Filter):
    def __init__(self, redact: Redactor) -> None:
        super().__init__()
        self.redact = redact

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:  # pragma: no cover
            msg = str(record.msg)
        if record.exc_info:
            import traceback

            msg += "\n" + "".join(traceback.format_exception(*record.exc_info))
            record.exc_info = None
            record.exc_text = None
        record.msg = self.redact(msg)
        record.args = ()
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
                           "level": record.levelname, "logger": record.name, "msg": record.getMessage()}, ensure_ascii=False)


def setup_logging(fmt: str, redact: Redactor, level: str = "INFO") -> None:
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(JsonFormatter() if fmt == "json" else logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    h.addFilter(_Filter(redact))
    root.addHandler(h)
    root.setLevel(level)
    for noisy in ("aiohttp.access", "psycopg", "psycopg.pool"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
