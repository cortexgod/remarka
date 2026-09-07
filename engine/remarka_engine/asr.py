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
# Только целые типовые фразы: одиночные слова вроде «субтитры» или «корректор»
# встречаются и в живой речи, поэтому фильтр применяется лишь к подозрительным
# сегментам (см. _suspicious).
HALLUCINATION_PHRASES = (
    "редактор субтитров",
    "субтитры сделал",
    "субтитры создавал",
    "субтитры подготовил",
    "корректор а.егорова",
    "продолжение следует",
    "спасибо за просмотр",
    "подписывайтесь на канал",
    "dimatorzok",
    "закомолдина",
    "subtitles by",
)

# Транскрибируем по кускам речи (по своему VAD): промпт дословности действует
# в каждом окне (иначе faster-whisper сбрасывает его после первого окна при
# condition_on_previous_text=False), а тишина не декодируется вовсе.
CHUNK_MAX_SEC = 28.0
CHUNK_MERGE_GAP_SEC = 1.0
CHUNK_PAD_SEC = 0.25


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


def _suspicious(seg: Any, seg_start: float, seg_end: float, speech_spans: list[Span] | None) -> bool:
    """Сегмент подозрителен, если плохо покрыт речью по VAD или сам Whisper в нём не уверен."""
    if speech_spans is not None and seg_end > seg_start:
        ov = overlap_duration(Span(seg_start, seg_end), speech_spans)
        if ov < 0.5 * (seg_end - seg_start):
            return True
    nsp = getattr(seg, "no_speech_prob", None)
    alp = getattr(seg, "avg_logprob", None)
    cr = getattr(seg, "compression_ratio", None)
    if nsp is not None and nsp > 0.6:
        return True
    if alp is not None and alp < -1.0:
        return True
    if cr is not None and cr > 2.4:
        return True
    return False


def speech_chunks(speech_spans: list[Span], total_sec: float) -> list[Span]:
    """Куски для транскрипции: речь по VAD, слитая через зазоры < 1 с, не длиннее 28 с, с запасом по краям."""
    chunks: list[Span] = []
    cur: Span | None = None
    for s in sorted(speech_spans, key=lambda x: x.start):
        if cur is not None and s.start - cur.end < CHUNK_MERGE_GAP_SEC and s.end - cur.start <= CHUNK_MAX_SEC:
            cur = Span(cur.start, max(cur.end, s.end))
            continue
        if cur is not None:
            chunks.append(cur)
        cur = Span(s.start, s.end)
    if cur is not None:
        chunks.append(cur)
    out: list[Span] = []
    for c in chunks:
        # слишком длинный непрерывный кусок режем на равные части ≤ 28 с
        n = max(1, int(np.ceil(c.duration / CHUNK_MAX_SEC)))
        step = c.duration / n
        for i in range(n):
            a = c.start + i * step
            b = c.start + (i + 1) * step if i < n - 1 else c.end
            out.append(Span(max(0.0, a - CHUNK_PAD_SEC), min(total_sec, b + CHUNK_PAD_SEC)))
    return out


def transcribe(
    model: Any,
    samples: np.ndarray,
    *,
    language: str = "ru",
    initial_prompt: str | None = INITIAL_PROMPT,
    speech_spans: list[Span] | None = None,
    on_progress: Callable[[float], None] | None = None,
    beam_size: int = 5,
    sample_rate: int = 16000,
) -> tuple[list[RawWord], list[str]]:
    """Возвращает слова с таймкодами и список предупреждений.

    Если переданы отрезки речи по VAD, дорожка транскрибируется по кускам речи
    (промпт дословности в каждом окне, тишина не декодируется). Прогресс — по
    мере обработки кусков/сегментов. Слова вне речи по VAD и подозрительные
    сегменты-галлюцинации отбрасываются.
    """
    warnings: list[str] = []
    if samples.size == 0:
        return [], warnings
    total_sec = samples.size / float(sample_rate)
    if speech_spans is not None:
        chunks = speech_chunks(speech_spans, total_sec)
        if not chunks:
            return [], warnings
    else:
        chunks = [Span(0.0, total_sec)]

    words: list[RawWord] = []
    dropped_vad = 0
    dropped_halluc = 0
    kwargs = dict(
        language=language,
        beam_size=beam_size,
        temperature=(0.0, 0.2, 0.4),
        compression_ratio_threshold=2.4,
        word_timestamps=True,
        condition_on_previous_text=False,
        vad_filter=False,
        initial_prompt=initial_prompt,
        no_speech_threshold=0.6,
    )
    for ch in chunks:
        a = int(round(ch.start * sample_rate))
        b = int(round(ch.end * sample_rate))
        piece = samples[a:b].astype(np.float32)
        if piece.size < int(0.1 * sample_rate):
            continue
        segments, _info = model.transcribe(piece, **kwargs)
        for seg in segments:
            seg_start = ch.start + float(seg.start)
            seg_end = ch.start + float(seg.end)
            if on_progress is not None:
                on_progress(min(total_sec, seg_end))
            if _suspicious(seg, seg_start, seg_end, speech_spans) and (
                _looks_hallucinated(seg.text or "")
                or ((seg.no_speech_prob or 0) > 0.85 and (seg.avg_logprob or 0) < -1.0)
            ):
                dropped_halluc += len(seg.words or [])
                continue
            for rw in _merge_tokens(seg.words or []):
                rw.start += ch.start
                rw.end += ch.start
                if rw.end <= rw.start:
                    rw.end = rw.start + 0.02
                if speech_spans is not None:
                    ov = overlap_duration(Span(rw.start - 0.15, rw.end + 0.15), speech_spans)
                    if ov <= 0.0:
                        dropped_vad += 1
                        continue
                words.append(rw)
        if on_progress is not None:
            on_progress(min(total_sec, ch.end))
    if dropped_vad:
        warnings.append(f"ASR: отброшено {dropped_vad} слов вне речи по VAD (вероятные галлюцинации)")
    if dropped_halluc:
        warnings.append(f"ASR: отброшено {dropped_halluc} слов из сегментов-галлюцинаций")
    words.sort(key=lambda w: (w.start, w.end))
    return words, warnings
