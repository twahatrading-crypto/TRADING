"""Secret redaction for logs and for every text that could reach the browser."""
from __future__ import annotations

import logging
import re

# Anything shaped like an OpenAI key (sk-..., sk-proj-...) or a Databento key is masked, even if it is not ours.
_KEY_LIKE = re.compile(r"\b(sk-[A-Za-z0-9_\-]{8,}|db-[A-Za-z0-9]{8,})")


class Redactor:
    def __init__(self, *secrets: str) -> None:
        self._secrets = [s for s in secrets if s]

    def __call__(self, text: object) -> str:
        s = str(text)
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
    for name in ("", "tluxe", "openai", "httpx", "httpx2"):
        logging.getLogger(name).addFilter(f)
    # The SDK / HTTP client log request details at DEBUG; never run them below WARNING.
    for name in ("openai", "httpx", "httpx2"):
        logging.getLogger(name).setLevel(logging.WARNING)
