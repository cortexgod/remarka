"""Стык cli → analyze → meaning → llm(claude_cli) через настоящий subprocess.

Вместо `claude` — заглушка-исполняемый файл (REMARKA_CLAUDE_CLI), которая читает промпт из stdin
и цитирует транскрипт дословно. Проверяем, что отчёт с фикстур получает непустой `meaning`
с тремя найденными цитатами, конспектом и порядком стадий по §3.1.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import FIXTURES, ROOT, fixtures_present

from remarka_engine import report

pytestmark = pytest.mark.slow

STAGES = ["load", "vad", "asr", "align", "fillers", "prosody", "metrics", "meaning", "summary", "write"]

STUB_CLAUDE = r'''#!/usr/bin/env python3
import json, re, sys
argv = sys.argv[1:]
prompt = sys.stdin.read()
assert "-p" in argv and argv[argv.index("--output-format") + 1] == "json", argv
assert argv[-2:] == ["--tools", ""], argv
mine = [m.group(1) for m in re.finditer(r"^\[\d\d:\d\d\] (?!СОБЕСЕДНИК)(.+)$", prompt, re.M)]
other = [m.group(1) for m in re.finditer(r"^\[\d\d:\d\d\] СОБЕСЕДНИК: (.+)$", prompt, re.M)]
if '"three_things"' in prompt:
    long = [s for s in mine if len(s.split()) >= 4]
    quotes = (long[:3] if len(long) >= 3 else mine[:3])
    body = {
        "meeting_type": {"type": "pitch", "confidence": 0.8, "reason": "продукт, рынок, подписка"},
        "structure": {"kept": False, "comment": "нет призыва к действию"},
        "questions": [{"t": 999, "asked": other[0] if other else "?", "answered": "not_answered", "comment": "ответа нет"}],
        "jargon": [],
        "three_things": [{"title": "Правка %d" % (i + 1), "why": "заполненная пауза", "quote": q, "instead": "короче", "metric": "layer1.filled_pauses_per_min"} for i, q in enumerate(quotes)],
    }
elif '"agreements"' in prompt:
    body = {"summary": "### О чём\n- питч", "agreements": [{"text": "прислать юнит-экономику", "owner": "я", "due": None}]}
else:
    body = {"ok": True}
text = "```json\n" + json.dumps(body, ensure_ascii=False) + "\n```"
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": text}, ensure_ascii=False))
'''


@pytest.fixture(scope="module")
def stub_report(tmp_path_factory) -> tuple[dict, list[dict]]:
    if not fixtures_present():
        pytest.skip("нет фикстур tests/fixtures/me.wav, other.wav")
    tmp = tmp_path_factory.mktemp("cli_llm_stub")
    stub = tmp / "claude"
    stub.write_text(STUB_CLAUDE, encoding="utf-8")
    stub.chmod(0o755)
    out = tmp / "r.json"
    env = dict(**__import__("os").environ, REMARKA_CLAUDE_CLI=str(stub))
    proc = subprocess.run(
        [sys.executable, "-m", "remarka_engine", "analyze", "--mic", str(FIXTURES / "me.wav"), "--system", str(FIXTURES / "other.wav"), "--out", str(out), "--asr-model", "small", "--llm", "claude_cli"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=900,
        env=env,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    lines = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    assert lines[-1]["event"] == "done"
    return json.loads(Path(out).read_text(encoding="utf-8")), lines


def test_meaning_from_cli_backend(stub_report):
    r, _ = stub_report
    assert report.validate(r) == []
    m = r["meaning"]
    assert m is not None, r["engine"]["warnings"]
    assert m["backend"] == "claude_cli"
    assert len(m["three_things"]) == 3 and m["dropped_things"] == 0
    words = r["transcript"]["words"]
    for thing in m["three_things"]:
        # цитата дословная → t = start первого слова совпадения
        first = next(w for w in words if abs(w["start"] - thing["t"]) < 1e-6)
        assert thing["quote"].lower().startswith(first["text"].lower()[:2])
    # вопрос собеседника заякорен по тексту реплики системной дорожки, а не по t модели (999)
    q = m["questions"][0]
    other = r["transcript"]["other"]
    assert any(abs(o["start"] - q["t"]) < 1e-6 for o in other), (q, other)
    assert m["summary"].startswith("### О чём") and m["agreements"][0]["owner"] == "я"
    # тип от модели применён: pitch → ориентир темпа 110–140
    assert r["meeting"]["type_source"] == "llm" and r["meeting"]["type"] == "pitch"
    assert (r["metrics"]["layer1"]["wpm"]["ref_low"], r["metrics"]["layer1"]["wpm"]["ref_high"]) == (110, 140)


def test_stage_order_with_llm(stub_report):
    _, lines = stub_report
    progress = [ev for ev in lines if ev["event"] == "progress"]
    idx = [STAGES.index(ev["stage"]) for ev in progress]
    assert idx == sorted(idx), [ev["stage"] for ev in progress]
    pcts = [ev["pct"] for ev in progress]
    assert pcts == sorted(pcts) and pcts[-1] == 100
    assert any(ev["stage"] == "summary" for ev in progress)
