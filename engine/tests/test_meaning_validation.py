"""Валидация цитат, якоря таймкодов и сборка Meaning с подменённым клиентом."""

from __future__ import annotations

from typing import Any

import pytest

from remarka_engine import meaning as M
from remarka_engine.llm import LlmClient, LlmError
from remarka_engine.meaning import (
    LlmThreeThing,
    MeaningLlmOutput,
    analyze_meaning,
    anchor_question,
    build_meaning_prompt,
    find_quote,
    match_key,
    norm_token,
    validate_three_things,
)
from remarka_engine.summary import SummaryLlmOutput
from test_meaning_helpers import definition_schema, load_schema, make_report, word_by_text


@pytest.fixture()
def report() -> dict[str, Any]:
    return make_report()


@pytest.fixture()
def words(report: dict[str, Any]) -> list[dict[str, Any]]:
    return report["transcript"]["words"]


# ---------------------------------------------------------------------------
# Нормализация
# ---------------------------------------------------------------------------


def test_norm_token_rules() -> None:
    assert norm_token("Продукт,") == "продукт"
    assert norm_token("Ещё!") == "еще"
    assert norm_token("э-э") == "э-э"
    assert norm_token("«э‑э»") == "э-э"  # неразрывный дефис → обычный
    assert norm_token("—") == ""
    assert match_key("Э-э,") == "ээ"


# ---------------------------------------------------------------------------
# Поиск цитат
# ---------------------------------------------------------------------------


def test_find_quote_exact(words: list[dict[str, Any]], report: dict[str, Any]) -> None:
    m = find_quote(words, "сервис анализа речи на созвонах.")
    assert m is not None
    assert m.ratio == pytest.approx(1.0)
    assert m.t == word_by_text(report, "сервис")["start"]
    assert m.text == "сервис анализа речи на созвонах."


def test_find_quote_punctuation_and_case(words: list[dict[str, Any]], report: dict[str, Any]) -> None:
    m = find_quote(words, "СЕГОДНЯ я хочу — рассказать про наш «продукт»!")
    assert m is not None
    assert m.t == word_by_text(report, "сегодня")["start"]
    assert m.word_from == word_by_text(report, "сегодня")["i"]
    assert m.word_to == word_by_text(report, "продукт.")["i"]


def test_find_quote_yo_vs_ye(words: list[dict[str, Any]], report: dict[str, Any]) -> None:
    m = find_quote(words, "мы считаем все локально")
    assert m is not None
    assert m.t == word_by_text(report, "мы")["start"]
    assert "всё" in m.text


def test_find_quote_hyphenated_filler(words: list[dict[str, Any]], report: dict[str, Any]) -> None:
    m = find_quote(words, "ээ сегодня я хочу рассказать")
    assert m is not None
    assert m.t == word_by_text(report, "Э-э,")["start"]


def test_find_quote_tolerates_one_wrong_word(words: list[dict[str, Any]], report: dict[str, Any]) -> None:
    # 1 слово из 6 не совпало: 2·5/12 = 0,83 ≥ 0,8
    m = find_quote(words, "он типа слышит как вы говорите")
    assert m is not None
    assert m.t == word_by_text(report, "Он,")["start"]


def test_find_quote_not_found(words: list[dict[str, Any]]) -> None:
    assert find_quote(words, "мы привлекли сто клиентов в прошлом квартале") is None
    assert find_quote(words, "сервис для анализа вашей речи во время созвонов") is None  # перефраз: 0,62 < 0,8
    assert find_quote(words, "") is None
    assert find_quote([], "сервис анализа речи") is None


def test_find_quote_across_sentence_boundary(words: list[dict[str, Any]], report: dict[str, Any]) -> None:
    m = find_quote(words, "аудио никуда не уходит. Э-э, ну, рынок очень большой")
    assert m is not None
    assert m.t == word_by_text(report, "аудио")["start"]


# ---------------------------------------------------------------------------
# Валидация «трёх вещей»
# ---------------------------------------------------------------------------


