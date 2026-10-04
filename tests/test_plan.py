import pytest

from xau.config import RiskConfig
from xau.models import SymbolSpec
from xau.strategy.liquidity import Level
from xau.strategy.plan import build_plan, compute_sl, position_size


def L(kind, side, price):
    return Level(kind, side, price, 0, 0)


def test_sl_beyond_sweep_with_buffer_and_spread():
    cfg = RiskConfig(sl_buffer_atr=0.1, sl_buffer_points=20, add_spread_to_buffer=True)
    assert compute_sl("SELL", 2656.2, 1.5, 0.25, 0.01, cfg) == pytest.approx(2656.2 + 0.2 + 0.25)
    assert compute_sl("BUY", 2600.0, 3.0, 0.25, 0.01, cfg) == pytest.approx(2600.0 - 0.3 - 0.25)


def test_targets_come_from_liquidity_and_r_is_computed():
    cfg = RiskConfig(target_frontrun_points=10)
    lv = [L("ASIA_LOW", "low", 2648.4), L("PDL", "low", 2631.4), L("PDH", "high", 2675.6)]
    p = build_plan("SELL", 2652.8, 2656.6, lv, 1.6, 4.0, 0.01, cfg)
    assert p.valid
    assert p.risk == pytest.approx(3.8)
    assert p.tp2 == pytest.approx(2631.5) and p.tp2_source == "PDL"
    assert p.tp2_rr == pytest.approx((2652.8 - 2631.5) / 3.8)
    # Asia low is only 1.13R away (< tp1_min_rr 1.5) so TP1 falls back to 2R, which sits before the PDL
    assert p.tp1 == pytest.approx(2652.8 - 2 * 3.8) and "2R" in p.tp1_source


def test_rejects_when_no_liquidity_at_min_r():
    cfg = RiskConfig(min_rr=3.0)
    lv = [L("ASIA_LOW", "low", 2645.0)]                      # only ~2R away
    p = build_plan("SELL", 2652.8, 2656.6, lv, 1.6, 4.0, 0.01, cfg)
    assert not p.valid and p.tp2 is None
    assert any("No real liquidity target" in r for r in p.reasons)


def test_rejects_unrealistically_far_target():
    cfg = RiskConfig(max_target_distance_h1_atr=3.0)
    lv = [L("PDL", "low", 2600.0)]
    p = build_plan("SELL", 2652.8, 2656.6, lv, 1.6, 4.0, 0.01, cfg)
    assert not p.valid


def test_rejects_oversized_structural_sl():
    cfg = RiskConfig(max_sl_price=3.0)
    lv = [L("PDL", "low", 2620.0)]
    p = build_plan("SELL", 2652.8, 2656.6, lv, 1.6, 6.0, 0.01, cfg)
    assert not p.valid and any("exceeds max" in r for r in p.reasons)


def test_taken_levels_are_not_targets():
    lv = [L("PDL", "low", 2631.4)]
    lv[0].taken_time = 123
    assert not build_plan("SELL", 2652.8, 2656.6, lv, 1.6, 4.0, 0.01, RiskConfig()).valid


def test_buy_plan_mirror():
    lv = [L("PDH", "high", 2668.6), L("ASIA_HIGH", "high", 2651.6)]
    p = build_plan("BUY", 2647.2, 2643.4, lv, 1.6, 4.0, 0.01, RiskConfig())
    assert p.valid and p.tp2 == pytest.approx(2668.5) and p.tp2_rr > 3


@pytest.mark.parametrize("spec,expected", [
    # 100 oz contract, $1 per 0.01 tick per lot: $3.80 SL => $380/lot; $50 risk => 0.13 lot
    (SymbolSpec("XAUUSD", point=0.01, tick_size=0.01, tick_value=1.0, volume_min=0.01, volume_max=50, volume_step=0.01), 0.13),
    # cent/micro account style contract: tick value 0.01 => $3.80/lot => 13.15 lot, capped by max 10
    (SymbolSpec("XAUUSDm", point=0.01, tick_size=0.01, tick_value=0.01, volume_min=0.01, volume_max=10, volume_step=0.01), 10.0),
    # broker with 3 digits and 0.1 step
    (SymbolSpec("GOLD", point=0.001, tick_size=0.001, tick_value=0.1, volume_min=0.1, volume_max=100, volume_step=0.1), 0.1),
])
def test_position_size_respects_broker_spec(spec, expected):
    z = position_size(10000, 0.5, 3.8, spec)
    assert z["volume"] == pytest.approx(expected)
    assert z["actual_risk_money"] <= 50.0 + 1e-6 or "capped" in " ".join(z["warnings"])


def test_position_size_below_minimum_is_flagged_not_rounded_up():
    spec = SymbolSpec("XAUUSD", point=0.01, tick_size=0.01, tick_value=1.0, volume_min=0.1, volume_max=50, volume_step=0.1)
    z = position_size(1000, 0.5, 3.8, spec)                   # $5 risk, 0.1 lot would risk $38
    assert z["volume"] == 0.0 and "min volume" in z["warnings"][0]


def test_position_size_uses_loss_tick_value_when_present():
    spec = SymbolSpec("XAUUSD", point=0.01, tick_size=0.01, tick_value=1.0, tick_value_loss=1.25,
                      volume_min=0.01, volume_max=50, volume_step=0.01)
    z = position_size(10000, 0.5, 4.0, spec)
    assert z["loss_per_lot"] == pytest.approx(500.0) and z["volume"] == pytest.approx(0.1)
