from xau.sessions import MarketHours, SessionEngine
from xau.timeutil import ServerClock, measure_offset
from tests.helpers import ts


def test_ny7_offsets_follow_us_dst():
    c = ServerClock("NY+7")
    assert c.offset_at_utc(ts("2025-01-15 12:00")) == 2 * 3600          # NY EST (-5) + 7
    assert c.offset_at_utc(ts("2025-07-15 12:00")) == 3 * 3600          # NY EDT (-4) + 7
    # US switched 2025-03-09, EU only on 2025-03-30: NY+7 must already be +3
    assert c.offset_at_utc(ts("2025-03-12 12:00")) == 3 * 3600
    assert ServerClock("Europe/Athens").offset_at_utc(ts("2025-03-12 12:00")) == 2 * 3600


def test_server_time_roundtrip_across_dst():
    for rule in ("NY+7", "Europe/Athens", "UTC", "fixed:+2"):
        c = ServerClock(rule)
        for s in ("2025-03-09 06:00", "2025-03-09 07:30", "2025-11-02 05:30", "2025-11-03 06:30",
                  "2025-03-30 01:30", "2025-10-26 00:30", "2025-06-01 12:00"):
            u = ts(s)
            assert c.to_utc(c.to_server(u)) == u, (rule, s)


def test_fall_back_repeated_hour_is_ambiguous_but_market_closed():
    # 05:30 and 06:30 UTC on 2025-11-02 both read 08:30 on an NY+7 server clock
    # (the repeated hour).  It is Sunday 01:30 New York – gold is closed – and the
    # inversion deterministically returns the first occurrence.
    c = ServerClock("NY+7")
    a, b = ts("2025-11-02 05:30"), ts("2025-11-02 06:30")
    assert c.to_server(a) == c.to_server(b)
    assert c.to_utc(c.to_server(b)) == a
    assert not MarketHours().is_open(a) and not MarketHours().is_open(b)


def test_d1_boundary_is_new_york_close():
    c = ServerClock("NY+7")
    # server midnight == 17:00 New York == 22:00 UTC in winter / 21:00 UTC in summer
    assert c.to_utc(ts("2025-01-15 00:00")) == ts("2025-01-14 22:00")
    assert c.to_utc(ts("2025-07-15 00:00")) == ts("2025-07-14 21:00")


def test_measure_offset_rounds():
    assert measure_offset(1_000_000 + 7200 + 3, 1_000_000) == 7200
    assert measure_offset(1_000_000 + 10800 - 40, 1_000_000) == 10800


def test_sessions_dst_explicit():
    se = SessionEngine()
    # London opens 08:00 local = 08:00 UTC in winter, 07:00 UTC in summer
    assert "London" in se.active(ts("2025-01-15 08:05"))
    assert "London" not in se.active(ts("2025-01-15 07:30"))
    assert "London" in se.active(ts("2025-07-15 07:30"))
    # New York 08:00 local = 13:00 UTC winter / 12:00 UTC summer
    assert "New York" in se.active(ts("2025-01-15 13:30"))
    assert "New York" not in se.active(ts("2025-01-15 12:30"))
    assert "New York" in se.active(ts("2025-07-15 12:30"))
    # Asian (Tokyo, no DST) 00:00-06:00 UTC all year
    assert se.active(ts("2025-07-15 03:00")) == ["Asian"]
    assert se.last_completed("Asian", ts("2025-01-15 08:00")) == (ts("2025-01-15 00:00"), ts("2025-01-15 06:00"))
    assert se.last_completed("Asian", ts("2025-01-15 05:00")) == (ts("2025-01-14 00:00"), ts("2025-01-14 06:00"))


def test_market_hours():
    mh = MarketHours()
    assert not mh.is_open(ts("2025-01-18 12:00"))          # Saturday
    assert not mh.is_open(ts("2025-01-17 22:30"))          # Fri 17:30 NY
    assert mh.is_open(ts("2025-01-19 23:30"))              # Sun 18:30 NY
    assert not mh.is_open(ts("2025-01-15 22:30"))          # daily break 17:30 NY (winter)
    assert not mh.is_open(ts("2025-07-15 21:30"))          # daily break 17:30 NY (summer)
    assert mh.is_open(ts("2025-07-15 22:30"))
