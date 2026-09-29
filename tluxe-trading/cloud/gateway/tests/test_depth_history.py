"""Server-side IBKR depth history: recording, persistence across a gateway restart, and the time x price matrix.
TEST DATA ONLY: a local stand-in depth service and hand-written rows; no external network, no IBKR connection."""
import asyncio
import json
import os
import time
import unittest
import uuid

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from tluxe_gateway.app import K_DEPTH, make_app
from tluxe_gateway.config import from_env
from tluxe_gateway.depth_history import CARRY_MS, DepthRecorder, build_matrix, normalize_request
from tluxe_gateway.store import MemoryStore, PgStore

from tluxe_gateway.auth import COOKIE

from test_gateway import DEPTH_TOKEN, PASSWORD, PG_ADMIN, dev_env, depth_body


def snap(t, bids, asks, t1=None):
    return {"kind": "snapshot", "t0": t, "t1": t1 if t1 is not None else t, "data": json.dumps({"b": [[p, s, i] for i, (p, s) in enumerate(bids)], "a": [[p, s, i] for i, (p, s) in enumerate(asks)]})}


def delta(t0, t1, changes):
    return {"kind": "delta", "t0": t0, "t1": t1, "data": json.dumps({"c": [[ts, sd, p, s, 0, 1 if s else 0] for ts, sd, p, s in changes]})}


def gap(t):
    return {"kind": "gap", "t0": t, "t1": t, "data": json.dumps({"reason": "test"})}


def cell(m, t, side, price):
    for c in m["columns"]:
        if c[0] == t:
            for p, s in c[2 if side == "bid" else 3]:
                if p == price:
                    return s
    return None


