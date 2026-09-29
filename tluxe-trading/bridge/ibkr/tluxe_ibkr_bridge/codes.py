"""IBKR TWS API message codes that matter for depth, mapped to what TLUXE must do.

Only documented TWS API codes are listed; anything else is logged (code + text) and otherwise ignored.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# IBKR account ids (U1234567, DU1234567, F.../I... advisor ids). Never logged, never sent to the cloud.
ACCOUNT_ID = re.compile(r"\b(?:DU|DF|DI|U|F|I)\d{5,10}\b")


def redact(text: str) -> str:
    return ACCOUNT_ID.sub("[account]", text or "")

# action: RESET_ROOT = clear that root's book and resubscribe; RESET_ALL = clear every book (continuity lost);
#         NOT_ENTITLED = depth for that request is not permitted; LINK_DOWN = IB Gateway <-> IBKR servers down;
#         OFFLINE = API socket not connected; CONTRACT = contract could not be resolved; INFO = informational only.


@dataclass(frozen=True)
class Code:
    action: str
    label: str


CODES: dict[int, Code] = {
    317: Code("RESET_ROOT", "Market depth data has been RESET - the book must be emptied before new entries"),
    354: Code("NOT_ENTITLED", "Requested market data is not subscribed"),
    10090: Code("NOT_ENTITLED", "Part of requested market data is not subscribed"),
    10092: Code("NOT_ENTITLED", "Deep market data is not supported for this combination of security / exchange"),
    309: Code("NOT_ENTITLED", "Maximum number of simultaneous market depth requests reached"),
    200: Code("CONTRACT", "No security definition has been found"),
    1100: Code("LINK_DOWN", "Connectivity between IB Gateway and IBKR servers lost"),
    2110: Code("LINK_DOWN", "Connectivity between IB Gateway and IBKR servers broken"),
    1101: Code("RESET_ALL", "Connectivity restored - data lost, subscriptions must be re-made"),
    1102: Code("RESET_ALL", "Connectivity restored - subscriptions maintained (book continuity not guaranteed: rebuilt)"),
    2103: Code("RESET_ALL", "Market data farm connection broken"),
    2105: Code("RESET_ALL", "Historical / market data farm connection broken"),
    2157: Code("RESET_ALL", "Security definition data farm connection broken"),
    502: Code("OFFLINE", "Could not connect to IB Gateway API"),
    504: Code("OFFLINE", "Not connected to IB Gateway"),
    1300: Code("OFFLINE", "IB Gateway API socket port reset"),
    326: Code("OFFLINE", "API client id already in use"),
    2104: Code("INFO", "Market data farm connection OK"),
    2106: Code("INFO", "HMDS data farm connection OK"),
    2158: Code("INFO", "Security definition data farm connection OK"),
    2107: Code("INFO", "HMDS data farm connection inactive (normal)"),
    2108: Code("INFO", "Market data farm connection inactive (normal)"),
}


def classify(code: int) -> Code:
    return CODES.get(int(code), Code("UNKNOWN", "Unclassified IBKR message"))