def test_validate_three_things_drops_unfound_and_anchors(words: list[dict[str, Any]], report: dict[str, Any]) -> None:
    things = [
        LlmThreeThing(title="Ответить на вопрос про деньги числами", why="ушёл в рынок",
                      quote="рынок очень большой, м-м, миллионы людей", instead="CAC 1200 ₽, LTV 9000 ₽",
                      metric="filled_pauses_per_min"),
        LlmThreeThing(title="Выдуманная", why="", quote="мы привлекли сто клиентов", instead="", metric="layer1.wpm"),
        LlmThreeThing(title="Убрать костыли в описании продукта — " + "очень длинный заголовок " * 4, why="",
                      quote="это, как бы, сервис анализа речи", instead="Это сервис анализа речи на созвонах.",
                      metric="bogus"),
    ]
    kept, dropped = validate_three_things(words, things)
    assert len(dropped) == 1 and dropped[0].title == "Выдуманная"
    assert [k["t"] for k in kept] == [word_by_text(report, "рынок")["start"], word_by_text(report, "это,")["start"]]
    assert kept[0]["quote"] == "рынок очень большой, м-м, миллионы людей"  # дословно из транскрипта
    assert kept[0]["metric"] == "layer1.filled_pauses_per_min"  # голое имя дополнено слоем
    assert kept[1]["metric"] is None  # неизвестная метрика → null
    assert len(kept[1]["title"]) <= 60 and kept[1]["title"].endswith("…")


def test_validate_three_things_dedups_same_place(words: list[dict[str, Any]]) -> None:
    things = [LlmThreeThing(title="а", quote="рынок очень большой"), LlmThreeThing(title="б", quote="рынок очень большой, м-м")]
    kept, dropped = validate_three_things(words, things)
    assert len(kept) == 1 and len(dropped) == 1


# ---------------------------------------------------------------------------
# Якоря вопросов
# ---------------------------------------------------------------------------


def test_anchor_question_by_other_text(report: dict[str, Any]) -> None:
    assert anchor_question(report, "Как у вас с юнит-экономикой?", 0.0) == 36.5
    assert anchor_question(report, "Чем вы отличаетесь от конкурентов?", 10.0) == 50.0


def test_anchor_question_fallbacks(report: dict[str, Any]) -> None:
    # текст не совпал, но рядом (≤ 20 с) есть вопрос собеседника → его начало
    assert anchor_question(report, "Расскажите про команду", 47.0) == 50.0
    # ни текста, ни вопроса рядом → ближайшее начало моего предложения
    assert anchor_question(report, "Расскажите про команду", 5.0) == 5.2
    # без системной дорожки → округление по предложению
    report["transcript"]["other"] = []
    assert anchor_question(report, "Как у вас с юнит-экономикой?", 17.0) == 17.4


# ---------------------------------------------------------------------------
# Промпт
# ---------------------------------------------------------------------------


def test_build_meaning_prompt_contains_transcript_and_metrics(report: dict[str, Any]) -> None:
    text = build_meaning_prompt(report, None)
    assert "[00:05] Э-э, сегодня я хочу рассказать про наш продукт." in text
    assert "[00:36] СОБЕСЕДНИК: Скажите, а как у вас с юнит-экономикой?" in text  # 36,5 с → 00:36
    assert '"layer1.filled_pauses_per_min"' in text and '"status": "bad"' in text
    assert "не задан — определи" in text
    assert "{{" not in text
    fixed = build_meaning_prompt(report, "demo")
    assert "ЗАДАН ПОЛЬЗОВАТЕЛЕМ" in fixed and "demo" in fixed


# ---------------------------------------------------------------------------
# Сборка Meaning с подменённым клиентом
# ---------------------------------------------------------------------------


