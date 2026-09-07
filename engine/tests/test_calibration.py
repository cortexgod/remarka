from remarka_engine import calibration, report
from remarka_engine.references import metric_value


def _rep(mid: str, started: str, mtype: str, wpm: float, pitch: float | None = 5.0):
    return {
        "meeting": {"id": mid, "started_at": started, "type": mtype},
        "metrics": {
            "layer1": {"wpm": {"value": wpm}, "talk_ratio": {"value": None}},
            "layer2": {"pitch_range_st": {"value": pitch}},
        },
    }


def test_build_baseline_uses_first_three_non_training():
    reps = [
        _rep("d", "2026-09-04T10:00:00+03:00", "pitch", 200),
        _rep("a", "2026-09-01T10:00:00+03:00", "pitch", 100),
        _rep("t", "2026-09-01T11:00:00+03:00", "training", 999),
        _rep("b", "2026-09-02T10:00:00+03:00", "demo", 110),
        _rep("c", "2026-09-03T10:00:00+03:00", "sales", 120, pitch=None),
    ]
    b = calibration.build_baseline(reps)
    assert b["meeting_ids"] == ["a", "b", "c"]
    assert abs(b["stats"]["layer1.wpm"]["mean"] - 110) < 1e-6 and b["stats"]["layer1.wpm"]["n"] == 3
    assert b["stats"]["layer2.pitch_range_st"]["n"] == 2
    assert "layer1.talk_ratio" not in b["stats"]
    assert report.validate(b, "baseline") == []


def test_std_floor():
    reps = [_rep(str(i), f"2026-09-0{i}T10:00:00+03:00", "pitch", 100) for i in (1, 2, 3)]
    b = calibration.build_baseline(reps)
    assert abs(b["stats"]["layer1.wpm"]["std"] - 5.0) < 1e-6  # 5 % от 100
    reps0 = [_rep(str(i), f"2026-09-0{i}T10:00:00+03:00", "pitch", 0.0) for i in (1, 2, 3)]
    assert calibration.build_baseline(reps0)["stats"]["layer1.wpm"]["std"] == 0.01


def test_compare_and_calibrating():
    metrics = {"layer1": {"wpm": metric_value("wpm", 120, "other")}, "layer2": {}}
    base = {"meeting_ids": ["a", "b", "c"], "stats": {"layer1.wpm": {"mean": 110, "std": 5, "n": 3}, "layer2.pitch_range_st": {"mean": 5, "std": 1, "n": 3}}}
    cmp_ = calibration.compare(metrics, base)
    assert cmp_["status"] == "ready" and cmp_["meetings_used"] == 3
    assert cmp_["deltas"] == [{"metric": "layer1.wpm", "baseline": 110, "value": 120, "delta": 10, "z": 2.0}]
    cal = calibration.compare(metrics, None)
    assert cal == {"status": "calibrating", "meetings_used": 0, "meetings_needed": 3, "deltas": []}
    assert calibration.calibrating(2)["meetings_used"] == 2
