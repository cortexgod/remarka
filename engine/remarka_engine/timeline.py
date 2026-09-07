"""Скользящие окна (§4.1): темп, артикуляционный темп, тон, громкость, fast_burst."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .model import SpeechEvent, TimePoint, Word
from .prosody import ProsodyFrames, st
from .spans import Span, clip, merge_gaps, subtract, total

WINDOW_SEC = 15.0
STEP_SEC = 5.0
FAST_BURST_FACTOR = 1.2
MIN_WORDS_FOR_MEDIAN = 5


@dataclass
class Window:
    start: float
    end: float
    n_words: int = 0
    my_sec: float = 0.0  # окно минус отрезки, где говорит только собеседник
    speech_sec: float = 0.0  # сумма моих сегментов VAD в окне
    has_my_speech: bool = False
    wpm: float = 0.0
    articulation_wpm: float = 0.0

    @property
    def center(self) -> float:
        return (self.start + self.end) / 2


@dataclass
class TimelineResult:
    window_sec: float
    step_sec: float
    windows: list[Window] = field(default_factory=list)
    wpm: list[TimePoint] = field(default_factory=list)
    articulation_wpm: list[TimePoint] = field(default_factory=list)
    pitch_semitones: list[TimePoint] = field(default_factory=list)
    loudness_db: list[TimePoint] = field(default_factory=list)
    other_speaking: list[Span] = field(default_factory=list)
    fast_bursts: list[SpeechEvent] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "window_sec": self.window_sec,
            "step_sec": self.step_sec,
            "wpm": [p.to_dict() for p in self.wpm],
            "articulation_wpm": [p.to_dict() for p in self.articulation_wpm],
            "pitch_semitones": [p.to_dict() for p in self.pitch_semitones],
            "loudness_db": [p.to_dict() for p in self.loudness_db],
            "other_speaking": [s.to_dict() for s in self.other_speaking],
        }

    def median_wpm(self) -> float | None:
        vals = [w.wpm for w in self.windows if w.n_words >= MIN_WORDS_FOR_MEDIAN]
        return float(np.median(vals)) if vals else None

    def median_articulation(self) -> float | None:
        vals = [w.articulation_wpm for w in self.windows if w.n_words >= MIN_WORDS_FOR_MEDIAN and w.speech_sec > 0]
        return float(np.median(vals)) if vals else None


def window_bounds(duration: float, window: float = WINDOW_SEC, step: float = STEP_SEC) -> list[tuple[float, float]]:
    """Первое окно 0–15 (t=7,5), дальше шаг 5 с, последнее — последнее полное окно.
    Если запись короче окна — одно окно на всю запись."""
    if duration <= 0:
        return []
    if duration < window:
        return [(0.0, duration)]
    out: list[tuple[float, float]] = []
    start = 0.0
    while start + window <= duration + 1e-9:
        out.append((start, start + window))
        start += step
    return out


def build(
    words: list[Word],
    mic_speech: list[Span],
    system_speech: list[Span],
    duration: float,
    frames: ProsodyFrames | None = None,
    ref_high_wpm: float | None = None,
) -> TimelineResult:
    res = TimelineResult(window_sec=WINDOW_SEC, step_sec=STEP_SEC)
    res.other_speaking = merge_gaps(system_speech, 0.3)
    real_starts = np.array([w.start for w in words if w.kind != "filler"], dtype=np.float64)
    other_only = subtract(system_speech, mic_speech)
    for a, b in window_bounds(duration):
        win = Window(start=a, end=b)
        win.n_words = int(np.count_nonzero((real_starts >= a) & (real_starts < b))) if real_starts.size else 0
        win.speech_sec = total(clip(mic_speech, a, b))
        win.has_my_speech = win.speech_sec > 0
        win.my_sec = max(0.0, (b - a) - total(clip(other_only, a, b)))
        if win.has_my_speech and win.my_sec > 0:
            win.wpm = win.n_words / (win.my_sec / 60.0)
        if win.speech_sec > 0:
            win.articulation_wpm = win.n_words / (win.speech_sec / 60.0)
        res.windows.append(win)
        res.wpm.append(TimePoint(win.center, win.wpm))
        res.articulation_wpm.append(TimePoint(win.center, win.articulation_wpm))
        if frames is not None and not frames.empty:
            m = (frames.pitch_t >= a) & (frames.pitch_t < b) & frames.pitch_mine & (frames.f0 > 0)
            if np.count_nonzero(m) >= 5 and frames.speaker_median_st is not None:
                res.pitch_semitones.append(TimePoint(win.center, float(np.median(st(frames.f0[m])) - frames.speaker_median_st)))
            mi = (frames.int_t >= a) & (frames.int_t < b) & frames.int_mine & np.isfinite(frames.db)
            if np.count_nonzero(mi) >= 5:
                res.loudness_db.append(TimePoint(win.center, float(np.mean(frames.db[mi]))))
        if ref_high_wpm is not None and win.n_words >= MIN_WORDS_FOR_MEDIAN and win.wpm > ref_high_wpm * FAST_BURST_FACTOR:
            res.fast_bursts.append(
                SpeechEvent(t=a, end=b, kind="fast_burst", label=f"{int(round(win.wpm))} сл/мин", source="asr", word_i=None, sentence_i=None, value=win.wpm)
            )
    return res