class ScriptedClient(LlmClient):
    """Клиент, отдающий заранее заданные ответы по типу схемы."""

    def __init__(self, meaning_outputs: list[Any], summary_output: Any, backend: str = "claude_cli") -> None:
        super().__init__(backend, model="fake-model")
        self._meaning = list(meaning_outputs)
        self._summary = summary_output
        self.prompts: list[tuple[str, str]] = []

    def available(self) -> bool:  # noqa: D401
        return True

    def complete_json(self, system: str, user: str, schema_model: type) -> Any:
        self.calls += 1
        self.prompts.append((system, user))
        if schema_model is MeaningLlmOutput:
            out = self._meaning.pop(0)
        elif schema_model is SummaryLlmOutput:
            out = self._summary
        else:
            raise AssertionError(schema_model)
        if isinstance(out, Exception):
            raise out
        return schema_model.model_validate(out)


def _meaning_payload(quotes: list[str]) -> dict[str, Any]:
    return {
        "meeting_type": {"type": "pitch", "confidence": 0.9, "reason": "рассказывает инвесторам про продукт и рынок"},
        "structure": {"kept": False, "comment": "нет следующего шага"},
        "questions": [
            {"t": "0:38", "asked": "Как у вас с юнит-экономикой?", "answered": "off-topic", "comment": "ушёл в размер рынка"},
            {"t": 51, "asked": "Чем отличаетесь от конкурентов?", "answered": "on_topic", "comment": "десктоп рядом с Зумом"},
        ],
        "jargon": [{"t": 60, "term": "десктоп", "comment": "приложение на компьютере"}],
        "three_things": [
            {"title": f"Правка {i + 1}", "why": "важно", "quote": q, "instead": "скажи так", "metric": None}
            for i, q in enumerate(quotes)
        ],
    }


SUMMARY = {"summary": "### О чём\n- продукт", "agreements": [{"text": "прислать цифры", "owner": "я", "due": ""}]}


def test_analyze_meaning_retries_when_quotes_missing(report: dict[str, Any]) -> None:
    first = _meaning_payload(["рынок очень большой, м-м, миллионы людей", "мы привлекли сто клиентов", "выдуманная цитата номер два"])
    second = _meaning_payload(["сервис анализа речи на созвонах", "мы считаем всё локально, аудио никуда не уходит", "рынок очень большой"])
    client = ScriptedClient([first, second], SUMMARY)
    progress: list[tuple[int, str]] = []
    meaning = analyze_meaning(report, client, None, progress=lambda pct, msg: progress.append((pct, msg)))
    assert meaning is not None
    assert client.calls == 3  # основной + повтор + конспект
    assert "цитаты НЕ найдены" in client.prompts[1][1] and "мы привлекли сто клиентов" in client.prompts[1][1]
    assert meaning["dropped_things"] == 2
    assert len(meaning["three_things"]) == 3
    assert [t["t"] for t in meaning["three_things"]] == sorted(t["t"] for t in meaning["three_things"])
    quotes = [t["quote"] for t in meaning["three_things"]]
    assert "сервис анализа речи на созвонах." in quotes
    assert "мы считаем всё локально, аудио никуда не уходит." in quotes
    assert all(find_quote(report["transcript"]["words"], t["quote"]) is not None for t in meaning["three_things"])
    assert meaning["meeting_type"] == {"type": "pitch", "confidence": 0.9, "reason": "рассказывает инвесторам про продукт и рынок"}
    assert meaning["questions"][0] == {"t": 36.5, "asked": "Как у вас с юнит-экономикой?", "answered": "off_topic", "comment": "ушёл в размер рынка"}
    assert meaning["questions"][1]["t"] == 50.0
    assert meaning["jargon"][0]["t"] == word_by_text(report, "десктопе,")["start"]
    assert meaning["summary"].startswith("### О чём")
    assert meaning["agreements"] == [{"text": "прислать цифры", "owner": "я", "due": None}]
    assert meaning["backend"] == "claude_cli" and meaning["model"] == "fake-model"
    assert progress[0][0] == 0 and progress[-1] == (100, "Слой смысла готов")
    assert any("повторный запрос" in msg for _, msg in progress)


