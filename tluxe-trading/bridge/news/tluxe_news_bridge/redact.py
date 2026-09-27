"""Secret redaction for logs and for every text that could reach the browser."""
from __future__ import annotations

import logging
import re

# Credentials travel in Trading Economics URLs as ?c=client:secret (REST) / ?client=... (streaming): always masked.
_URL_KEY = re.compile(r"([?&](?:c|client|key|apikey|api_key|token)=)[^&\s\"']+", re.I)
_KEY_LIKE = re.compile(r"\b(sk-[A-Za-z0-9_\-]{8,}|db-[A-Za-z0-9]{8,})")


class Redactor:
    def __init__(self, *secrets: str) -> None:
        # Mask the whole credential and each half of a "client:secret" pair.
        parts: list[str] = []
        for s in secrets:
            if s:
                parts.append(s)
                parts.extend(p for p in s.split(":") if len(p) >= 6)
        self._secrets = sorted(set(parts), key=len, reverse=True)

    def __call__(self, text: object) -> str:
        s = _URL_KEY.sub(r"\1****", str(text))
        for secret in self._secrets:
            s = s.replace(secret, "****")
        return _KEY_LIKE.sub("****", s)


class RedactingFilter(logging.Filter):
    def __init__(self, redact: Redactor) -> None:
        super().__init__()
        self._redact = redact

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:  # pragma: no cover - defensive
            msg = str(record.msg)
        record.msg = self._redact(msg)
        record.args = ()
        if record.exc_info:
            import traceback

            record.msg += "\n" + self._redact("".join(traceback.format_exception(*record.exc_info)))
            record.exc_info = None
            record.exc_text = None
        return True


def install_log_redaction(redact: Redactor) -> None:
    f = RedactingFilter(redact)
    for h in logging.getLogger().handlers:
        h.addFilter(f)
    for name in ("", "tluxe", "websockets"):
        logging.getLogger(name).addFilter(f)
    logging.getLogger("websockets").setLevel(logging.WARNING)  # the client logs the connect URL (with ?client=) at DEBUG
