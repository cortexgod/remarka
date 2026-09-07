"""Живой прогон слоя смысла через реальный бэкенд (по умолчанию claude_cli).

Запуск: ``REMARKA_RUN_SLOW=1 python -m pytest -m slow -s tests/test_meaning_live.py``
(тот же флаг, что у медленных тестов движка). Бэкенд: ``REMARKA_TEST_LLM=claude_cli|anthropic_api``
(по умолчанию автоопределение с предпочтением claude_cli), модель — ``REMARKA_TEST_LLM_MODEL``.
Результаты пишутся в JSON-файлы каталога ``REMARKA_LIVE_OUT`` (если задан) для отчёта.
Тест пропускается, если флаг не задан, бэкенда нет или он не авторизован (``claude login``).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from remarka_engine.llm import LlmClient, detect_backend
from remarka_engine.meaning import ANSWER_KINDS, MEETING_TYPES, analyze_meaning, find_quote
from remarka_engine.patterns import analyze_patterns
from remarka_engine.prepare import prepare_meeting
from test_meaning_helpers import definition_schema, load_schema, make_report

pytestmark = pytest.mark.slow


def _dump(name: str, data: Any) -> None:
    out_dir = os.environ.get("REMARKA_LIVE_OUT")
    text = json.dumps(data, ensure_ascii=False, indent=1)
    print(f"\n===== {name} =====\n{text}\n")
    if out_dir:
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        (Path(out_dir) / f"{name}.json").write_text(text, encoding="utf-8")


@pytest.fixture(scope="module")
def live_client() -> LlmClient:
    if os.environ.get("REMARKA_RUN_SLOW", "") != "1":
        pytest.skip("живые вызовы модели: задайте REMARKA_RUN_SLOW=1")
    backend = detect_backend(os.environ.get("REMARKA_TEST_LLM") or "claude_cli")
    if backend == "none":
        pytest.skip("нет LLM-бэкенда: ни claude в PATH, ни ANTHROPIC_API_KEY")
    client = LlmClient(backend, model=os.environ.get("REMARKA_TEST_LLM_MODEL", "claude-opus-5"), timeout_s=300)
    if not client.ping(timeout_s=90):
        pytest.skip(f"бэкенд {backend} не отвечает (нет авторизации? для claude_cli выполните `claude login`)")
    return client


def test_live_meaning_on_fixture_transcript(live_client: LlmClient) -> None:
    report = make_report()
    progress: list[tuple[int, str]] = []
    meaning = analyze_meaning(report, live_client, None, progress=lambda pct, msg: progress.append((pct, msg)))
    _dump("live_meaning", {"progress": progress, "meaning": meaning, "last_raw": live_client.last_raw})
    assert meaning is not None
    assert meaning["backend"] == live_client.backend and meaning["model"] == live_client.model
    assert meaning["meeting_type"]["type"] in MEETING_TYPES

    words = report["transcript"]["words"]
    assert meaning["three_things"], "модель не дала ни одной рекомендации с дословной цитатой"
    for thing in meaning["three_things"]:
        match = find_quote(words, thing["quote"])
        assert match is not None and match.t == thing["t"]
        assert thing["instead"].strip() and thing["why"].strip() and thing["title"].strip()
    assert len(meaning["three_things"]) >= 2

    unit = [q for q in meaning["questions"] if "юнит" in q["asked"].lower() or "эконом" in q["asked"].lower()]
    assert unit, f"нет оценки ответа на вопрос про юнит-экономику: {meaning['questions']}"
    assert unit[0]["answered"] in ANSWER_KINDS and unit[0]["comment"].strip()
    assert unit[0]["t"] == 36.5  # заякорено по реплике собеседника
    assert meaning["summary"].strip()

    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.validate(meaning, definition_schema(load_schema("report.schema.json"), "Meaning"))


def test_live_prepare_pitch(live_client: LlmClient) -> None:
    res = prepare_meeting("питч сервиса анализа речи на созвонах", "pitch", live_client, strict=True)
    _dump("live_prepare", res)
    assert res["backend"] == live_client.backend and res["meeting_type"] == "pitch"
    assert 5 <= len(res["checklist"]) <= 8 and len(res["likely_questions"]) == 3
    assert all(q["how_to_prepare"].strip() for q in res["likely_questions"])
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.validate(res, load_schema("prep.schema.json"))


def test_live_patterns_three_meetings(live_client: LlmClient) -> None:
    reports = []
    for k, (rid, date) in enumerate([
        ("aaaaaaaa-0000-4000-8000-000000000001", "2026-09-01T10:00:00+03:00"),
        ("aaaaaaaa-0000-4000-8000-000000000002", "2026-09-03T10:00:00+03:00"),
        ("aaaaaaaa-0000-4000-8000-000000000003", "2026-09-05T10:00:00+03:00"),
    ]):
        r = make_report(meeting={"id": rid, "started_at": date, "type": "pitch", "duration_sec": 400.0})
        r["timeline"]["wpm"] = [{"t": 7.5 + 5 * i, "v": 158.0 - k if 7.5 + 5 * i < 180 else 121.0} for i in range(70)]
        r["score"]["overall"] = 55 + 5 * k
        reports.append(r)
    tasks = [
        {"id": "elevator_60", "title": "Расскажи о проекте за 60 секунд без заполненных пауз", "instruction": "…", "duration_sec": 60, "targets_metric": "layer1.filled_pauses_per_min", "meeting_type": "training"},
        {"id": "slow_120", "title": "Две минуты в темпе 100–120 сл/мин", "instruction": "…", "duration_sec": 120, "targets_metric": "layer1.wpm", "meeting_type": "training"},
    ]
    res = analyze_patterns(reports, live_client, tasks, strict=True)
    _dump("live_patterns", res)
    assert res["backend"] == live_client.backend and len(res["insights"]) >= 2 and 2 <= len(res["exercises"]) <= 4
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.validate(res, load_schema("patterns.schema.json"))
