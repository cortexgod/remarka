"""Пересчёт готового отчёта под другой тип встречи без повторного распознавания.

Меняются только то, что зависит от типа: ориентиры и статусы метрик, оценка,
сравнение с базой, события fast_burst. Транскрипт, события речи и просодия
остаются как были.
"""

from __future__ import annotations

from typing import Any

from . import calibration, scoring
from .model import MetricValue, SpeechEvent
from .references import MEETING_TYPES, metric_value, reference_for

WINDOW_SEC = 15.0
FAST_BURST_FACTOR = 1.2


def _metric_values(layer: dict[str, Any], meeting_type: str) -> dict[str, MetricValue]:
    out: dict[str, MetricValue] = {}
    for key, raw in layer.items():
        if not isinstance(raw, dict) or "value" not in raw:
            continue  # crutch_top и прочие списки
        out[key] = metric_value(key, raw.get("value"), meeting_type, unit=raw.get("unit"))
    return out


def rescore(
    doc: dict[str, Any],
    meeting_type: str,
    *,
    baseline_doc: dict[str, Any] | None = None,
    calibration_meetings: int = 0,
    type_source: str = "user",
) -> dict[str, Any]:
    if meeting_type not in MEETING_TYPES:
        raise ValueError(f"Неизвестный тип встречи: {meeting_type}")
    metrics_raw = doc.get("metrics") or {}
    l1 = _metric_values(metrics_raw.get("layer1") or {}, meeting_type)
    l2 = _metric_values(metrics_raw.get("layer2") or {}, meeting_type)
    metrics = {"layer1": l1, "layer2": l2}

    new_l1 = dict(metrics_raw.get("layer1") or {})
    new_l1.update({k: v.to_dict() for k, v in l1.items()})
    new_l2 = dict(metrics_raw.get("layer2") or {})
    new_l2.update({k: v.to_dict() for k, v in l2.items()})
    doc["metrics"] = {"layer1": new_l1, "layer2": new_l2}

    stats = baseline_doc.get("stats") if baseline_doc else None
    doc["score"] = scoring.compute_score(metrics, stats if stats else None)
    cmp = calibration.compare(metrics, baseline_doc) if baseline_doc and stats else calibration.calibrating(calibration_meetings)
    doc["baseline"] = cmp.to_dict() if hasattr(cmp, "to_dict") else cmp

    # fast_burst: окна темпа выше верхней границы ориентира на 20 %
    _, ref_high, _ = reference_for("wpm", meeting_type)
    events = [e for e in (doc.get("events") or []) if e.get("kind") != "fast_burst"]
    if ref_high is not None:
        for p in (doc.get("timeline") or {}).get("wpm") or []:
            v = float(p.get("v") or 0.0)
            if v > 0 and v > ref_high * FAST_BURST_FACTOR:
                ev = SpeechEvent(
                    t=max(0.0, float(p["t"]) - WINDOW_SEC / 2),
                    end=float(p["t"]) + WINDOW_SEC / 2,
                    kind="fast_burst",
                    label=f"{int(round(v))} сл/мин",
                    source="asr",
                    word_i=None,
                    sentence_i=None,
                    value=v,
                )
                events.append(ev.to_dict() if hasattr(ev, "to_dict") else ev.__dict__)
    events.sort(key=lambda e: (e.get("t", 0.0), e.get("end", 0.0)))
    doc["events"] = events

    meeting = doc.setdefault("meeting", {})
    meeting["type"] = meeting_type
    meeting["type_source"] = type_source
    meeting["type_confidence"] = 1.0 if type_source == "user" else float(meeting.get("type_confidence") or 0.0)
    return doc
