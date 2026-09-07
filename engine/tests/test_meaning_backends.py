"""Бэкенды LLM с подменой subprocess / anthropic-клиента; patterns и prepare с подменённым клиентом."""

from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace
from typing import Any

import pydantic
import pytest

from remarka_engine import llm as L
from remarka_engine.llm import LlmClient, LlmError, LlmParseError, LlmUnavailableError, detect_backend, extract_json_block
from remarka_engine.meaning import analyze_meaning, find_quote
from remarka_engine.patterns import PatternsLlmOutput, analyze_patterns, compress_report, compute_observations
from remarka_engine.prepare import PrepLlmOutput, prepare_meeting
from test_meaning_helpers import load_schema, make_report


class Pong(pydantic.BaseModel):
    answer: str
    n: int


def _envelope(result: str, **extra: Any) -> str:
    data = {"type": "result", "subtype": "success", "is_error": False, "duration_ms": 10, "result": result, "session_id": "x"}
    data.update(extra)
    return json.dumps(data, ensure_ascii=False)


class FakeRun:
    """Подмена subprocess.run: очередь ответов (строка stdout | исключение | код возврата)."""

    def __init__(self, *outputs: Any) -> None:
        self.outputs = list(outputs)
        self.calls: list[dict[str, Any]] = []

    def __call__(self, cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        self.calls.append({"cmd": cmd, **kwargs})
        out = self.outputs.pop(0)
        if isinstance(out, BaseException):
            raise out
        if isinstance(out, tuple):
            code, stdout, stderr = out
            return subprocess.CompletedProcess(cmd, code, stdout=stdout, stderr=stderr)
        return subprocess.CompletedProcess(cmd, 0, stdout=out, stderr="")


@pytest.fixture()
def cli(monkeypatch: pytest.MonkeyPatch) -> LlmClient:
    monkeypatch.setattr(L, "find_cli", lambda cli_path=None: "/fake/bin/claude")
    monkeypatch.setenv("CLAUDECODE", "1")
    return LlmClient("claude_cli")


# ---------------------------------------------------------------------------
# claude_cli
# ---------------------------------------------------------------------------


def test_cli_parses_fenced_json_and_builds_command(cli: LlmClient, monkeypatch: pytest.MonkeyPatch) -> None:
    run = FakeRun(_envelope('Вот ответ:\n```json\n{"answer": "привет", "n": 2}\n```\nГотово.'))
    monkeypatch.setattr(L.subprocess, "run", run)
    out = cli.complete_json("СИСТЕМА", "ЗАПРОС", Pong)
    assert out == Pong(answer="привет", n=2)
    assert cli.available() and cli.calls == 1
    call = run.calls[0]
    cmd = call["cmd"]
    assert cmd[0] == "/fake/bin/claude" and cmd[1] == "-p"
    assert cmd[cmd.index("--output-format") + 1] == "json"
    assert cmd[cmd.index("--model") + 1] == "claude-opus-5"
    assert cmd[cmd.index("--system-prompt") + 1] == "СИСТЕМА"
    assert cmd[-2:] == ["--tools", ""]
    assert "--json-schema" not in cmd
    assert call["input"] == "ЗАПРОС"  # промпт — в stdin
    assert call["timeout"] == 180.0
    assert "CLAUDECODE" not in call["env"] and call["env"]["CLAUDE_CODE_MAX_RETRIES"] == "3"


def test_cli_retries_once_with_strict_hint(cli: LlmClient, monkeypatch: pytest.MonkeyPatch) -> None:
    run = FakeRun(_envelope("Не могу ответить в JSON."), _envelope('{"answer": "ок", "n": 1}'))
    monkeypatch.setattr(L.subprocess, "run", run)
    out = cli.complete_json("s", "u", Pong)
    assert out.n == 1 and len(run.calls) == 2
    second = run.calls[1]["input"]
    assert second.startswith("u") and "Ответь строго JSON по схеме" in second and '"answer"' in second


def test_cli_invalid_twice_raises_parse_error(cli: LlmClient, monkeypatch: pytest.MonkeyPatch) -> None:
    run = FakeRun(_envelope('{"answer": "без n"}'), _envelope("совсем не json"))
    monkeypatch.setattr(L.subprocess, "run", run)
    with pytest.raises(LlmParseError):
        cli.complete_json("s", "u", Pong)
    assert len(run.calls) == 2


def test_cli_error_envelope_is_not_retried(cli: LlmClient, monkeypatch: pytest.MonkeyPatch) -> None:
    body = _envelope("Failed to authenticate. API Error: 401", is_error=True)
    run = FakeRun((1, body, ""))
    monkeypatch.setattr(L.subprocess, "run", run)
    with pytest.raises(LlmError, match="401"):
        cli.complete_json("s", "u", Pong)
    assert len(run.calls) == 1


def test_cli_timeout_and_empty_output(cli: LlmClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(L.subprocess, "run", FakeRun(subprocess.TimeoutExpired(["claude"], 180)))
    with pytest.raises(LlmError, match="не ответил"):
        cli.complete_json("s", "u", Pong)
    monkeypatch.setattr(L.subprocess, "run", FakeRun((2, "", "boom")))
    with pytest.raises(LlmError, match="boom"):
        cli.complete_json("s", "u", Pong)


def test_cli_structured_output_and_verbose_array(cli: LlmClient, monkeypatch: pytest.MonkeyPatch) -> None:
    structured = _envelope("текст", structured_output={"answer": "структурно", "n": 5})
    verbose = json.dumps([{"type": "system"}, json.loads(_envelope('{"answer": "массив", "n": 6}'))])
    run = FakeRun(structured, verbose)
    monkeypatch.setattr(L.subprocess, "run", run)
    assert cli.complete_json("s", "u", Pong).answer == "структурно"
    assert cli.complete_json("s", "u", Pong).answer == "массив"


def test_cli_json_schema_flag_optional(cli: LlmClient, monkeypatch: pytest.MonkeyPatch) -> None:
    run = FakeRun(_envelope('{"answer": "x", "n": 1}'))
    monkeypatch.setattr(L.subprocess, "run", run)
    cli.cli_use_json_schema = True
    cli.complete_json("s", "u", Pong)
    cmd = run.calls[0]["cmd"]
    assert json.loads(cmd[cmd.index("--json-schema") + 1])["title"] == "Pong"


def test_cli_unavailable_without_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(L, "find_cli", lambda cli_path=None: None)
    client = LlmClient("claude_cli")
    assert client.available() is False
    with pytest.raises(LlmUnavailableError):
        client.complete_json("s", "u", Pong)
    assert client.ping() is False


def test_cli_ping_uses_short_timeout_and_no_retries(cli: LlmClient, monkeypatch: pytest.MonkeyPatch) -> None:
    run = FakeRun(_envelope('{"ok": true}'))
    monkeypatch.setattr(L.subprocess, "run", run)
    assert cli.ping(timeout_s=7) is True
    assert run.calls[0]["timeout"] == 7.0 and run.calls[0]["env"]["CLAUDE_CODE_MAX_RETRIES"] == "0"
    assert cli.timeout_s == 180.0 and cli.cli_max_retries == 3


# ---------------------------------------------------------------------------
# Настоящий subprocess: заглушка-исполняемый файл вместо claude
# ---------------------------------------------------------------------------

STUB_CLAUDE = r'''#!/usr/bin/env python3
"""Заглушка `claude -p --output-format json`: читает промпт из stdin, отвечает по его содержимому."""
import json, os, re, sys
argv = sys.argv[1:]
prompt = sys.stdin.read()
system = argv[argv.index("--system-prompt") + 1] if "--system-prompt" in argv else ""
assert "-p" in argv and argv[argv.index("--output-format") + 1] == "json", argv
assert argv[-2:] == ["--tools", ""], argv  # пустой аргумент должен дойти до процесса
if '"three_things"' in prompt:
    mine = [m.group(1) for m in re.finditer(r"^\[\d\d:\d\d\] (?!СОБЕСЕДНИК)(.+)$", prompt, re.M)]
    quotes = [mine[1], "выдуманная цитата", mine[5]]  # 2 дословных из 3 → движок попросит повтор
    if "ПОВТОР" in prompt:
        quotes = [mine[1], mine[2], mine[5], mine[6]]
    body = {
        "meeting_type": {"type": "pitch", "confidence": 0.8, "reason": "продукт, рынок, инвесторы"},
        "structure": {"kept": False, "comment": "нет следующего шага"},
        "questions": [{"t": 38, "asked": "Как у вас с юнит-экономикой?", "answered": "off_topic", "comment": "ушёл в рынок"}],
        "jargon": [],
        "three_things": [{"title": f"Правка {i}", "why": "важно", "quote": q, "instead": "скажи так", "metric": None} for i, q in enumerate(quotes)],
    }
elif '"agreements"' in prompt:
    body = {"summary": "### О чём\n- продукт (" + str(len(prompt)) + " символов промпта, кодировка: " + os.environ.get("STUB_MARK", "?") + ")", "agreements": []}
elif '"checklist"' in prompt:
    body = {"checklist": [f"Пункт {i}" for i in range(6)], "likely_questions": [{"question": f"Вопрос {i}?", "why": "w", "how_to_prepare": "h"} for i in range(3)]}
elif '"insights"' in prompt:
    body = {"insights": [], "weekly_summary": "сводка", "exercises": []}
else:
    body = {"ok": True}
text = "Вот ответ:\n```json\n" + json.dumps(body, ensure_ascii=False) + "\n```"
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": text, "system_len": len(system)}, ensure_ascii=False))
'''


@pytest.fixture()
def stub_claude(tmp_path: Any) -> str:
    path = tmp_path / "claude"
    path.write_text(STUB_CLAUDE, encoding="utf-8")
    path.chmod(0o755)
    return str(path)


def test_real_subprocess_with_stub_binary(stub_claude: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STUB_MARK", "utf-8 ✓")
    client = LlmClient("claude_cli", cli_path=stub_claude)
    assert client.available() and client.ping(timeout_s=30)
    report = make_report()
    meaning = analyze_meaning(report, client)
    assert meaning is not None and client.calls == 4  # ping + meaning + повтор + конспект
    assert len(meaning["three_things"]) == 3 and meaning["dropped_things"] == 1
    assert all(find_quote(report["transcript"]["words"], t["quote"]) is not None for t in meaning["three_things"])
    assert meaning["questions"][0]["t"] == 36.5 and meaning["questions"][0]["answered"] == "off_topic"
    assert "utf-8 ✓" in meaning["summary"]
    assert json.loads(client.last_raw or "{}")["system_len"] > 1000  # системный промпт дошёл через --system-prompt
    assert prepare_meeting("питч", "pitch", client, strict=True)["checklist"] == [f"Пункт {i}" for i in range(6)]
    assert analyze_patterns(_reports(), client, TASKS, strict=True)["weekly_summary"] == "сводка"


# ---------------------------------------------------------------------------
# anthropic_api
# ---------------------------------------------------------------------------


class FakeMessages:
    def __init__(self, *responses: Any) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def parse(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        r = self.responses.pop(0)
        if isinstance(r, BaseException):
            raise r
        return r


def _api_client(*responses: Any) -> tuple[LlmClient, FakeMessages]:
    client = LlmClient("anthropic_api", api_key="sk-test")
    messages = FakeMessages(*responses)
    client._api_client = SimpleNamespace(messages=messages)
    return client, messages


def test_api_parse_uses_parsed_output_without_thinking() -> None:
    client, messages = _api_client(SimpleNamespace(parsed_output=Pong(answer="api", n=3), content=[]))
    out = client.complete_json("СИСТЕМА", "ЗАПРОС", Pong)
    assert out == Pong(answer="api", n=3)
    kwargs = messages.calls[0]
    assert kwargs["model"] == "claude-opus-5" and kwargs["max_tokens"] == 16000
    assert kwargs["system"] == "СИСТЕМА" and kwargs["messages"] == [{"role": "user", "content": "ЗАПРОС"}]
    assert kwargs["output_format"] is Pong and "thinking" not in kwargs
    assert client.available() is True and client.describe() == {"backend": "anthropic_api", "model": "claude-opus-5"}


def test_api_falls_back_to_text_and_retries_on_validation_error() -> None:
    bad = SimpleNamespace(parsed_output=None, content=[SimpleNamespace(type="text", text="не json")])
    good = SimpleNamespace(parsed_output=None, content=[SimpleNamespace(type="text", text='```json\n{"answer": "текст", "n": 9}\n```')])
    client, messages = _api_client(bad, good)
    assert client.complete_json("s", "u", Pong).n == 9
    assert len(messages.calls) == 2 and "Ответь строго JSON по схеме" in messages.calls[1]["messages"][0]["content"]


def test_api_errors_wrapped() -> None:
    client, _ = _api_client(RuntimeError("overloaded"))
    with pytest.raises(LlmError, match="overloaded"):
        client.complete_json("s", "u", Pong)
    client, _ = _api_client(
        SimpleNamespace(parsed_output=None, content=[SimpleNamespace(type="text", text="x")]),
        SimpleNamespace(parsed_output=None, content=[SimpleNamespace(type="text", text="y")]),
    )
    with pytest.raises(LlmParseError):
        client.complete_json("s", "u", Pong)


def test_api_unavailable_without_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    client = LlmClient("anthropic_api")
    assert client.available() is False
    with pytest.raises(LlmUnavailableError):
        client.complete_json("s", "u", Pong)


# ---------------------------------------------------------------------------
# none / detect_backend / разбор JSON
# ---------------------------------------------------------------------------


def test_none_backend() -> None:
    client = LlmClient("none", model="")
    assert client.available() is False and client.describe() == {"backend": "none", "model": "claude-opus-5"}
    with pytest.raises(LlmUnavailableError):
        client.complete_json("s", "u", Pong)
    with pytest.raises(ValueError):
        LlmClient("gpt")


def test_detect_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(L, "find_cli", lambda cli_path=None: None)
    assert detect_backend(None) == "none"
    assert detect_backend("claude_cli") == "none"
    monkeypatch.setattr(L, "find_cli", lambda cli_path=None: "/usr/local/bin/claude")
    assert detect_backend(None) == "claude_cli"
    assert detect_backend("anthropic_api") == "claude_cli"  # ключа нет → следующий доступный
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-x")
    assert detect_backend(None) == "anthropic_api"
    assert detect_backend("claude_cli") == "claude_cli"
    assert detect_backend("none") == "none"
    assert detect_backend(None, api_key="sk-y") == "anthropic_api"


def test_is_available_for_doctor(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(L, "find_cli", lambda cli_path=None: None)
    assert L.is_available("none") == (True, "LLM выключен")
    assert L.is_available("claude_cli") == (False, "claude CLI не найден в PATH")
    assert L.is_available("anthropic_api")[0] is False
    assert L.is_available("gpt")[0] is False
    monkeypatch.setattr(L, "find_cli", lambda cli_path=None: "/opt/homebrew/bin/claude")
    ok, msg = L.is_available("claude_cli")
    assert ok and msg == "claude CLI: /opt/homebrew/bin/claude, модель claude-opus-5"
    monkeypatch.setattr(L.subprocess, "run", FakeRun((1, _envelope("Not logged in", is_error=True), "")))
    ok, msg = L.is_available("claude_cli", ping=True)
    assert not ok and "claude login" in msg
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-x")
    assert L.is_available("anthropic_api") == (True, "Anthropic API: ключ задан, модель claude-opus-5")


def test_extract_json_block() -> None:
    assert extract_json_block('текст {"a": {"b": 1}} хвост') == '{"a": {"b": 1}}'
    assert extract_json_block('```json\n{"a": 1}\n```') == '{"a": 1}'
    with pytest.raises(ValueError):
        extract_json_block("нет объекта")
    with pytest.raises(ValueError):
        extract_json_block("")


def test_render_prompt_detects_missing_placeholder() -> None:
    assert L.render_prompt("a {{x}} b", x=1) == "a 1 b"
    with pytest.raises(ValueError):
        L.render_prompt("a {{x}} {{y}}", x=1)


# ---------------------------------------------------------------------------
# prepare / patterns с подменённым клиентом
# ---------------------------------------------------------------------------


class ScriptedClient(LlmClient):
    def __init__(self, response: Any, backend: str = "anthropic_api") -> None:
        super().__init__(backend, model="fake", api_key="sk-fake")
        self.response = response
        self.prompts: list[tuple[str, str, type]] = []

    def complete_json(self, system: str, user: str, schema_model: type) -> Any:
        self.calls += 1
        self.prompts.append((system, user, schema_model))
        if isinstance(self.response, Exception):
            raise self.response
        return schema_model.model_validate(self.response)


TASKS = [
    {"id": "elevator_60", "title": "60 секунд без пауз", "instruction": "…", "duration_sec": 60, "targets_metric": "layer1.filled_pauses_per_min", "meeting_type": "training"},
    {"id": "slow_120", "title": "Темп 100–120", "instruction": "…", "duration_sec": 120, "targets_metric": "layer1.wpm", "meeting_type": "training"},
    {"id": "pitch_range_60", "title": "Интонация", "instruction": "…", "duration_sec": 60, "targets_metric": "layer2.pitch_range_st", "meeting_type": "training"},
]


def test_prepare_with_model_pads_and_validates() -> None:
    client = ScriptedClient({
        "checklist": ["Выписать CAC и LTV", "Слайд с конкурентами", "Выписать CAC и LTV"],
        "likely_questions": [{"question": "Какая юнит-экономика?", "why": "деньги", "how_to_prepare": "числа"}],
    })
    res = prepare_meeting("питч сервиса анализа речи на созвонах", "pitch", client)
    assert res["backend"] == "anthropic_api" and res["meeting_type"] == "pitch"
    assert res["checklist"][:2] == ["Выписать CAC и LTV", "Слайд с конкурентами"] and 5 <= len(res["checklist"]) <= 8
    assert len(res["likely_questions"]) == 3 and res["likely_questions"][0]["question"] == "Какая юнит-экономика?"
    assert client.prompts[0][2] is PrepLlmOutput and "юнит-экономику" in client.prompts[0][1]
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.validate(res, load_schema("prep.schema.json"))


def test_prepare_fallbacks() -> None:
    none = prepare_meeting("демо CRM", "demo", LlmClient("none"))
    assert none["backend"] == "none" and 5 <= len(none["checklist"]) <= 8 and len(none["likely_questions"]) == 3
    assert prepare_meeting("x", "странный тип", LlmClient("none"))["meeting_type"] == "other"
    failing = ScriptedClient(LlmError("сеть"))
    assert prepare_meeting("демо CRM", "demo", failing)["backend"] == "none"
    with pytest.raises(LlmError):
        prepare_meeting("демо CRM", "demo", failing, strict=True)
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.validate(none, load_schema("prep.schema.json"))


def _reports() -> list[dict[str, Any]]:
    out = []
    for k, (rid, date, wpm_first) in enumerate([
        ("aaaaaaaa-0000-4000-8000-000000000001", "2026-09-01T10:00:00+03:00", 160.0),
        ("aaaaaaaa-0000-4000-8000-000000000002", "2026-09-03T10:00:00+03:00", 158.0),
        ("aaaaaaaa-0000-4000-8000-000000000003", "2026-09-05T10:00:00+03:00", 150.0),
    ]):
        r = make_report(meeting={"id": rid, "started_at": date, "type": "pitch", "duration_sec": 400.0})
        r["timeline"]["wpm"] = [{"t": 7.5 + 5 * i, "v": wpm_first if 7.5 + 5 * i < 180 else 120.0} for i in range(70)]
        r["score"]["overall"] = 55 + 5 * k
        out.append(r)
    return out[::-1]  # намеренно не по порядку


def test_compress_report_and_observations() -> None:
    items = [compress_report(r) for r in _reports()]
    items.sort(key=lambda it: it["started_at"])
    assert items[0]["wpm_first_3min"] == 160.0 and items[0]["wpm_rest"] == 120.0
    assert items[0]["metrics"]["layer1.wpm"] == {"value": 148.0, "status": "bad", "ref": [110, 140]}
    obs = compute_observations(items)
    assert any("Темп первых 3 минут выше остального" in o and "3 из 3" in o and "3 последних подряд" in o for o in obs)
    assert any("заполненные паузы (layer1.filled_pauses_per_min) вне ориентира в 3 из 3" in o for o in obs)
    assert any("Оценка: первая встреча периода 55, последняя 65" in o for o in obs)


def test_patterns_with_model_validates_ids_and_tasks() -> None:
    client = ScriptedClient({
        "insights": [
            {"title": "Третий созвон подряд ты частишь в первые две минуты", "detail": "160→120", "metric": "wpm",
             "meeting_ids": ["aaaaaaaa-0000-4000-8000-000000000001", "чужой-id"]},
            {"title": "", "detail": "пустой — выкинуть", "metric": None, "meeting_ids": []},
        ],
        "weekly_summary": "**3 встречи.**",
        "exercises": [
            {"title": "Медленный старт", "instruction": "2 минуты в темпе 110", "duration_min": 2, "targets_metric": "layer1.wpm", "training_task_id": "нет_такого"},
            {"title": "Без э-э", "instruction": "60 с", "duration_min": 99, "targets_metric": "layer1.filled_pauses_per_min", "training_task_id": "elevator_60"},
        ],
    })
    res = analyze_patterns(_reports(), client, TASKS)
    assert client.prompts[0][2] is PatternsLlmOutput and "Наблюдения движка" in client.prompts[0][1]
    assert res["backend"] == "anthropic_api" and res["schema_version"] == 1
    assert res["meetings_used"] == [f"aaaaaaaa-0000-4000-8000-00000000000{i}" for i in (1, 2, 3)]  # по дате
    assert len(res["insights"]) == 1
    assert res["insights"][0]["metric"] == "layer1.wpm" and res["insights"][0]["meeting_ids"] == ["aaaaaaaa-0000-4000-8000-000000000001"]
    assert res["exercises"][0]["training_task_id"] == "slow_120"  # подобрано по метрике
    assert res["exercises"][1]["training_task_id"] == "elevator_60" and res["exercises"][1]["duration_min"] == 30.0
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.validate(res, load_schema("patterns.schema.json"))


def test_patterns_fallbacks() -> None:
    res = analyze_patterns(_reports(), LlmClient("none"), TASKS)
    assert res["backend"] == "none" and res["insights"] == [] and "3 встреч" in res["weekly_summary"]
    ids = [e["training_task_id"] for e in res["exercises"]]
    assert ids[0] == "elevator_60" and 2 <= len(ids) <= 4  # худшая метрика — заполненные паузы
    failing = ScriptedClient(LlmError("таймаут"))
    assert analyze_patterns(_reports(), failing, TASKS)["backend"] == "none"
    with pytest.raises(LlmError):
        analyze_patterns(_reports(), failing, TASKS, strict=True)
    empty = analyze_patterns([], failing, TASKS)
    assert empty["meetings_used"] == [] and failing.calls == 2  # без отчётов модель не вызывается
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.validate(res, load_schema("patterns.schema.json"))
    jsonschema.validate(empty, load_schema("patterns.schema.json"))
