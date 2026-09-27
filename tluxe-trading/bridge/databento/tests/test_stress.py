"""MBO stress test (TEST DATA - synthetic records, never used by the bridge): realistic high-frequency order
flow through the real ingest queue + hub, with concurrent frame publishing. Reports throughput, queue depth,
memory and integrity. Set TLUXE_STRESS_RECORDS to scale (default 1,000,000)."""
import os
import random
import threading
import time
import resource
import unittest

from fixtures import GC_ID, SI_ID, T0, S, cfg, mapping, mbo, snapshot, trade

from tluxe_databento_bridge import manager as M
from tluxe_databento_bridge.book import VALID
from tluxe_databento_bridge.hub import Hub

A = __import__("databento_dbn").Action
N = int(os.environ.get("TLUXE_STRESS_RECORDS", "1000000"))


def generate(n: int, seed: int = 7):
    """Adds / modifies / cancels around a moving mid with realistic CME order-id lifecycles; ~2 % trades."""
    rnd = random.Random(seed)
    live: dict[int, tuple] = {}
    recent: list[int] = []  # recently added order ids still resting (bounded working set, O(1) choice)
    oid = 1_000_000
    ts = T0
    mid = 2400.0
    for k in range(n):
        ts += rnd.randint(200, 20_000)
        if k % 5000 == 0:
            mid += rnd.choice((-0.1, 0.0, 0.1))
        r = rnd.random()
        last = k % 4 != 0  # multi-record events: F_LAST only on the event's last record
        flags = 128 if last else 0
        if r < 0.45 or len(recent) < 200:
            oid += 1
            side = S.BID if rnd.random() < 0.5 else S.ASK
            price = round(mid - 0.1 * rnd.randint(1, 20) if side == S.BID else mid + 0.1 * rnd.randint(1, 20), 1)
            size = rnd.randint(1, 20)
            live[oid] = (side, price, size)
            recent.append(oid)
            if len(recent) > 2000:
                recent.pop(0)
            yield "book", mbo(GC_ID, A.ADD, side, price, size, oid, ts, flags=flags, seq=k + 1)
        elif r < 0.70 and recent:
            o = rnd.choice(recent)
            side, price, size = live[o]
            nsize = max(1, size + rnd.randint(-3, 3))
            live[o] = (side, price, nsize)
            yield "book", mbo(GC_ID, A.MODIFY, side, price, nsize, o, ts, flags=flags, seq=k + 1)
        elif r < 0.98 and recent:
            i = rnd.randrange(len(recent))
            o = recent[i]
            recent[i] = recent[-1]
            recent.pop()
            side, price, size = live.pop(o)
            yield "book", mbo(GC_ID, A.CANCEL, side, price, size, o, ts, flags=flags, seq=k + 1)
        else:
            yield "tape", trade(GC_ID, mid, rnd.randint(1, 10), rnd.choice((S.BID, S.ASK, S.NONE)), ts, seq=k + 1)


class TestStress(unittest.TestCase):
    def test_high_frequency_mbo(self):
        hub = Hub(cfg(TLUXE_DB_PUBLISH_MS="100", TLUXE_DB_PLAN="mbo"), clock=lambda: int(time.time() * 1000))
        ing = M.Ingest(hub)
        for s in ("book", "tape"):
            hub.on_session_connected(s)
            hub.on_record(s, mapping("GC.v.0", "GCZ6", GC_ID))
            hub.on_record(s, mapping("SI.v.0", "SIZ6", SI_ID))
        for r in snapshot(GC_ID, [(S.BID, 2399.9, 5, 1), (S.ASK, 2400.1, 5, 2)]):
            hub.on_record("book", r)
        records = list(generate(N))
        stop = threading.Event()
        frames = [0]

        def publisher():
            while not stop.wait(0.1):
                hub.set_queue_depth(ing.qsize())
                hub.publish()
                frames[0] += 1

        rss0 = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        pub = threading.Thread(target=publisher, daemon=True)
        pub.start()
        worker = threading.Thread(target=lambda: [ing.drain_once(block=True) for _ in iter(lambda: stop.is_set(), True)], daemon=True)
        worker.start()
        t0 = time.perf_counter()
        for session, r in records:  # producer = the SDK reader thread
            ing.put(session, r)
        while ing.qsize():
            time.sleep(0.01)
        elapsed = time.perf_counter() - t0
        stop.set()
        worker.join(2)
        pub.join(2)
        rss1 = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # KB on Linux
        gc = hub.roots["GC"]
        rate = N / elapsed
        report = {
            "records": N,
            "seconds": round(elapsed, 2),
            "recordsPerSec": int(rate),
            "maxQueueDepth": hub.metrics["maxQueueDepth"],
            "framesPublished": frames[0],
            "framesPerSec": round(frames[0] / elapsed, 1),
            "peakRssMB": round(rss1 / 1024, 1),
            "rssGrowthMB": round((rss1 - rss0) / 1024, 1),
            "bookState": gc.book.state,
            "restingOrders": len(gc.book.orders),
            "anomalies": gc.book.counts["anomalies"],
            "malformed": gc.book.counts["malformed"],
            "mboDuplicates": gc.counts["mboDuplicates"],
            "trades": gc.tape.counts["accepted"],
            "retainedFrames": len(hub.frames),
        }
        print("\nSTRESS", report)
        self.assertEqual(gc.book.state, VALID)
        self.assertEqual(gc.book.counts["anomalies"], 0)
        self.assertEqual(gc.book.counts["malformed"], 0)
        self.assertLessEqual(len(hub.frames), hub.cfg.max_frames)
        self.assertGreater(frames[0], elapsed * 5)  # frames kept flowing under load (>= 5 / s at 10 / s target)
        # Book levels exactly equal an independent recomputation from the resting orders.
        levels: dict = {}
        for o in gc.book.orders.values():
            levels[(o.side, o.price)] = levels.get((o.side, o.price), 0) + o.size
        self.assertEqual(levels, {(s, p): v[0] for s in ("B", "A") for p, v in gc.book.levels[s].items()})


if __name__ == "__main__":
    unittest.main()
