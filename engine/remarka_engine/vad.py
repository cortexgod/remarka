"""VAD: Silero через faster_whisper.vad (onnxruntime, без torch)."""

from __future__ import annotations

import numpy as np

from .spans import Span, normalize

# Параметры подобраны так, чтобы паузы ≥ 0,2 с разрывали сегменты:
# это нужно артикуляционному темпу (речь без пауз) и детектору заполненных пауз.
DEFAULT_THRESHOLD = 0.5
DEFAULT_MIN_SPEECH_MS = 100
DEFAULT_MIN_SILENCE_MS = 150
DEFAULT_PAD_MS = 30


def speech_spans(
    samples: np.ndarray,
    sample_rate: int = 16000,
    *,
    threshold: float = DEFAULT_THRESHOLD,
    min_speech_ms: int = DEFAULT_MIN_SPEECH_MS,
    min_silence_ms: int = DEFAULT_MIN_SILENCE_MS,
    pad_ms: int = DEFAULT_PAD_MS,
) -> list[Span]:
    """Отрезки речи по Silero VAD. Пустой список для тишины/пустого сигнала."""
    if samples is None or samples.size < sample_rate // 10:
        return []
    if float(np.max(np.abs(samples))) < 1e-5:
        return []
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    opts = VadOptions(
        threshold=threshold,
        min_speech_duration_ms=min_speech_ms,
        min_silence_duration_ms=min_silence_ms,
        speech_pad_ms=pad_ms,
    )
    raw = get_speech_timestamps(samples.astype(np.float32), opts, sampling_rate=sample_rate)
    duration = len(samples) / sample_rate
    spans = [
        Span(max(0.0, r["start"] / sample_rate), min(duration, r["end"] / sample_rate))
        for r in raw
    ]
    return normalize(spans)