class TestMatrix(unittest.TestCase):
    def test_time_weighted_displayed_size_per_bucket(self):
        # bid 100 @ 4150.0 for 400 ms, then 300 for 600 ms -> bucket average 220; ask 50 all the time
        rows = [snap(1000, [(4150.0, 100)], [(4150.1, 50)]), delta(1400, 2000, [(1400, 0, 4150.0, 300)])]
        m = build_matrix(rows, 1000, 2000, 1000)
        self.assertEqual(cell(m, 1000, "bid", 4150.0), 220.0)
        self.assertEqual(cell(m, 1000, "ask", 4150.1), 50.0)
        self.assertEqual(m["columns"][0][1], 1.0)  # fully covered

    def test_nothing_before_the_first_recorded_snapshot(self):
        rows = [snap(5000, [(4150.0, 10)], [], t1=6000)]
        m = build_matrix(rows, 0, 7000, 1000)
        self.assertEqual([c[0] for c in m["columns"]], [5000])  # 0..4999 and after 6000: no data, never backfilled
        self.assertEqual(m["columns"][0][1], 1.0)

    def test_gap_stops_liquidity_and_delta_without_base_is_ignored(self):
        rows = [snap(0, [(1.0, 10)], [], t1=1500), gap(1500), delta(3000, 4000, [(3000, 0, 1.0, 99)]), snap(5000, [(1.0, 20)], [], t1=6000)]
        m = build_matrix(rows, 0, 6000, 1000)
        ts = [c[0] for c in m["columns"]]
        self.assertEqual(ts, [0, 1000, 5000])
        self.assertEqual(m["columns"][1][1], 0.5)  # valid only until the gap at 1500
        self.assertIsNone(cell(m, 3000, "bid", 1.0))  # a delta without a known base book is never applied

    def test_no_carry_across_missing_rows(self):
        # last confirmation at 2000, next row long after (gateway restart without a gap row) -> no data in between
        rows = [snap(0, [(1.0, 10)], [], t1=2000), delta(2000 + CARRY_MS + 5000, 2000 + CARRY_MS + 5000, [])]
        m = build_matrix(rows, 0, 30_000, 1000)
        self.assertEqual([c[0] for c in m["columns"]], [0, 1000])

    def test_removed_level_disappears(self):
        rows = [snap(0, [(1.0, 10), (0.9, 5)], [], t1=1000), delta(1000, 2000, [(1000, 0, 0.9, 0)])]
        m = build_matrix(rows, 0, 2000, 1000)
        self.assertEqual(cell(m, 0, "bid", 0.9), 5.0)
        self.assertIsNone(cell(m, 1000, "bid", 0.9))
        self.assertEqual(cell(m, 1000, "bid", 1.0), 10.0)

    def test_request_normalization(self):
        self.assertIsNone(normalize_request(0, 10_000, 1000, None, 10_000))  # nothing recorded yet
        f, t, b = normalize_request(0, 10_500, 900, 3_300, 10_500)
        self.assertEqual((f, t, b), (3000, 11_000, 1000))  # clamped to the first recorded time, aligned, bucket snapped
        f, t, b = normalize_request(0, 10**9, 250, 0, 10**9)
        self.assertLessEqual((t - f) // b, 4000)


class TestRecorder(unittest.IsolatedAsyncioTestCase):
    async def test_snapshot_changes_keyframe_gap_and_flush(self):
        store = MemoryStore()
        rec = DepthRecorder(store, keyframe_ms=10_000)
        rec.snapshot("GC", "GCZ6", 1000, [(0, 4150.0, 5, None)], [(0, 4150.1, 3, None)], epoch=1)
        rec.changes("GC", 1500, [("bid", 4150.0, 9, 0), ("ask", 4150.1, 0, None)], 1, 2, now=1600)
        rec.alive("GC", 2000)
        await rec.flush()
        rows = await store.depth_rows("GC", "GCZ6", 0, 10**12)
        self.assertEqual([r["kind"] for r in rows], ["snapshot", "delta"])
        d = json.loads(rows[1]["data"])["c"]
        self.assertEqual(d, [[1500, 0, 4150.0, 9.0, 0, 2], [1500, 1, 4150.1, 0.0, -1, 0]])  # update / delete with op codes
        self.assertEqual((rows[1]["t1"], rows[1]["n_obs"]), (2000, 2))
        rec.alive("GC", 12_000)  # >= keyframe interval: a fresh full-book snapshot is recorded
        await rec.flush()
        rows = await store.depth_rows("GC", "GCZ6", 0, 10**12)
        key = [r for r in rows if r["kind"] == "snapshot"][-1]
        self.assertEqual(key["t0"], 10_000)  # 2 s before the confirming poll (clock-skew margin)
        self.assertEqual(json.loads(key["data"]), {"b": [[4150.0, 9.0, 0]], "a": []})
        self.assertEqual(rows[-1]["t1"], 12_000)  # liveness confirmed through the poll
        rec.gap("GC", "stale")
        rec.changes("GC", 13_000, [("bid", 4150.0, 1, 0)])  # ignored while invalid
        await rec.flush()
        rows = await store.depth_rows("GC", "GCZ6", 0, 10**12)
        self.assertEqual((rows[-1]["kind"], rows[-1]["t0"]), ("gap", 12_000))  # at the last confirmed time
        st = rec.status()["roots"]["GC"]["GCZ6"]
        self.assertEqual((st["firstMs"], st["rows"], st["observations"]), (1000, len(rows), 2 + 2 + 1))
        self.assertEqual(rec.roots["SI"].valid, False)  # GC recording never touches SI

    async def test_write_failure_keeps_rows_for_retry(self):
        class Broken(MemoryStore):
            fail = True

            async def add_depth_rows(self, rows):
                if self.fail:
                    raise ConnectionError("db down")
                await super().add_depth_rows(rows)

        store = Broken()
        rec = DepthRecorder(store)
        rec.snapshot("SI", "SIZ6", 1000, [(0, 48.5, 5, None)], [], epoch=1)
        self.assertEqual(await rec.flush(), 0)
        self.assertEqual((rec.write_errors, len(rec.pending)), (1, 1))
        store.fail = False
        self.assertEqual(await rec.flush(), 1)
        self.assertEqual(len(await store.depth_rows("SI", "SIZ6", 0, 10**12)), 1)


class TestHistoryEndToEnd(unittest.IsolatedAsyncioTestCase):
    """Real gateway app + stand-in depth service: recorded while no browser is connected, served as a matrix, and still
    there after the gateway restarts (same store)."""

    async def asyncSetUp(self):
        self.depth = {"GC": depth_body("GC"), "SI": depth_body("SI")}
        dapp = web.Application()

        async def handler(request):
            if request.headers.get("Authorization") != f"Bearer {DEPTH_TOKEN}":
                return web.json_response({}, status=401)
            b = self.depth[request.match_info["root"]]
            return web.json_response(b() if callable(b) else b)

        dapp.router.add_get("/depth/{root}", handler)
        self.srv = TestServer(dapp)
        await self.srv.start_server()
        self.store = MemoryStore()
        self.cfg = from_env(dev_env(TLUXE_IBKR_DEPTH_URL=f"http://127.0.0.1:{self.srv.port}", TLUXE_IBKR_DEPTH_TOKEN=DEPTH_TOKEN))

    async def asyncTearDown(self):
        await self.srv.close()

    async def start(self):
        client = TestClient(TestServer(make_app(self.cfg, store=self.store, workers=True)))
        await client.start_server()
        r = await client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": "http://localhost:5182"})
        self.assertEqual(r.status, 200)
        return client

    async def wait_rows(self, app, n=3, timeout=8):
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            st = app[K_DEPTH].status()["roots"].get("GC", {}).get("GCZ6")
            if st and st["rows"] >= n and not app[K_DEPTH].pending:
                return st
            await asyncio.sleep(0.2)
        self.fail("depth history not recorded")

    async def test_recorded_served_and_survives_restart(self):
        c1 = await self.start()
        try:
            st = await self.wait_rows(c1.app)
            first = st["firstMs"]
            h = await (await c1.get("/api/ibkr/history")).json()
            self.assertEqual((h["provider"], h["depthType"], h["mbo"], h["persistence"]), ("Interactive Brokers", "PRICE_LEVEL", False, "memory"))
            self.assertEqual(h["roots"]["GC"]["GCZ6"]["firstMs"], first)
            self.assertNotIn(DEPTH_TOKEN, json.dumps(h))
            now = int(time.time() * 1000)
            m = await (await c1.get(f"/api/ibkr/heatmap?root=GC&from={now - 60_000}&to={now}&bucket=1000")).json()
            self.assertEqual((m["contract"], m["depthType"], m["mbo"], m["firstRecordedMs"]), ("GCZ6", "PRICE_LEVEL", False, first))
            self.assertTrue(m["columns"])
            self.assertGreaterEqual(m["columns"][0][0], (first // 1000) * 1000)  # nothing before the first recorded snapshot
            col = m["columns"][-1]
            self.assertEqual(col[2][0], [4150.0, 5.0])  # the displayed size the depth service reported
            self.assertEqual(col[3][0], [4150.1, 3.0])
            si = await (await c1.get(f"/api/ibkr/heatmap?root=SI&from={now - 60_000}&to={now}&bucket=1000")).json()
            self.assertEqual(si["contract"], "SIZ6")  # GC and SI recorded separately
            self.assertEqual((await c1.get("/api/ibkr/heatmap?root=XAUUSD")).status, 400)
        finally:
            await c1.close()  # graceful stop: a gap row closes the recording, nothing bridges the downtime
        kinds = [r["kind"] for r in self.store.depth if r["root"] == "GC"]
        self.assertEqual(kinds[-1], "gap")
        n_before = len(self.store.depth)
        c2 = await self.start()  # a new gateway process over the same database
        try:
            h = await (await c2.get("/api/ibkr/history")).json()
            self.assertEqual(h["roots"]["GC"]["GCZ6"]["firstMs"], first)  # history kept across the restart
            self.assertGreaterEqual(h["roots"]["GC"]["GCZ6"]["rows"], sum(1 for r in self.store.depth[:n_before] if r["root"] == "GC"))
            now = int(time.time() * 1000)
            m = await (await c2.get(f"/api/ibkr/heatmap?root=GC&from={first - 10_000}&to={now}&bucket=1000")).json()
            self.assertEqual(m["firstRecordedMs"], first)
            self.assertGreaterEqual(m["columns"][0][0], (first // 1000) * 1000)
        finally:
            await c2.close()


@unittest.skipUnless(PG_ADMIN, "TLUXE_TEST_DATABASE_URL not set - PostgreSQL tests are skipped (never faked)")
class TestDepthPostgres(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import psycopg

        self.dbname = f"tluxe_test_{uuid.uuid4().hex[:10]}"
        async with await psycopg.AsyncConnection.connect(PG_ADMIN, autocommit=True) as c:
            await c.execute(f'CREATE DATABASE "{self.dbname}"')
        self.store = PgStore(f"{PG_ADMIN.rsplit('/', 1)[0]}/{self.dbname}")
        await self.store.open()
        await self.store.migrate()

    async def asyncTearDown(self):
        import psycopg

        await self.store.close()
        async with await psycopg.AsyncConnection.connect(PG_ADMIN, autocommit=True) as c:
            await c.execute(f'DROP DATABASE IF EXISTS "{self.dbname}" WITH (FORCE)')

    async def test_persist_query_stats_prune(self):
        rec = DepthRecorder(self.store, keyframe_ms=5000)
        rec.snapshot("GC", "GCZ6", 1000, [(0, 4150.0, 5, None)], [(0, 4150.1, 3, None)], epoch=1)
        for i in range(1, 12):
            rec.changes("GC", 1000 + i * 1000, [("bid", 4150.0, 5 + i, 0)], i, i)
        rec.snapshot("GC", "GCG7", 20_000, [(0, 4170.0, 1, None)], [], epoch=2)  # a different contract is kept apart
        await rec.flush()
        rows = await self.store.depth_rows("GC", "GCZ6", 9000, 30_000)
        self.assertEqual(rows[0]["kind"], "snapshot")  # replay starts at the keyframe at or before `from`
        self.assertLessEqual(rows[0]["t0"], 9000)
        self.assertTrue(all(r["contract"] == "GCZ6" for r in rows))
        m = build_matrix(rows, 9000, 12_000, 1000)
        self.assertEqual(cell(m, 9000, "bid", 4150.0), 13.0)
        stats = {(s["root"], s["contract"]): s for s in await self.store.depth_stats()}
        self.assertEqual(stats[("GC", "GCZ6")]["firstMs"], 1000)
        self.assertEqual(stats[("GC", "GCG7")]["firstMs"], 20_000)
        self.assertGreater(await self.store.depth_bytes(), 0)
        self.assertGreater(await self.store.prune_depth(15_000), 0)
        self.assertEqual({(s["root"], s["contract"]) for s in await self.store.depth_stats()}, {("GC", "GCG7")})