def test_analyze_meaning_no_retry_when_three_found(report: dict[str, Any]) -> None:
    payload = _meaning_payload(["Здравствуйте, коллеги", "сервис анализа речи на созвонах", "рынок очень большой", "работаем прямо рядом с Зумом"])
    client = ScriptedClient([payload], SUMMARY)
    meaning = analyze_meaning(report, client)
    assert client.calls == 2
    assert meaning is not None and len(meaning["three_things"]) == 3 and meaning["dropped_things"] == 0


def test_analyze_meaning_user_type_is_fixed(report: dict[str, Any]) -> None:
    client = ScriptedClient([_meaning_payload(["Здравствуйте, коллеги", "сервис анализа речи", "рынок очень большой"])], SUMMARY)
    meaning = analyze_meaning(report, client, user_meeting_type="demo")
    assert meaning is not None
    assert meaning["meeting_type"]["type"] == "demo" and meaning["meeting_type"]["confidence"] == 1.0
    assert "ЗАДАН ПОЛЬЗОВАТЕЛЕМ" in client.prompts[0][1]


def test_analyze_meaning_survives_summary_failure(report: dict[str, Any]) -> None:
    client = ScriptedClient([_meaning_payload(["Здравствуйте, коллеги", "сервис анализа речи", "рынок очень большой"])], LlmError("сеть"))
    meaning = analyze_meaning(report, client)
    assert meaning is not None and meaning["summary"] == "" and meaning["agreements"] == []


def test_analyze_meaning_retry_failure_keeps_first_result(report: dict[str, Any]) -> None:
    client = ScriptedClient([_meaning_payload(["Здравствуйте, коллеги", "выдумка"]), LlmError("таймаут")], SUMMARY)
    meaning = analyze_meaning(report, client)
    assert meaning is not None and len(meaning["three_things"]) == 1 and meaning["dropped_things"] == 1


def test_analyze_meaning_main_failure_raises(report: dict[str, Any]) -> None:
    client = ScriptedClient([LlmError("401")], SUMMARY)
    with pytest.raises(LlmError):
        analyze_meaning(report, client)


def test_analyze_meaning_none_backend_and_empty_transcript(report: dict[str, Any]) -> None:
    assert analyze_meaning(report, LlmClient("none")) is None
    tiny = make_report(transcript={"words": [], "sentences": [], "other": []})
    assert analyze_meaning(tiny, ScriptedClient([], SUMMARY)) is None


def test_meaning_and_report_match_json_schema(report: dict[str, Any]) -> None:
    jsonschema = pytest.importorskip("jsonschema")
    client = ScriptedClient([_meaning_payload(["Здравствуйте, коллеги", "сервис анализа речи на созвонах", "рынок очень большой"])], SUMMARY)
    meaning = analyze_meaning(report, client)
    schema = load_schema("report.schema.json")
    jsonschema.validate(meaning, definition_schema(schema, "Meaning"))
    report["meaning"] = meaning
    report["meeting"]["type"] = meaning["meeting_type"]["type"]
    jsonschema.validate(report, schema)


def test_llm_output_model_coerces_loose_values() -> None:
    out = MeaningLlmOutput.model_validate({
        "meeting_type": {"type": "Sales", "confidence": 1.7, "reason": ""},
        "structure": {"kept": "false", "comment": ""},
        "questions": [{"t": "[01:05]", "asked": "?", "answered": "unanswered"}],
        "jargon": [{"t": None, "term": "API"}],
        "three_things": [],
    })
    assert out.meeting_type.type == "sales" and out.meeting_type.confidence == 1.0
    assert out.structure.kept is False
    assert out.questions[0].t == 65.0 and out.questions[0].answered == "not_answered"
    assert out.jargon[0].t == 0.0
    assert M.MeaningLlmOutput.model_validate({"meeting_type": {"type": "webinar"}, "structure": {}}).meeting_type.type == "lecture"
