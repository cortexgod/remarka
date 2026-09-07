"""Оценка 0–100 (§4.6)."""

from __future__ import annotations

from typing import Any

from .model import MetricValue

WEIGHTS: dict[str, float] = {
    "layer1.filled_pauses_per_min": 20,
    "layer1.wpm": 15,
    "layer2.pitch_range_st": 15,
    "layer1.crutch_words_per_min": 10,
    "layer1.hesitation_pauses_per_min": 10,
    "layer1.talk_ratio": 10,
    "layer2.phrase_final_decay_db": 5,
    "layer2.rising_statements_share": 5,
    "layer1.long_sentences_share": 5,
    "layer1.interruptions_by_me": 5,
}


def reference_penalty(mv: MetricValue) -> float | None:
    """0 внутри ориентира, линейно до 1 при отклонении на 100 % ширины (или границы, минимум 1). None — не оценивается."""
    v = mv.value
    low, high = mv.ref_low, mv.ref_high
    if v is None or (low is None and high is None):
        return None
    if low is not None and high is not None:
        width = max(high - low, 1e-9)
        if low <= v <= high:
            return 0.0
        dev = (low - v) if v < low else (v - high)
        return min(1.0, dev / width)
    if high is not None:
        if v <= high:
            return 0.0
        return min(1.0, (v - high) / max(abs(high), 1.0))
    assert low is not None
    if v >= low:
        return 0.0
    return min(1.0, (low - v) / max(abs(low), 1.0))


def bad_side_z(mv: MetricValue, mean: float, std: float) -> float:
    """z, направленный в «плохую» сторону: для lower — вверх, higher — вниз, inside — от центра ориентира."""
    if mv.value is None or std <= 0:
        return 0.0
    z = (mv.value - mean) / std
    if mv.better == "lower":
        return max(0.0, z)
    if mv.better == "higher":
        return max(0.0, -z)
    if mv.ref_low is not None and mv.ref_high is not None:
        mid = (mv.ref_low + mv.ref_high) / 2
        return max(0.0, z if mv.value >= mid else -z)
    return abs(z)


def compute_score(metrics: dict[str, dict[str, MetricValue]], baseline_stats: dict[str, dict[str, float]] | None = None) -> dict[str, Any]:
    """metrics = {"layer1": {...}, "layer2": {...}} → Score. baseline_stats — из baseline.json при status ready."""
    use_baseline = bool(baseline_stats)
    rows: list[tuple[str, float, float | None]] = []
    for key, weight in WEIGHTS.items():
        layer, name = key.split(".", 1)
        mv = metrics.get(layer, {}).get(name)
        if mv is None:
            rows.append((key, weight, None))
            continue
        p = reference_penalty(mv)
        if p is not None and use_baseline and key in (baseline_stats or {}):
            stt = baseline_stats[key]  # type: ignore[index]
            zb = bad_side_z(mv, float(stt["mean"]), float(stt["std"]))
            p = 0.5 * p + 0.5 * min(1.0, max(0.0, zb / 2.0))
        rows.append((key, weight, p))
    active_weight = sum(w for _, w, p in rows if p is not None)
    scale = 100.0 / active_weight if active_weight > 0 else 0.0
    components = []
    penalty_sum = 0.0
    for key, weight, p in rows:
        w = round(weight * scale, 2) if p is not None else 0.0
        pen = 0.0 if p is None else round(p, 4)
        penalty_sum += w * pen
        components.append({"metric": key, "weight": w, "penalty": pen})
    overall = int(round(100.0 - penalty_sum)) if active_weight > 0 else 0
    overall = max(0, min(100, overall))
    return {"overall": overall, "components": components, "basis": "baseline" if use_baseline else "reference"}
