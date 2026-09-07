"""Калибровка (§4.7): baseline.json из первых 3 встреч и сравнение отчёта с базой."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

from .model import MetricValue

BASELINE_KEYS = [
    "layer1.wpm",
    "layer1.articulation_wpm",
    "layer1.filled_pauses_per_min",
    "layer1.crutch_words_per_min",
    "layer1.hesitation_pauses_per_min",
    "layer1.structural_pauses_per_min",
    "layer1.talk_ratio",
    "layer1.mean_sentence_len",
    "layer2.pitch_range_st",
    "layer2.phrase_final_decay_db",
    "layer2.rising_statements_share",
    "layer2.jitter_pct",
    "layer2.shimmer_pct",
    "layer2.loudness_drift_db",
]
MEETINGS_NEEDED = 3
STD_MIN_SHARE = 0.05
STD_MIN_ABS = 0.01


def metric_from_report(report: dict[str, Any], key: str) -> float | None:
    layer, name = key.split(".", 1)
    try:
        v = report["metrics"][layer][name]["value"]
    except (KeyError, TypeError):
        return None
    return None if v is None else float(v)


def build_baseline(reports: list[dict[str, Any]]) -> dict[str, Any]:
    """Первые 3 готовых встречи типа ≠ training → mean/std/n по ключам."""
    usable = [r for r in reports if r.get("meeting", {}).get("type") != "training"]
    usable.sort(key=lambda r: r.get("meeting", {}).get("started_at", ""))
    usable = usable[:MEETINGS_NEEDED]
    stats: dict[str, dict[str, float]] = {}
    for key in BASELINE_KEYS:
        vals = [v for v in (metric_from_report(r, key) for r in usable) if v is not None and math.isfinite(v)]
        if not vals:
            continue
        n = len(vals)
        mean = sum(vals) / n
        var = sum((v - mean) ** 2 for v in vals) / n
        std = math.sqrt(var)
        std = max(std, STD_MIN_SHARE * abs(mean), STD_MIN_ABS)
        stats[key] = {"mean": round(mean, 6), "std": round(std, 6), "n": n}
    return {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "meeting_ids": [r.get("meeting", {}).get("id", "") for r in usable],
        "stats": stats,
    }


def calibrating(meetings_used: int = 0) -> dict[str, Any]:
    return {"status": "calibrating", "meetings_used": int(meetings_used), "meetings_needed": MEETINGS_NEEDED, "deltas": []}


def compare(metrics: dict[str, dict[str, MetricValue]], baseline: dict[str, Any] | None) -> dict[str, Any]:
    if not baseline or not baseline.get("stats"):
        return calibrating(0)
    deltas = []
    for key, stt in baseline["stats"].items():
        layer, name = key.split(".", 1)
        mv = metrics.get(layer, {}).get(name)
        if mv is None or mv.value is None:
            continue
        mean = float(stt["mean"])
        std = float(stt.get("std", 0) or 0)
        value = float(mv.value)
        deltas.append(
            {
                "metric": key,
                "baseline": round(mean, 4),
                "value": round(value, 4),
                "delta": round(value - mean, 4),
                "z": round((value - mean) / std, 4) if std > 0 else None,
            }
        )
    n_used = len(baseline.get("meeting_ids", [])) or MEETINGS_NEEDED
    return {"status": "ready", "meetings_used": n_used, "meetings_needed": MEETINGS_NEEDED, "deltas": deltas}
