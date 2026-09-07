"""Межвстречный слой (CONTRACTS.md §5, «patterns»): инсайты по нескольким встречам,
недельная сводка, 2–4 упражнения под слабую сторону.

``analyze_patterns(reports, client, training_tasks) -> PatternsResult`` (dict по contracts.ts).

Вход модели — сжатые метрики N последних отчётов (id, дата, тип, метрики со статусами,
темп первых 3 минут против остального, филлеры первых 3 минут против остального, score)
плюс наблюдения, посчитанные движком детерминированно. Модель не измеряет — формулирует.
При backend ``none`` (или ошибке модели, если ``strict=False``) возвращается
детерминированный результат: числовая сводка и упражнения из тренажёра по худшим метрикам.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator

from .llm import LlmClient, LlmError, load_prompt, log, render_prompt
from .meaning import MEETING_TYPE_LABELS, METRIC_KEYS

__all__ = [
    "PatternsLlmOutput",
    "compress_report",
    "compute_observations",
    "analyze_patterns",
]

PATTERN_METRICS: tuple[str, ...] = (
    "layer1.wpm",
    "layer1.articulation_wpm",
    "layer1.filled_pauses_per_min",
    "layer1.crutch_words_per_min",
    "layer1.structural_pauses_per_min",
    "layer1.hesitation_pauses_per_min",
    "layer1.talk_ratio",
    "layer1.mean_sentence_len",
    "layer1.long_sentences_share",
    "layer1.interruptions_by_me",
    "layer2.pitch_range_st",
    "layer2.phrase_final_decay_db",
    "layer2.rising_statements_share",
    "layer2.loudness_drift_db",
    "layer2.jitter_pct",
)

METRIC_TITLES = {
    "layer1.wpm": "темп речи",
    "layer1.articulation_wpm": "артикуляционный темп",
    "layer1.filled_pauses_per_min": "заполненные паузы",
    "layer1.crutch_words_per_min": "слова-костыли",
    "layer1.structural_pauses_per_min": "структурные паузы",
    "layer1.hesitation_pauses_per_min": "хезитационные паузы",
    "layer1.talk_ratio": "доля своей речи",
    "layer1.mean_sentence_len": "длина предложения",
    "layer1.long_sentences_share": "доля длинных предложений",
    "layer1.interruptions_by_me": "перебивания",
    "layer2.pitch_range_st": "диапазон тона",
    "layer2.phrase_final_decay_db": "затухание к концу фразы",
    "layer2.rising_statements_share": "восходящие утверждения",
    "layer2.loudness_drift_db": "просадка громкости",
    "layer2.jitter_pct": "джиттер",
}

FIRST_MINUTES_S = 180.0
MAX_INSIGHTS = 5
MIN_EXERCISES, MAX_EXERCISES = 2, 4


class LlmInsight(BaseModel):
    title: str
    detail: str = ""
    metric: Optional[str] = None
    meeting_ids: list[str] = Field(default_factory=list)


class LlmExercise(BaseModel):
    title: str
    instruction: str = ""
    duration_min: float = 5.0
    targets_metric: Optional[str] = None
    training_task_id: Optional[str] = None

    @field_validator("duration_min", mode="before")
    @classmethod
    def _dur(cls, v: Any) -> float:
        try:
            return max(1.0, min(30.0, float(v)))
        except (TypeError, ValueError):
            return 5.0


class PatternsLlmOutput(BaseModel):
    insights: list[LlmInsight] = Field(default_factory=list)
    weekly_summary: str = ""
    exercises: list[LlmExercise] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Сжатие отчётов и детерминированные наблюдения
# ---------------------------------------------------------------------------


def _metric(report: dict[str, Any], key: str) -> dict[str, Any] | None:
    layer, name = key.split(".", 1)
    mv = ((report.get("metrics") or {}).get(layer) or {}).get(name)
    return mv if isinstance(mv, dict) else None


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 1) if values else None


def compress_report(report: dict[str, Any]) -> dict[str, Any]:
    meeting = report.get("meeting") or {}
    duration = float(meeting.get("duration_sec") or 0.0)
    metrics: dict[str, Any] = {}
    for key in PATTERN_METRICS:
        mv = _metric(report, key)
        if mv is None:
            continue
        value = mv.get("value")
        metrics[key] = {
            "value": round(float(value), 2) if isinstance(value, (int, float)) else None,
            "status": mv.get("status"),
            "ref": [mv.get("ref_low"), mv.get("ref_high")],
        }
    wpm_first, wpm_rest = [], []
    for p in ((report.get("timeline") or {}).get("wpm")) or []:
        v = float(p.get("v") or 0.0)
        if v <= 0:
            continue
        (wpm_first if float(p.get("t", 0.0)) < FIRST_MINUTES_S else wpm_rest).append(v)
    fill_first = fill_rest = 0
    questions = 0
    for e in report.get("events") or []:
        kind = e.get("kind")
        if kind == "filled_pause":
            if float(e.get("t", 0.0)) < FIRST_MINUTES_S:
                fill_first += 1
            else:
                fill_rest += 1
        elif kind == "question_from_other":
            questions += 1
    first_span = min(duration, FIRST_MINUTES_S) / 60.0
    rest_span = max(0.0, duration - FIRST_MINUTES_S) / 60.0
    return {
        "id": meeting.get("id"),
        "started_at": meeting.get("started_at"),
        "type": meeting.get("type"),
        "title": meeting.get("title"),
        "duration_min": round(duration / 60.0, 1),
        "score": (report.get("score") or {}).get("overall"),
        "metrics": metrics,
        "wpm_first_3min": _mean(wpm_first),
        "wpm_rest": _mean(wpm_rest),
        "filled_pauses_per_min_first_3min": round(fill_first / first_span, 1) if first_span > 0 else None,
        "filled_pauses_per_min_rest": round(fill_rest / rest_span, 1) if rest_span > 0 else None,
        "questions_from_other": questions,
    }


def _date_label(iso: Any) -> str:
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).strftime("%d.%m")
    except (TypeError, ValueError):
        return str(iso or "?")


def compute_observations(items: list[dict[str, Any]]) -> list[str]:
    """Факты, посчитанные детерминированно; модель их только формулирует."""
    obs: list[str] = []
    n = len(items)
    if n == 0:
        return obs
    # 1. Быстрый старт: темп первых 3 минут выше остального на ≥ 10 %.
    fast_start = [
        it for it in items
        if it.get("wpm_first_3min") and it.get("wpm_rest") and it["wpm_first_3min"] >= it["wpm_rest"] * 1.1
    ]
    if len(fast_start) >= 2:
        streak = 0
        for it in reversed(items):
            if it in fast_start:
                streak += 1
            else:
                break
        ids = ", ".join(f"{_date_label(it['started_at'])} ({it['wpm_first_3min']}→{it['wpm_rest']} сл/мин)" for it in fast_start)
        obs.append(
            f"Темп первых 3 минут выше остального на ≥10 % в {len(fast_start)} из {n} встреч"
            + (f", в том числе {streak} последних подряд" if streak >= 2 else "")
            + f": {ids}. meeting_ids: {[it['id'] for it in fast_start]}"
        )
    # 2. Филлеры в начале.
    fill_start = [
        it for it in items
        if it.get("filled_pauses_per_min_first_3min") is not None and it.get("filled_pauses_per_min_rest") is not None
        and it["filled_pauses_per_min_first_3min"] >= it["filled_pauses_per_min_rest"] * 1.5 + 0.5
    ]
    if len(fill_start) >= 2:
        obs.append(
            f"Заполненных пауз в первые 3 минуты заметно больше, чем дальше, в {len(fill_start)} из {n} встреч: "
            + ", ".join(f"{_date_label(it['started_at'])} ({it['filled_pauses_per_min_first_3min']} против {it['filled_pauses_per_min_rest']} в мин)" for it in fill_start)
            + f". meeting_ids: {[it['id'] for it in fill_start]}"
        )
    # 3. Серии «вне ориентира» по метрикам (последние встречи подряд).
    for key in PATTERN_METRICS:
        streak_ids: list[str] = []
        for it in reversed(items):
            st = (it["metrics"].get(key) or {}).get("status")
            if st in ("warn", "bad"):
                streak_ids.append(it["id"])
            else:
                break
        bad_total = sum(1 for it in items if (it["metrics"].get(key) or {}).get("status") in ("warn", "bad"))
        if len(streak_ids) >= 2 or (bad_total >= 3 and bad_total >= n * 0.6):
            values = ", ".join(
                f"{_date_label(it['started_at'])}: {it['metrics'][key]['value']} ({it['metrics'][key]['status']})"
                for it in items if key in it["metrics"]
            )
            obs.append(
                f"{METRIC_TITLES.get(key, key)} ({key}) вне ориентира в {bad_total} из {n} встреч"
                + (f", последние {len(streak_ids)} подряд" if len(streak_ids) >= 2 else "")
                + f": {values}. meeting_ids: {list(reversed(streak_ids)) if len(streak_ids) >= 2 else [it['id'] for it in items if (it['metrics'].get(key) or {}).get('status') in ('warn', 'bad')]}"
            )
    # 4. Динамика оценки и темпа.
    scores = [(it["id"], it["score"]) for it in items if isinstance(it.get("score"), (int, float))]
    if len(scores) >= 2:
        first, last = scores[0][1], scores[-1][1]
        obs.append(f"Оценка: первая встреча периода {first}, последняя {last} (изменение {last - first:+d}). Все: {[s for _, s in scores]}")
    wpms = [(it["metrics"]["layer1.wpm"]["value"]) for it in items if it["metrics"].get("layer1.wpm", {}).get("value") is not None]
    if len(wpms) >= 2:
        obs.append(f"Темп речи по встречам: {wpms} сл/мин (среднее {round(sum(wpms) / len(wpms))}).")
    # 5. Типы встреч.
    types = [it.get("type") for it in items]
    obs.append("Типы встреч: " + ", ".join(f"{t} ({MEETING_TYPE_LABELS.get(t, t)})" for t in types))
    return obs


# ---------------------------------------------------------------------------
# Детерминированный запасной результат
# ---------------------------------------------------------------------------


# Веса из оценки 0–100 (CONTRACTS.md §4.6): чем больше вес, тем важнее слабая метрика.
_SCORE_WEIGHTS = {
    "layer1.filled_pauses_per_min": 20, "layer1.wpm": 15, "layer2.pitch_range_st": 15,
    "layer1.crutch_words_per_min": 10, "layer1.hesitation_pauses_per_min": 10, "layer1.talk_ratio": 10,
    "layer2.phrase_final_decay_db": 5, "layer2.rising_statements_share": 5,
    "layer1.long_sentences_share": 5, "layer1.interruptions_by_me": 5,
}


def _worst_metrics(items: list[dict[str, Any]]) -> list[str]:
    """Метрики по убыванию «вреда»: (2·bad + 1·warn по встречам) × вес метрики в оценке."""
    scored: list[tuple[int, str]] = []
    for key in PATTERN_METRICS:
        bad = sum(
            2 if (it["metrics"].get(key) or {}).get("status") == "bad"
            else 1 if (it["metrics"].get(key) or {}).get("status") == "warn" else 0
            for it in items
        )
        if bad:
            scored.append((bad * _SCORE_WEIGHTS.get(key, 3), key))
    scored.sort(key=lambda x: (-x[0], PATTERN_METRICS.index(x[1])))
    return [k for _, k in scored]


def _exercise_from_task(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": str(task.get("title") or task.get("id") or "Упражнение"),
        "instruction": str(task.get("instruction") or ""),
        "duration_min": max(1.0, round(float(task.get("duration_sec") or 60) / 60.0, 1)),
        "targets_metric": task.get("targets_metric"),
        "training_task_id": task.get("id"),
    }


def _fallback_exercises(items: list[dict[str, Any]], training_tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_metric: dict[str, list[dict[str, Any]]] = {}
    for task in training_tasks or []:
        if task.get("targets_metric"):
            by_metric.setdefault(str(task["targets_metric"]), []).append(task)
    out: list[dict[str, Any]] = []
    used: set[str] = set()
    for key in _worst_metrics(items):
        for task in by_metric.get(key, []):
            if task.get("id") not in used:
                out.append(_exercise_from_task(task))
                used.add(str(task.get("id")))
                break
        if len(out) >= MAX_EXERCISES:
            break
    for task in training_tasks or []:
        if len(out) >= MIN_EXERCISES:
            break
        if task.get("id") not in used:
            out.append(_exercise_from_task(task))
            used.add(str(task.get("id")))
    return out[:MAX_EXERCISES]


def _fallback_summary(items: list[dict[str, Any]]) -> str:
    if not items:
        return "Пока нет готовых встреч — сводка появится после первого разбора."
    n = len(items)
    dates = f"{_date_label(items[0]['started_at'])}–{_date_label(items[-1]['started_at'])}" if n > 1 else _date_label(items[0]["started_at"])
    lines = [f"**{n} встреч за период {dates}.**"]
    scores = [it["score"] for it in items if isinstance(it.get("score"), (int, float))]
    if scores:
        lines.append(f"- Оценка: средняя {round(sum(scores) / len(scores))}, последняя {scores[-1]}.")
    for key in ("layer1.wpm", "layer1.filled_pauses_per_min", "layer1.crutch_words_per_min", "layer2.pitch_range_st"):
        vals = [it["metrics"][key]["value"] for it in items if it["metrics"].get(key, {}).get("value") is not None]
        if vals:
            bad = sum(1 for it in items if (it["metrics"].get(key) or {}).get("status") in ("warn", "bad"))
            lines.append(f"- {METRIC_TITLES[key].capitalize()}: среднее {round(sum(vals) / len(vals), 1)}, вне ориентира в {bad} из {len(vals)} встреч.")
    worst = _worst_metrics(items)[:2]
    if worst:
        lines.append("- Чаще всего вне ориентира: " + ", ".join(METRIC_TITLES.get(k, k) for k in worst) + ".")
    lines.append("_Инсайты от языковой модели появятся, когда включён LLM-бэкенд._")
    return "\n".join(lines)


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _result(
    items: list[dict[str, Any]],
    backend: str,
    insights: list[dict[str, Any]],
    weekly_summary: str,
    exercises: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "generated_at": _now_iso(),
        "meetings_used": [str(it["id"]) for it in items if it.get("id")],
        "insights": insights,
        "weekly_summary": weekly_summary,
        "exercises": exercises,
        "backend": backend,
    }


# ---------------------------------------------------------------------------
# Главная функция
# ---------------------------------------------------------------------------


def _valid_metric(metric: Any) -> str | None:
    if not metric:
        return None
    m = str(metric).strip()
    if m in METRIC_KEYS:
        return m
    for prefix in ("layer1.", "layer2."):
        if prefix + m in METRIC_KEYS:
            return prefix + m
    return None


def analyze_patterns(
    reports: list[dict[str, Any]],
    client: LlmClient,
    training_tasks: list[dict[str, Any]],
    strict: bool = False,
) -> dict[str, Any]:
    """``PatternsResult`` по списку отчётов (любой порядок — сортируются по дате).

    ``strict=True`` — ошибка модели пробрасывается ``LlmError``; иначе возвращается
    детерминированный результат с ``backend: "none"``.
    """
    items = [compress_report(r) for r in reports if isinstance(r, dict) and r.get("meeting")]
    items.sort(key=lambda it: str(it.get("started_at") or ""))
    training_tasks = list(training_tasks or [])
    task_ids = {str(t.get("id")) for t in training_tasks if t.get("id")}
    task_by_metric = {str(t.get("targets_metric")): str(t.get("id")) for t in training_tasks if t.get("targets_metric") and t.get("id")}

    if client is None or client.backend == "none" or not items:
        return _result(items, "none", [], _fallback_summary(items), _fallback_exercises(items, training_tasks))

    observations = compute_observations(items)
    user = render_prompt(
        load_prompt("patterns_user"),
        n=len(items),
        meetings_json=json.dumps(items, ensure_ascii=False, indent=1),
        observations="\n".join(f"- {o}" for o in observations) or "- (закономерностей движок не нашёл — опирайся на числа выше)",
        tasks_json=json.dumps(
            [{"id": t.get("id"), "title": t.get("title"), "targets_metric": t.get("targets_metric"), "duration_sec": t.get("duration_sec")} for t in training_tasks],
            ensure_ascii=False,
        ),
        metric_keys=", ".join(PATTERN_METRICS),
    )
    try:
        out = client.complete_json(load_prompt("patterns_system"), user, PatternsLlmOutput)
    except LlmError as exc:
        if strict:
            raise
        log(f"patterns: модель недоступна, детерминированная сводка: {exc}", "warn")
        return _result(items, "none", [], _fallback_summary(items), _fallback_exercises(items, training_tasks))

    used_ids = {str(it["id"]) for it in items if it.get("id")}
    insights: list[dict[str, Any]] = []
    for ins in out.insights[:MAX_INSIGHTS]:
        if not ins.title.strip():
            continue
        ids = [str(i) for i in ins.meeting_ids if str(i) in used_ids]
        insights.append({"title": ins.title.strip(), "detail": ins.detail.strip(), "metric": _valid_metric(ins.metric), "meeting_ids": ids})

    exercises: list[dict[str, Any]] = []
    for ex in out.exercises[:MAX_EXERCISES]:
        if not ex.title.strip():
            continue
        metric = _valid_metric(ex.targets_metric)
        task_id = ex.training_task_id if ex.training_task_id in task_ids else task_by_metric.get(metric or "")
        exercises.append({
            "title": ex.title.strip(),
            "instruction": ex.instruction.strip(),
            "duration_min": float(ex.duration_min),
            "targets_metric": metric,
            "training_task_id": task_id,
        })
    if len(exercises) < MIN_EXERCISES:
        have = {e["training_task_id"] for e in exercises}
        for e in _fallback_exercises(items, training_tasks):
            if e["training_task_id"] not in have:
                exercises.append(e)
                have.add(e["training_task_id"])
            if len(exercises) >= MIN_EXERCISES:
                break

    weekly = out.weekly_summary.strip() or _fallback_summary(items)
    return _result(items, client.backend, insights, weekly, exercises[:MAX_EXERCISES])
