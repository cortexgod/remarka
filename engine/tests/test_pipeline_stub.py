"""Полный конвейер без модели: VAD/ASR подменены, слой смысла — заглушкой модуля meaning.

Проверяет сборку отчёта, схему, интеграцию с meaning (тип встречи от LLM → пересчёт статусов)
и деградацию при ошибке слоя смысла.
"""

from __future__ import annotations

import sys
import types

import numpy as np
import soundfile as sf
from conftest import SR

from remarka_engine import analyze as analyze_mod
from remarka_engine import report
from remarka_engine.analyze import AnalyzeOptions, run_analyze
from remarka_engine.model import RawWord
from remarka_engine.protocol import NullEmitter
from remarka_engine.spans import Span

TEXT = "Здравствуйте, коллеги. Э-э, сегодня я, как бы, хочу рассказать про наш продукт. Вот. Типа, рынок здесь очень большой?"


def _voice(dur: float, f0: float = 130.0) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    x = np.zeros_like(t)
    for h in range(1, 12):
        x += np.sin(2 * np.pi * f0 * h * t + 0.3 * h) / h
    x *= 1 + 0.08 * np.sin(2 * np.pi * 0.7 * t)
    return (0.25 * x / 3).astype(np.float32)


def _raw_words() -> list[RawWord]:
    out = []
    t = 0.2
    for tok in TEXT.split():
        out.append(RawWord(start=t, end=t + 0.3, text=tok, prob=0.9))
        t += 0.3 + (0.9 if tok.endswith((".", "?")) else 0.15)
    return out


def _patch(monkeypatch, meaning_fn=None, llm_client=True):
    words = _raw_words()
    end = words[-1].end + 0.2
    monkeypatch.setattr(analyze_mod.vad, "speech_spans", lambda samples, sr: [Span(0.1, end)] if samples.size > SR else [])
    monkeypatch.setattr(analyze_mod.asr, "load_model", lambda name, compute_type, device=None: object())
    monkeypatch.setattr(analyze_mod.asr, "is_model_cached", lambda name: True)

    def fake_transcribe(model, samples, *, language, initial_prompt, speech_spans, on_progress, beam_size=5):
        on_progress(end)
        return (words if initial_prompt else []), []

    monkeypatch.setattr(analyze_mod.asr, "transcribe", fake_transcribe)
    if llm_client:
        llm = types.ModuleType("remarka_engine.llm")

        class LlmClient:  # noqa: D401
            def __init__(self, backend: str, model: str = "m", **kw):
                self.backend, self.model = backend, model

        llm.LlmClient = LlmClient
        monkeypatch.setitem(sys.modules, "remarka_engine.llm", llm)
    if meaning_fn is not None:
        mod = types.ModuleType("remarka_engine.meaning")
        mod.analyze_meaning = meaning_fn
        monkeypatch.setitem(sys.modules, "remarka_engine.meaning", mod)
    return end


def _wav(tmp_path, dur: float):
    """Голос только на отрезках слов, между ними тишина — иначе детектор честно найдёт
    «заполненные паузы» в ровном синтетическом тоне между предложениями."""
    p = tmp_path / "voice.wav"
    sig = np.zeros(int(dur * SR), dtype=np.float32)
    voice = _voice(dur)
    for w in _raw_words():
        a, b = int(w.start * SR), int(w.end * SR)
        sig[a:b] = voice[a:b]
    sf.write(str(p), sig, SR)
    return p


def test_pipeline_without_llm(tmp_path, monkeypatch):
    end = _patch(monkeypatch)
    p = _wav(tmp_path, end + 1)
    em = NullEmitter()
    doc = run_analyze(AnalyzeOptions(mic=str(p), out=str(tmp_path / "r.json"), llm="none"), em)
    assert report.validate(doc) == []
    l1 = doc["metrics"]["layer1"]
    assert l1["words_total"]["value"] == 17  # 18 токенов минус филлер «Э-э»
    assert l1["filled_pauses_total"]["value"] == 1
    assert {c["word"] for c in l1["crutch_top"]} == {"как бы", "вот", "типа"}
    kinds = {e["kind"] for e in doc["events"]}
    assert {"filled_pause", "crutch", "structural_pause"} <= kinds
    assert doc["transcript"]["sentences"][-1]["is_question"] is True
    assert doc["meaning"] is None and doc["meeting"]["type"] == "other"
    assert doc["metrics"]["layer2"]["pitch_range_st"]["value"] is not None
    assert (tmp_path / "r.json").exists()


