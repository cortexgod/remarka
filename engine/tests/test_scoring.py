from remarka_engine import scoring
from remarka_engine.model import MetricValue
from remarka_engine.references import metric_value, status_for


def _metrics(**over):
    base = {
        "layer1": {
            "filled_pauses_per_min": 1.0,
            "wpm": 120.0,
            "crutch_words_per_min": 1.0,
            "hesitation_pauses_per_min": 2.0,
            "talk_ratio": 0.5,
            "long_sentences_share": 0.1,
            "interruptions_by_me": 0.0,
        },
        "layer2": {"pitch_range_st": 6.0, "phrase_final_decay_db": 2.0, "rising_statements_share": 0.05},
    }
    for k, v in over.items():
        layer, name = k.split(".")
        base[layer][name] = v
    return {layer: {name: metric_value(name, v, "other") for name, v in vals.items()} for layer, vals in base.items()}


def test_status_for():
    assert status_for(120, 100, 130) == "good"
    assert status_for(135, 100, 130) == "warn"  # 5 ≤ 20 % от 30
    assert status_for(137, 100, 130) == "bad"
    assert status_for(3.5, None, 3) == "warn"
    assert status_for(3.7, None, 3) == "bad"
    assert status_for(3.5, 4, None) == "warn"
    assert status_for(-3.5, -3, None) == "warn"
    assert status_for(None, 1, 2) == "na"
    assert status_for(5, None, None) == "na"


def test_reference_penalty():
    assert scoring.reference_penalty(MetricValue(120, "", 100, 130, "inside", "good")) == 0
    assert abs(scoring.reference_penalty(MetricValue(145, "", 100, 130, "inside", "bad")) - 0.5) < 1e-9
    assert scoring.reference_penalty(MetricValue(200, "", 100, 130, "inside", "bad")) == 1
    assert abs(scoring.reference_penalty(MetricValue(3, "", None, 2, "lower", "bad")) - 0.5) < 1e-9
    assert abs(scoring.reference_penalty(MetricValue(0.3, "", None, 0.2, "lower", "bad")) - 0.1) < 1e-9  # ширина минимум 1
    assert abs(scoring.reference_penalty(MetricValue(2, "", 4, None, "higher", "bad")) - 0.5) < 1e-9
    assert scoring.reference_penalty(MetricValue(None, "", 4, None, "higher", "na")) is None


def test_perfect_score_and_penalties():
    s = scoring.compute_score(_metrics())
    assert s["overall"] == 100 and s["basis"] == "reference"
    assert abs(sum(c["weight"] for c in s["components"]) - 100) < 1e-6
    s2 = scoring.compute_score(_metrics(**{"layer1.filled_pauses_per_min": 9.0}))
    assert s2["overall"] == 80  # штраф 1 × вес 20


def test_null_talk_ratio_rescales_weights():
    s = scoring.compute_score(_metrics(**{"layer1.talk_ratio": None}))
    comp = {c["metric"]: c for c in s["components"]}
    assert comp["layer1.talk_ratio"]["weight"] == 0
    assert abs(sum(c["weight"] for c in s["components"]) - 100) < 0.1
    assert abs(comp["layer1.filled_pauses_per_min"]["weight"] - 20 * 100 / 90) < 0.01
    assert s["overall"] == 100


def test_baseline_mode():
    stats = {"layer1.filled_pauses_per_min": {"mean": 1.0, "std": 0.5, "n": 3}}
    m = _metrics(**{"layer1.filled_pauses_per_min": 2.0})
    s = scoring.compute_score(m, stats)
    assert s["basis"] == "baseline"
    comp = {c["metric"]: c for c in s["components"]}
    # по ориентиру 2 ≤ 3 → 0; z = 2 → clip(2/2) = 1 → 0.5·1 = 0.5
    assert abs(comp["layer1.filled_pauses_per_min"]["penalty"] - 0.5) < 1e-6
    assert s["overall"] == 90


def test_bad_side_z_directions():
    assert scoring.bad_side_z(MetricValue(3, "", None, 3, "lower", "good"), 1, 1) == 2
    assert scoring.bad_side_z(MetricValue(0, "", None, 3, "lower", "good"), 1, 1) == 0
    assert scoring.bad_side_z(MetricValue(2, "", 4, None, "higher", "bad"), 4, 1) == 2
    assert scoring.bad_side_z(MetricValue(128, "", 100, 130, "inside", "good"), 110, 6) == 3
    assert scoring.bad_side_z(MetricValue(105, "", 100, 130, "inside", "good"), 110, 5) == 1


def test_all_na_gives_zero():
    m = {"layer1": {}, "layer2": {}}
    s = scoring.compute_score(m)
    assert s["overall"] == 0 and all(c["weight"] == 0 for c in s["components"])
