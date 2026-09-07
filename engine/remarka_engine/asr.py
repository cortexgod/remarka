"""ASR на faster-whisper: пословные таймкоды, дословность (§3.2–3.3), фильтр галлюцинаций."""

from __future__ import annotations

import os
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from .model import RawWord
from .spans import Span, overlap_duration

# Подталкиваем Whisper к дословной выдаче филлеров (§3.3).
INITIAL_PROMPT = "Э-э, ну, как бы, м-м, я думаю, что, э-э, это, типа, важно."

DEFAULT_MODEL = "large-v3-turbo"
DEFAULT_COMPUTE_TYPE = "int8"
KNOWN_MODELS = ["large-v3-turbo", "large-v3", "medium", "small", "base"]

# Имена моделей → репозитории HF. Для large-v3-turbo faster-whisper 1.2.x сам
# использует mobiuslabsgmbh/faster-whisper-large-v3-turbo; контракт упоминает
# deepdml/faster-whisper-large-v3-turbo-ct2 — оба совместимы, берём встроенное.
_EXTRA_REPOS: dict[str, str] = {}

# Типичные галлюцинации Whisper на тишине/шуме (русские субтитровые хвосты).
HALLUCINATION_PHRASES = (
    "редактор субтитров",
    "субтитры",
    "субтитров",
    "корректор",
    "продолжение следует",
    "спасибо за просмотр",
    "подписывайтесь",
    "dimatorzok",
    "закомолдина",
    "subtitles",
)


def resolve_repo(name: str) -> str:
    if "/" in name or os.path.isdir(name):
        return name
    try:
        from faster_whisper.utils import _MODELS

        if name in _MODELS:
            return _MODELS[name]
    except Exception:  # noqa: BLE001
        pass
    return _EXTRA_REPOS.get(name, name)


def is_model_cached(name: str) -> bool:
    """Есть ли модель в HF-кэше (model.bin в snapshots)."""
    repo = resolve_repo(name)
    if os.path.isdir(repo):
        return os.path.exists(os.path.join(repo, "model.bin"))
    cache = os.environ.get("HF_HUB_CACHE") or os.environ.get("HUGGINGFACE_HUB_CACHE")
    if not cache:
        hf_home = os.environ.get("HF_HOME", os.path.join(Path.home(), ".cache", "huggingface"))
        cache = os.path.join(hf_home, "hub")
    folder = Path(cache) / ("models--" + repo.replace("/", "--")) / "snapshots"
    if not folder.exists():
        return False
    for snap in folder.iterdir():
        if (snap / "model.bin").exists() and (snap / "config.json").exists():
            return True
    return False


def download_model(name: str) -> str:
    from faster_whisper.utils import download_model as _dl

    return _dl(resolve_repo(name))


def default_device() -> str:
    # M-серия: cpu; на Linux/Windows с CUDA — auto (ctranslate2 сам выберет).
    return "cpu" if sys.platform == "darwin" else "auto"


def load_model(name: str, compute_type: str = DEFAULT_COMPUTE_TYPE, device: str | None = None) -> Any:
    from faster_whisper import WhisperModel

    dev = device or default_device()
    try:
        return WhisperModel(resolve_repo(name), device=dev, compute_type=compute_type)
    except Exception:
        if dev != "cpu":
            return WhisperModel(resolve_repo(name), device="cpu", compute_type=compute_type)
        raise


def _merge_tokens(words: list[Any]) -> list[RawWord]:
    """faster-whisper режет «Э-э,» на ' Э' и '-э,': токен без ведущего пробела — продолжение слова."""
    out: list[RawWord] = []
    for w in words:
        text = w.word
        if not text:
            continue
        if out and not text.startswith(" ") and not text[0].isalnum():
            prev = out[-1]
            prev.text += text
            prev.end = max(prev.end, float(w.end))
            prev.prob = min(prev.prob, float(w.probability))
            continue
        if out and not text.startswith(" "):
            # склейка кусков слова (редко, но бывает при word_timestamps)
            prev = out[-1]
            prev.text += text
            prev.end = max(prev.end, float(w.end))
            prev.prob = min(prev.prob, float(w.probability))
            continue
        out.append(RawWord(float(w.start), float(w.end), text.strip(), float(w.probability)))
    return [w for w in out if w.text]


def _looks_hallucinated(segment_text: str) -> bool:
    t = segment_text.lower()
    return any(p in t for p in HALLUCINATION_PHRASES)


def transcribe(
    model: Any,
    samples: np.ndarray,
    *,
    language: str = "ru",
    initial_prompt: str | None = INITIAL_PROMPT,
    speech_spans: list[Span] | None = None,
    on_progress: Callable[[float], None] | None = None,
    beam_size: int = 5,
) -> tuple[list[RawWord], list[str]]:
    """Возвращает слова с таймкодами и список предупреждений.

    Прогресс отдаётся по мере обработки сегментов (генератор faster-whisper).
    Слова вне речи по VAD и сегменты-галлюцинации отбрасываются.
    """
    warnings: list[str] = []
    if samples.size == 0:
        return [], warnings
    segments, _info = model.transcribe(
        samples.astype(np.float32),
        language=language,
        beam_size=beam_size,
        temperature=0.0,
        word_timestamps=True,
        condition_on_previous_text=False,
        vad_filter=False,
        initial_prompt=initial_prompt,
        no_speech_threshold=0.6,
    )
    words: list[RawWord] = []
    dropped_vad = 0
    dropped_halluc = 0
    for seg in segments:
        if on_progress is not None:
            on_progress(float(seg.end))
        if _looks_hallucinated(seg.text or ""):
            dropped_halluc += len(seg.words or [])
            continue
        if seg.no_speech_prob is not None and seg.no_speech_prob > 0.85 and (seg.avg_logprob or 0) < -1.0:
            dropped_halluc += len(seg.words or [])
            continue
        for rw in _merge_tokens(seg.words or []):
            if rw.end <= rw.start:
                rw.end = rw.start + 0.02
            if speech_spans is not None:
                ov = overlap_duration(Span(rw.start - 0.15, rw.end + 0.15), speech_spans)
                if ov <= 0.0:
                    dropped_vad += 1
                    continue
            words.append(rw)
    if dropped_vad:
        warnings.append(f"ASR: отброшено {dropped_vad} слов вне речи по VAD (вероятные галлюцинации)")
    if dropped_halluc:
        warnings.append(f"ASR: отброшено {dropped_halluc} слов из сегментов-галлюцинаций")
    words.sort(key=lambda w: (w.start, w.end))
    return words, warnings
