"""Ориентиры по типам встреч (§4.5), статусы MetricValue, загрузка data/*.json."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .model import MetricValue

DATA_DIR = Path(__file__).resolve().parent / "data"
WARN_SHARE = 0.2

MEETING_TYPES = ["pitch", "demo", "sales", "interview", "standup", "lecture", "one_on_one", "training", "other"]


@lru_cache(maxsize=8)
def load_data(name: str) -> Any:
    with open(DATA_DIR / name, encoding="utf-8") as f:
        return json.load(f)


def load_training_tasks() -> list[dict[str, Any]]:
    return list(load_data("training_tasks.json"))


def reference_for(metric: str, meeting_type: str) -> tuple[float | None, float | None, str]:
    data = load_data("reference_ranges.json")
    base = dict(data.get("default", {}))
    base.update(data.get(meeting_type if meeting_type in data else "other", {}))
    ref = base.get(metric, {"low": None, "high": None, "better": "inside"})
    return ref.get("low"), ref.get("high"), ref.get("better", "inside")


def unit_for(metric: str) -> str:
    return load_data("reference_ranges.json").get("units", {}).get(metric, "")


def status_for(value: float | None, low: float | None, high: float | None) -> str:
    """good внутри ориентира, warn при выходе ≤ 20 % ширины (или границы), bad дальше, na без данных."""
    if value is None or (low is None and high is None):
        return "na"
    if low is not None and high is not None:
        width = max(high - low, 1e-9)
        if low <= value <= high:
            return "good"
        dev = (low - value) if value < low else (value - high)
        return "warn" if dev <= WARN_SHARE * width else "bad"
    if high is not None:
        if value <= high:
            return "good"
        tol = WARN_SHARE * max(abs(high), 1e-9)
        return "warn" if value - high <= tol else "bad"
    assert low is not None
    if value >= low:
        return "good"
    tol = WARN_SHARE * max(abs(low), 1e-9)
    return "warn" if low - value <= tol else "bad"


def metric_value(metric: str, value: float | None, meeting_type: str, unit: str | None = None) -> MetricValue:
    low, high, better = reference_for(metric, meeting_type)
    if value is not None:
        try:
            v = float(value)
        except (TypeError, ValueError):
            v = None
        else:
            if v != v or v in (float("inf"), float("-inf")):
                v = None
        value = v
    return MetricValue(
        value=value,
        unit=unit if unit is not None else unit_for(metric),
        ref_low=low,
        ref_high=high,
        better=better,  # type: ignore[arg-type]
        status=status_for(value, low, high),  # type: ignore[arg-type]
    )
