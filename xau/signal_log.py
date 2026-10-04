"""SQLite log of every setup the engine creates (signals, rejections,
invalidations) with its full rule breakdown and the tracked outcome."""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS setups (
    id               TEXT NOT NULL,
    run              TEXT NOT NULL DEFAULT 'live',
    created_utc      INTEGER,
    updated_utc      INTEGER,
    symbol           TEXT,
    direction        TEXT,
    stage            TEXT,
    status           TEXT,
    grade            TEXT,
    taken            INTEGER,
    liquidity_kind   TEXT,
    liquidity_price  REAL,
    sweep_json       TEXT,
    mss_json         TEXT,
    displacement_json TEXT,
    fvg_json         TEXT,
    entry            REAL,
    entry_utc        INTEGER,
    sl               REAL,
    tp1              REAL,
    tp2              REAL,
    rr_tp2           REAL,
    score_total      INTEGER,
    score_json       TEXT,
    filters_json     TEXT,
    session          TEXT,
    result           TEXT,
    r_result         REAL,
    mfe              REAL,
    mae              REAL,
    mfe_r            REAL,
    mae_r            REAL,
    exit_utc         INTEGER,
    reasons          TEXT,
    raw_json         TEXT,
    PRIMARY KEY (id, run)
);
CREATE INDEX IF NOT EXISTS ix_setups_created ON setups(run, created_utc);
"""


class SignalLog:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._con = sqlite3.connect(str(self.path), check_same_thread=False)
        self._con.executescript(SCHEMA)
        self._con.commit()

    def upsert(self, s: dict, run: str = "live") -> None:
        plan = s.get("plan") or {}
        tr = s.get("trade") or {}
        lvl = (s.get("sweep") or {}).get("level") or {}
        row = {
            "id": s["id"], "run": run, "created_utc": s.get("created_time"), "updated_utc": s.get("updated_time"),
            "symbol": s.get("symbol"), "direction": s.get("direction"), "stage": s.get("stage"),
            "status": s.get("status"), "grade": s.get("grade"), "taken": int(bool(s.get("taken"))),
            "liquidity_kind": lvl.get("kind"), "liquidity_price": lvl.get("price"),
            "sweep_json": json.dumps(s.get("sweep")), "mss_json": json.dumps(s.get("mss")),
            "displacement_json": json.dumps(s.get("displacement")), "fvg_json": json.dumps(s.get("fvg")),
            "entry": s.get("entry_price") or plan.get("entry"), "entry_utc": s.get("entry_time"),
            "sl": plan.get("sl"), "tp1": plan.get("tp1"), "tp2": plan.get("tp2"), "rr_tp2": plan.get("tp2_rr"),
            "score_total": s.get("score_total"), "score_json": json.dumps(s.get("score")),
            "filters_json": json.dumps(s.get("filters")), "session": s.get("session"),
            "result": tr.get("result"), "r_result": tr.get("r_result"), "mfe": tr.get("mfe"), "mae": tr.get("mae"),
            "mfe_r": tr.get("mfe_r"), "mae_r": tr.get("mae_r"), "exit_utc": tr.get("exit_time"),
            "reasons": json.dumps(s.get("reasons")), "raw_json": json.dumps(s),
        }
        cols = ",".join(row)
        ph = ",".join("?" for _ in row)
        upd = ",".join(f"{k}=excluded.{k}" for k in row if k not in ("id", "run"))
        with self._lock:
            self._con.execute(f"INSERT INTO setups ({cols}) VALUES ({ph}) "
                              f"ON CONFLICT(id, run) DO UPDATE SET {upd}", list(row.values()))
            self._con.commit()

    def recent(self, limit: int = 100, run: str = "live") -> list[dict]:
        with self._lock:
            cur = self._con.execute(
                "SELECT id, created_utc, symbol, direction, status, grade, taken, liquidity_kind, "
                "liquidity_price, entry, entry_utc, sl, tp1, tp2, rr_tp2, score_total, session, result, "
                "r_result, mfe_r, mae_r, reasons FROM setups WHERE run=? ORDER BY created_utc DESC LIMIT ?",
                (run, limit))
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        for r in rows:
            r["reasons"] = json.loads(r["reasons"] or "[]")
        return rows

    def get(self, setup_id: str, run: str = "live") -> Optional[dict]:
        with self._lock:
            r = self._con.execute("SELECT raw_json FROM setups WHERE id=? AND run=?", (setup_id, run)).fetchone()
        return json.loads(r[0]) if r else None

    def clear_run(self, run: str) -> None:
        with self._lock:
            self._con.execute("DELETE FROM setups WHERE run=?", (run,))
            self._con.commit()

    def close(self) -> None:
        with self._lock:
            self._con.close()
