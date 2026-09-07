"""Интеграция на фикстурах с реальной моделью small (медленно: ~20 с на M3)."""

import collections
import json
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import FIXTURES, ROOT, fixtures_present

from remarka_engine import report

pytestmark = pytest.mark.slow


@pytest.fixture(scope="module")
def fixture_report(tmp_path_factory) -> dict:
    if not fixtures_present():
        pytest.skip("нет фикстур tests/fixtures/me.wav, other.wav")
    out = tmp_path_factory.mktemp("integration") / "r.json"
    proc = subprocess.run(
        [sys.executable, "-m", "remarka_engine", "analyze", "--mic", str(FIXTURES / "me.wav"), "--system", str(FIXTURES / "other.wav"), "--out", str(out), "--asr-model", "small", "--llm", "none", "--meeting-type", "pitch"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=900,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    lines = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    assert lines[-1]["event"] == "done"
    asr_progress = [ev for ev in lines if ev["event"] == "progress" and ev["stage"] == "asr" and "из" in ev["message"]]
    assert len(asr_progress) >= 2, "прогресс ASR должен идти по сегментам"
    return json.loads(Path(out).read_text(encoding="utf-8"))


def test_report_valid_by_schema(fixture_report):
    assert report.validate(fixture_report) == []


def test_definition_of_done(fixture_report):
    r = fixture_report
    kinds = collections.Counter(e["kind"] for e in r["events"])
    assert kinds["filled_pause"] >= 3
    assert kinds["crutch"] >= 2
    assert kinds["question_from_other"] >= 1
    tr = r["metrics"]["layer1"]["talk_ratio"]["value"]
    assert tr is not None and 0 < tr < 1
    assert r["metrics"]["layer2"]["pitch_range_st"]["value"] > 0
    assert r["metrics"]["layer1"]["wpm"]["value"] > 0
    assert r["metrics"]["layer1"]["words_total"]["value"] >= 40
    assert len(r["transcript"]["other"]) >= 2 and all(o["is_question"] for o in r["transcript"]["other"])


def test_expected_words_and_labels(fixture_report):
    r = fixture_report
    crutch_labels = {e["label"] for e in r["events"] if e["kind"] == "crutch"}
    assert {"как бы", "типа", "на самом деле"} <= crutch_labels
    filler_labels = [e["label"] for e in r["events"] if e["kind"] == "filled_pause"]
    assert "э-э" in filler_labels and "м-м" in filler_labels
    text = " ".join(w["norm"] for w in r["transcript"]["words"])
    assert "субтитр" not in text and "закомолдина" not in " ".join(o["text"].lower() for o in r["transcript"]["other"])
    for w in r["transcript"]["words"]:
        assert w["end"] >= w["start"] and 0 <= w["prob"] <= 1
    assert r["timeline"]["wpm"] and r["timeline"]["pitch_semitones"] and r["timeline"]["loudness_db"]
    assert r["timeline"]["other_speaking"]


def test_performance_budget(fixture_report):
    assert fixture_report["engine"]["processing_sec"] < 60
