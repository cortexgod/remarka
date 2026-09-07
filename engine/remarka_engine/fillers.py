"""Заполненные паузы: по ASR (словарь) и по сигналу (§4.2), объединение с дедупликацией."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

import numpy as np

from .model import SpeechEvent, Word
from .references import load_data
from .spans import Span, intersect, normalize, subtract, total

CANDIDATE_MIN = 0.25
CANDIDATE_MAX = 2.0
WORD_OVERLAP_MAX = 0.30  # кандидат не перекрыт «настоящим» словом более чем на 30 %
# Пословные таймкоды Whisper врут на ±0,1 с: хвосты гласных соседних слов проходят
# все просодические проверки, поэтому дыры между словами берём с запасом от границ слов.
WORD_MARGIN = 0.15
VOICED_MIN = 0.6
F0_STD_ST_MAX = 1.5
INTENSITY_MARGIN_DB = 12.0
CENTROID_MM_HZ = 500.0
DEDUP_OVERLAP = 0.5


@dataclass
class CandidateFeatures:
    voiced_share: float
    f0_std_st: float
    mean_db: float
    centroid_hz: float
    ok: bool
    label: str


def _patterns() -> list[tuple[re.Pattern[str], str]]:
    data = load_data("fillers.json")
    return [(re.compile(p["regex"]), p["label"]) for p in data["patterns"]]


def match_filler(norm: str) -> str | None:
    """Метка филлера по norm («э-э» → «ээ» → ^э+$) или None."""
    key = norm.replace("-", "")
    if not key:
        return None
    for rx, label in _patterns():
        if rx.match(key):
            return label
    return None


def mark_asr_fillers(words: list[Word]) -> list[SpeechEvent]:
    """Помечает kind=filler и возвращает события filled_pause (source=asr)."""
    events: list[SpeechEvent] = []
    for w in words:
        label = match_filler(w.norm)
        if label is None:
            continue
        w.kind = "filler"
        events.append(
            SpeechEvent(t=w.start, end=w.end, kind="filled_pause", label=label, source="asr", word_i=w.i, sentence_i=w.sentence_i, value=w.end - w.start)
        )
    return events


def candidate_regions(mic_speech: list[Span], real_word_spans: list[Span]) -> list[Span]:
    """Кандидаты: сегменты VAD 0,25–2,0 с, перекрытые словами ≤ 30 %; плюс участки речи VAD,
    не покрытые словами (0,25–2,0 с) внутри длинных сегментов."""
    words = normalize(real_word_spans)
    out: list[Span] = []
    for seg in mic_speech:
        d = seg.duration
        if CANDIDATE_MIN <= d <= CANDIDATE_MAX:
            ov = total(intersect([seg], words))
            if ov <= WORD_OVERLAP_MAX * d:
                out.append(seg)
                continue
        # части сегмента, где VAD видит речь, а слов нет (с запасом от границ слов)
        for gap in subtract([seg], [Span(w.start - WORD_MARGIN, w.end + WORD_MARGIN) for w in words]):
            if CANDIDATE_MIN <= gap.duration <= CANDIDATE_MAX:
                out.append(gap)
    return normalize(out)


def speech_intensity_median_db(samples: np.ndarray, sr: int, mic_speech: list[Span]) -> float | None:
    """Медиана интенсивности (дБ) по моей речи — опора для порога громкости."""
    if samples.size < sr // 10 or not mic_speech:
        return None
    import parselmouth

    snd = parselmouth.Sound(samples.astype(np.float64), sampling_frequency=sr)
    inten = snd.to_intensity(minimum_pitch=75.0, time_step=0.01)
    ts = inten.xs()
    vals = inten.values[0]
    mask = np.zeros(len(ts), dtype=bool)
    for s in mic_speech:
        mask |= (ts >= s.start) & (ts <= s.end)
    vals = vals[mask]
    vals = vals[np.isfinite(vals)]
    if vals.size == 0:
        return None
    return float(np.median(vals))


def spectral_centroid(samples: np.ndarray, sr: int) -> float:
    if samples.size < 16:
        return 0.0
    x = samples.astype(np.float64) - float(np.mean(samples))
    win = np.hanning(len(x))
    spec = np.abs(np.fft.rfft(x * win))
    freqs = np.fft.rfftfreq(len(x), 1.0 / sr)
    band = freqs <= 4000
    spec = spec[band]
    freqs = freqs[band]
    s = float(np.sum(spec))
    if s <= 0:
        return 0.0
    return float(np.sum(freqs * spec) / s)


def analyze_candidate(samples: np.ndarray, sr: int, ref_db: float | None) -> CandidateFeatures:
    """Проверки §4.2 на вырезке: озвонченность ≥ 0,6, std f0 ≤ 1,5 пт, громкость ≥ медиана − 12 дБ."""
    import parselmouth

    if samples.size < int(CANDIDATE_MIN * sr):
        return CandidateFeatures(0.0, 99.0, -120.0, 0.0, False, "э-э")
    snd = parselmouth.Sound(samples.astype(np.float64), sampling_frequency=sr)
    try:
        pitch = snd.to_pitch_ac(time_step=0.01, pitch_floor=60.0, pitch_ceiling=400.0)
        f0 = pitch.selected_array["frequency"]
    except Exception:  # noqa: BLE001
        f0 = np.zeros(0)
    voiced = f0[f0 > 0]
    voiced_share = float(len(voiced) / len(f0)) if len(f0) else 0.0
    if len(voiced) >= 2:
        st = 12.0 * np.log2(voiced / 100.0)
        f0_std = float(np.std(st))
    else:
        f0_std = 99.0
    try:
        inten = snd.to_intensity(minimum_pitch=75.0, time_step=0.01)
        vals = inten.values[0]
        vals = vals[np.isfinite(vals)]
        mean_db = float(np.mean(vals)) if vals.size else -120.0
    except Exception:  # noqa: BLE001
        mean_db = -120.0
    centroid = spectral_centroid(samples, sr)
    loud_ok = True if ref_db is None else mean_db >= ref_db - INTENSITY_MARGIN_DB
    ok = voiced_share >= VOICED_MIN and f0_std <= F0_STD_ST_MAX and loud_ok
    label = "м-м" if centroid < CENTROID_MM_HZ else "э-э"
    return CandidateFeatures(voiced_share, f0_std, mean_db, centroid, ok, label)


def detect_filled_pauses(
    samples: np.ndarray,
    sr: int,
    mic_speech: list[Span],
    words: list[Word],
    ref_db: float | None = None,
) -> list[SpeechEvent]:
    """Детектор заполненных пауз по сигналу → события filled_pause (source=detector)."""
    if samples.size == 0 or not mic_speech:
        return []
    real_spans = [Span(w.start, w.end) for w in words if w.kind != "filler"]
    events: list[SpeechEvent] = []
    for cand in candidate_regions(mic_speech, real_spans):
        a = int(cand.start * sr)
        b = int(cand.end * sr)
        feats = analyze_candidate(samples[a:b], sr, ref_db)
        if not feats.ok:
            continue
        sentence_i = _sentence_at(words, cand.start)
        events.append(
            SpeechEvent(t=cand.start, end=cand.end, kind="filled_pause", label=feats.label, source="detector", word_i=None, sentence_i=sentence_i, value=cand.duration)
        )
    return events


def _sentence_at(words: list[Word], t: float) -> int | None:
    best: Word | None = None
    for w in words:
        if w.start <= t:
            best = w
        else:
            break
    return best.sentence_i if best is not None else None


def _overlap_share(a: SpeechEvent, b: SpeechEvent) -> float:
    s = max(a.t, b.t)
    e = min(a.end, b.end)
    if e <= s:
        return 0.0
    shorter = max(min(a.end - a.t, b.end - b.t), 1e-3)
    return (e - s) / shorter


def merge_filler_events(asr_events: list[SpeechEvent], detector_events: list[SpeechEvent]) -> list[SpeechEvent]:
    """Дедупликация: перекрытие ≥ 50 % → одно событие source=both (оставляем привязку ASR)."""
    merged = [SpeechEvent(**vars(e)) for e in asr_events]
    for d in detector_events:
        hit = None
        for m in merged:
            if m.source in ("asr", "both") and _overlap_share(m, d) >= DEDUP_OVERLAP:
                hit = m
                break
        if hit is not None:
            hit.source = "both"
        else:
            merged.append(d)
    merged.sort(key=lambda e: e.t)
    return merged


def semitones(f0_hz: float) -> float:
    return 12.0 * math.log2(f0_hz / 100.0)
