"""Помощники тестов слоя смысла: синтетический, валидный по схеме отчёт.

Транскрипт повторяет содержание фикстур ``tests/fixtures/me.wav`` (я: «Здравствуйте,
коллеги. Э-э, сегодня я хочу рассказать про наш продукт…» с «э-э», «м-м», «как бы»,
«типа», «на самом деле», «вот», «собственно» и паузами) и ``other.wav`` (собеседник:
два вопроса — про юнит-экономику и про отличие от конкурентов). Тестов в файле нет.
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]  # корень репозитория remarka/
DOCS = ROOT / "docs"

_FILLER_RE = re.compile(r"^(э+|эм+|м+|мм+|а+|аа+|ээ+|хм+|гм+|ым+)$")
_CRUTCH_UNI = {"типа", "вот", "собственно", "ну", "значит"}
_CRUTCH_MULTI = [("как", "бы"), ("на", "самом", "деле")]

# (start, end, text) — мои предложения; паузы между ними ≥ 0,8 с — структурные.
MY_SENTENCES: list[tuple[float, float, str]] = [
    (0.0, 4.6, "Здравствуйте, коллеги."),
    (5.2, 10.4, "Э-э, сегодня я хочу рассказать про наш продукт."),
    (11.0, 16.8, "М-м, это, как бы, сервис анализа речи на созвонах."),
    (17.4, 24.0, "Он, типа, слушает, как вы говорите в Зуме, и после встречи, э-э, показывает разбор."),
    (24.8, 30.2, "На самом деле, вот, главная метрика — заполненные паузы и темп речи."),
    (31.0, 36.0, "Собственно, мы считаем всё локально, аудио никуда не уходит."),
    (41.0, 49.5, "Э-э, ну, рынок очень большой, м-м, миллионы людей проводят созвоны каждый день, и, как бы, мы хотим занять эту нишу."),
    (56.0, 63.0, "Мы, типа, работаем прямо рядом с Зумом на десктопе, а они в браузере, и у нас русский язык первым."),
]

# (start, end, text, is_question) — реплики собеседника с системной дорожки.
OTHER_UTTERANCES: list[tuple[float, float, str, bool]] = [
    (36.5, 40.5, "Скажите, а как у вас с юнит-экономикой? Сколько стоит один пользователь и сколько он приносит?", True),
    (50.0, 55.0, "А чем вы отличаетесь от конкурентов вроде Yoodli?", True),
]

DURATION = 64.0
MEETING_ID = "11111111-1111-4111-8111-111111111111"


def norm(token: str) -> str:
    t = token.lower().replace("ё", "е")
    t = re.sub(r"[^\w-]+", "", t, flags=re.UNICODE).replace("_", "")
    return t.strip("-")


def _mv(value: Any, unit: str, ref_low: Any, ref_high: Any, better: str, status: str) -> dict[str, Any]:
    return {"value": value, "unit": unit, "ref_low": ref_low, "ref_high": ref_high, "better": better, "status": status}


def _build_words_and_sentences() -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    words: list[dict[str, Any]] = []
    sentences: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    prev_end: float | None = None
    for s_i, (start, end, text) in enumerate(MY_SENTENCES):
        tokens = text.split()
        n = len(tokens)
        slot = (end - start) / n
        word_from = len(words)
        norms = [norm(t) for t in tokens]
        kinds = ["word"] * n
        labels: dict[int, str] = {}
        for k, nrm in enumerate(norms):
            if _FILLER_RE.match(nrm.replace("-", "")):
                kinds[k] = "filler"
        for k in range(n):
            if kinds[k] != "word":
                continue
            for multi in _CRUTCH_MULTI:
                if tuple(norms[k : k + len(multi)]) == multi:
                    kinds[k] = "crutch"
                    labels[k] = " ".join(multi)
                    break
            if kinds[k] == "word" and norms[k] in _CRUTCH_UNI:
                kinds[k] = "crutch"
                labels[k] = norms[k]
        for k, tok in enumerate(tokens):
            w_start = round(start + k * slot, 3)
            w_end = round(w_start + slot * 0.85, 3)
            i = len(words)
            words.append({
                "i": i, "start": w_start, "end": w_end, "text": tok, "norm": norms[k],
                "prob": 0.9, "kind": kinds[k], "sentence_i": s_i,
            })
            if kinds[k] == "filler":
                events.append({"t": w_start, "end": w_end, "kind": "filled_pause", "label": norms[k],
                               "source": "asr", "word_i": i, "sentence_i": s_i, "value": None})
            elif kinds[k] == "crutch":
                events.append({"t": w_start, "end": w_end, "kind": "crutch", "label": labels[k],
                               "source": "asr", "word_i": i, "sentence_i": s_i, "value": None})
        word_to = len(words) - 1
        sentences.append({
            "i": s_i, "start": start, "end": end, "text": text, "word_from": word_from, "word_to": word_to,
            "n_words": sum(1 for k in kinds if k != "filler"), "is_question": text.endswith("?"),
        })
        if prev_end is not None and start - prev_end >= 0.8:
            gap = round(start - prev_end, 2)
            events.append({"t": prev_end, "end": start, "kind": "structural_pause", "label": f"{gap:.1f} с".replace(".", ","),
                           "source": "signal", "word_i": None, "sentence_i": s_i, "value": gap})
        prev_end = end
    return words, sentences, events


def make_report(**overrides: Any) -> dict[str, Any]:
    """Валидный по docs/report.schema.json отчёт на синтетическом транскрипте фикстур."""
    words, sentences, events = _build_words_and_sentences()
    other = [{"start": s, "end": e, "text": t, "is_question": q} for s, e, t, q in OTHER_UTTERANCES]
    for u in other:
        events.append({"t": u["start"], "end": u["end"], "kind": "question_from_other", "label": u["text"][:40],
                       "source": "asr", "word_i": None, "sentence_i": None, "value": None})
    events.append({"t": 42.0, "end": 42.5, "kind": "hesitation_pause", "label": "0,5 с", "source": "signal",
                   "word_i": None, "sentence_i": 6, "value": 0.5})
    events.append({"t": 0.0, "end": 15.0, "kind": "fast_burst", "label": "155 сл/мин", "source": "signal",
                   "word_i": None, "sentence_i": None, "value": 155.0})
    events.sort(key=lambda e: e["t"])

    wpm_series = [155, 152, 150, 148, 145, 140, 138, 136, 135, 133]
    timeline = {
        "window_sec": 15, "step_sec": 5,
        "wpm": [{"t": 7.5 + 5 * k, "v": float(v)} for k, v in enumerate(wpm_series)],
        "articulation_wpm": [{"t": 7.5 + 5 * k, "v": float(v + 17)} for k, v in enumerate(wpm_series)],
        "pitch_semitones": [{"t": 7.5 + 5 * k, "v": round(0.4 * ((-1) ** k), 2)} for k in range(len(wpm_series))],
        "loudness_db": [{"t": 7.5 + 5 * k, "v": 62.0 - 0.3 * k} for k in range(len(wpm_series))],
        "other_speaking": [{"start": u["start"], "end": u["end"]} for u in other],
    }
    layer1 = {
        "wpm": _mv(148.0, "сл/мин", 110, 140, "inside", "bad"),
        "articulation_wpm": _mv(165.0, "сл/мин", 130, 170, "inside", "good"),
        "filled_pauses_total": _mv(6, "", None, None, "lower", "na"),
        "filled_pauses_per_min": _mv(5.6, "в мин", None, 2, "lower", "bad"),
        "crutch_words_total": _mv(8, "", None, None, "lower", "na"),
        "crutch_words_per_min": _mv(7.5, "в мин", None, 2, "lower", "bad"),
        "crutch_top": [{"word": "как бы", "count": 2}, {"word": "типа", "count": 2}, {"word": "на самом деле", "count": 1},
                       {"word": "вот", "count": 1}, {"word": "собственно", "count": 1}, {"word": "ну", "count": 1}],
        "structural_pauses_per_min": _mv(4.7, "в мин", 3, 6, "inside", "good"),
        "hesitation_pauses_per_min": _mv(1.0, "в мин", None, 4, "lower", "good"),
        "talk_ratio": _mv(0.83, "", 0.7, 0.8, "inside", "warn"),
        "mean_sentence_len": _mv(9.5, "слов", None, 22, "lower", "good"),
        "long_sentences_share": _mv(0.0, "", None, 0.2, "lower", "good"),
        "mtld": _mv(None, "", 60, None, "higher", "na"),
        "interruptions_by_me": _mv(0, "", None, 2, "lower", "good"),
        "interruptions_by_other": _mv(0, "", None, None, "lower", "na"),
        "my_speech_sec": _mv(47.0, "с", None, None, "inside", "na"),
        "other_speech_sec": _mv(9.0, "с", None, None, "inside", "na"),
        "words_total": _mv(len([w for w in words if w["kind"] != "filler"]), "слов", None, None, "inside", "na"),
    }
    layer2 = {
        "pitch_median_hz": _mv(190.0, "Гц", None, None, "inside", "na"),
        "pitch_range_st": _mv(3.1, "пт", 4, None, "higher", "bad"),
        "phrase_final_decay_db": _mv(7.5, "дБ", None, 6, "lower", "warn"),
        "rising_statements_share": _mv(0.1, "", None, 0.15, "lower", "good"),
        "jitter_pct": _mv(1.2, "%", None, None, "lower", "na"),
        "shimmer_pct": _mv(4.0, "%", None, None, "lower", "na"),
        "start_jitter_ratio": _mv(None, "", None, None, "lower", "na"),
        "loudness_drift_db": _mv(-1.5, "дБ", -3, None, "higher", "good"),
        "loudness_mean_db": _mv(62.0, "дБ", None, None, "inside", "na"),
    }
    score = {
        "overall": 61,
        "components": [
            {"metric": "layer1.filled_pauses_per_min", "weight": 20, "penalty": 1.0},
            {"metric": "layer1.wpm", "weight": 15, "penalty": 0.27},
            {"metric": "layer2.pitch_range_st", "weight": 15, "penalty": 0.22},
            {"metric": "layer1.crutch_words_per_min", "weight": 10, "penalty": 1.0},
            {"metric": "layer1.hesitation_pauses_per_min", "weight": 10, "penalty": 0.0},
            {"metric": "layer1.talk_ratio", "weight": 10, "penalty": 0.3},
            {"metric": "layer2.phrase_final_decay_db", "weight": 5, "penalty": 0.25},
            {"metric": "layer2.rising_statements_share", "weight": 5, "penalty": 0.0},
            {"metric": "layer1.long_sentences_share", "weight": 5, "penalty": 0.0},
            {"metric": "layer1.interruptions_by_me", "weight": 5, "penalty": 0.0},
        ],
        "basis": "reference",
    }
    report: dict[str, Any] = {
        "schema_version": 1,
        "meeting": {
            "id": MEETING_ID, "started_at": "2026-09-07T10:00:00+03:00", "duration_sec": DURATION,
            "type": "other", "type_confidence": 0.0, "type_source": "default", "title": "Питч продукта",
            "has_system_track": True, "language": "ru", "training_task_id": None,
        },
        "tracks": {
            "mic": {"path": str(ROOT / "engine/tests/fixtures/me.wav"), "sample_rate": 16000, "duration_sec": DURATION},
            "system": {"path": str(ROOT / "engine/tests/fixtures/other.wav"), "sample_rate": 16000, "duration_sec": DURATION},
        },
        "segments": {
            "mic_speech": [{"start": s, "end": e} for s, e, _ in MY_SENTENCES],
            "system_speech": [{"start": u["start"], "end": u["end"]} for u in other],
        },
        "transcript": {"words": words, "sentences": sentences, "other": other},
        "events": events,
        "timeline": timeline,
        "metrics": {"layer1": layer1, "layer2": layer2},
        "score": score,
        "baseline": {"status": "calibrating", "meetings_used": 1, "meetings_needed": 3, "deltas": []},
        "meaning": None,
        "engine": {"version": "0.1.0", "asr_model": "small", "asr_backend": "faster-whisper", "processing_sec": 12.3, "warnings": []},
    }
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(report.get(key), dict):
            report[key] = {**report[key], **value}
        else:
            report[key] = value
    return copy.deepcopy(report)


def word_by_text(report: dict[str, Any], text: str, nth: int = 0) -> dict[str, Any]:
    """Слово транскрипта по тексту (nth-е вхождение)."""
    hits = [w for w in report["transcript"]["words"] if w["text"] == text]
    return hits[nth]


def load_schema(name: str) -> dict[str, Any]:
    return json.loads((DOCS / name).read_text(encoding="utf-8"))


def definition_schema(schema: dict[str, Any], definition: str) -> dict[str, Any]:
    """Схема одного definition из report.schema.json как самостоятельная."""
    return {"$schema": schema.get("$schema", "http://json-schema.org/draft-07/schema#"),
            "$ref": f"#/definitions/{definition}", "definitions": schema["definitions"]}
