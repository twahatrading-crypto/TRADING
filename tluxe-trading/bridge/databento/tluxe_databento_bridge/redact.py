"""Secret redaction for logs and for every error text that could reach the browser."""
from __future__ import annotations

import logging
import re

# Databento API keys start with "db-"; anything that looks like one is masked even if it is not ours.
_KEY_LIKE = re.compile(r"db-[A-Za-z0-9]{8,}")


class Redactor:
    def __init__(self, *secrets: str) -> None:
        self._secrets = [s for s in secrets if s]

    def __call__(self, text: object) -> str:
        s = str(text)
        for secret in self._secrets:
            s = s.replace(secret, "****")
        return _KEY_LIKE.sub("db-****", s)


class RedactingFilter(logging.Filter):
    """Rewrites every log record through the redactor (message + args), so no handler can print a secret."""

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
    """Attach the filter to the root logger's handlers and to the loggers we (and the SDK) use."""
    f = RedactingFilter(redact)
    root = logging.getLogger()
    for h in root.handlers:
        h.addFilter(f)
    for name in ("", "tluxe", "databento"):
        logging.getLogger(name).addFilter(f)
    # The SDK logs authentication details at DEBUG; never run it below WARNING.
    logging.getLogger("databento").setLevel(logging.WARNING)