def test_pipeline_with_meaning_stub_overrides_type(tmp_path, monkeypatch):
    calls = {}

    def fake_meaning(report, client, user_meeting_type=None, progress=None):
        calls["user_type"] = user_meeting_type
        calls["backend"] = client.backend
        progress(40, "думаем")
        progress(90, "конспект")
        return {
            "backend": client.backend,
            "model": client.model,
            "meeting_type": {"type": "pitch", "confidence": 0.8, "reason": "инвестор"},
            "structure": {"kept": True, "comment": "ок"},
            "questions": [],
            "jargon": [],
            "three_things": [],
            "dropped_things": 0,
            "summary": "конспект",
            "agreements": [],
        }

    end = _patch(monkeypatch, meaning_fn=fake_meaning)
    p = _wav(tmp_path, end + 1)
    em = NullEmitter()
    doc = run_analyze(AnalyzeOptions(mic=str(p), out=str(tmp_path / "r.json"), llm="claude_cli", llm_model="m1"), em)
    assert report.validate(doc) == []
    assert calls == {"user_type": None, "backend": "claude_cli"}
    assert doc["meaning"]["summary"] == "конспект"
    assert doc["meeting"]["type"] == "pitch" and doc["meeting"]["type_source"] == "llm" and doc["meeting"]["type_confidence"] == 0.8
    # ориентир wpm для pitch 110–140 → ref_low в отчёте пересчитан под новый тип
    assert doc["metrics"]["layer1"]["wpm"]["ref_low"] == 110
    stages = [(e["stage"], e["pct"]) for e in em.events if e["event"] == "progress"]
    assert any(s == "summary" for s, _ in stages)
    assert [p for _, p in stages] == sorted(p for _, p in stages)


def test_user_type_wins_over_llm(tmp_path, monkeypatch):
    def fake_meaning(report, client, user_meeting_type=None, progress=None):
        assert user_meeting_type == "demo"
        return {
            "backend": "claude_cli",
            "model": "m",
            "meeting_type": {"type": "pitch", "confidence": 0.9, "reason": ""},
            "structure": {"kept": True, "comment": ""},
            "questions": [],
            "jargon": [],
            "three_things": [],
            "dropped_things": 0,
            "summary": "",
            "agreements": [],
        }

    end = _patch(monkeypatch, meaning_fn=fake_meaning)
    p = _wav(tmp_path, end + 1)
    doc = run_analyze(AnalyzeOptions(mic=str(p), out=str(tmp_path / "r.json"), llm="claude_cli", meeting_type="demo"), NullEmitter())
    assert doc["meeting"]["type"] == "demo" and doc["meeting"]["type_source"] == "user"


def test_meaning_failure_degrades_to_none(tmp_path, monkeypatch):
    def broken(report, client, user_meeting_type=None, progress=None):
        raise RuntimeError("claude недоступен")

    end = _patch(monkeypatch, meaning_fn=broken)
    p = _wav(tmp_path, end + 1)
    doc = run_analyze(AnalyzeOptions(mic=str(p), out=str(tmp_path / "r.json"), llm="claude_cli"), NullEmitter())
    assert doc["meaning"] is None
    assert any("claude недоступен" in w for w in doc["engine"]["warnings"])
    assert report.validate(doc) == []


def test_meaning_not_by_schema_is_dropped(tmp_path, monkeypatch):
    def bad(report, client, user_meeting_type=None, progress=None):
        return {"backend": "claude_cli", "model": "m", "summary": "x"}  # нет обязательных полей

    end = _patch(monkeypatch, meaning_fn=bad)
    p = _wav(tmp_path, end + 1)
    doc = run_analyze(AnalyzeOptions(mic=str(p), out=str(tmp_path / "r.json"), llm="claude_cli"), NullEmitter())
    assert doc["meaning"] is None and any("не по схеме" in w for w in doc["engine"]["warnings"])
