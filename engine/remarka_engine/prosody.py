"""Слой 2 (§4.3): f0, интенсивность, затухание фраз, восходящие утверждения, джиттер/шиммер."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .model import Sentence, SpeechEvent, fmt_signed
from .spans import Span

PITCH_FLOOR = 60.0
PITCH_CEILING = 400.0
TIME_STEP = 0.01
DECAY_EVENT_DB = 6.0
RISING_ST = 2.0
DECAY_MIN_SENTENCE = 1.5
RISING_MIN_SENTENCE = 1.0
JITTER_CHUNK_SEC = 30.0
START_WINDOW_SEC = 120.0
START_RATIO_MIN_DURATION = 240.0


@dataclass
class ProsodyFrames:
    """Покадровые ряды по всей дорожке (шаг 10 мс) и маска «моя речь»."""

    pitch_t: np.ndarray = field(default_factory=lambda: np.zeros(0))
    f0: np.ndarray = field(default_factory=lambda: np.zeros(0))
    int_t: np.ndarray = field(default_factory=lambda: np.zeros(0))
    db: np.ndarray = field(default_factory=lambda: np.zeros(0))
    pitch_mine: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=bool))
    int_mine: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=bool))
    speaker_median_st: float | None = None

    @property
    def empty(self) -> bool:
        return self.pitch_t.size == 0


@dataclass
class ProsodyResult:
    values: dict[str, float | None]
    events: list[SpeechEvent]
    frames: ProsodyFrames


def st(f0: np.ndarray) -> np.ndarray:
    return 12.0 * np.log2(np.asarray(f0, dtype=np.float64) / 100.0)


def _mask(ts: np.ndarray, spans: list[Span]) -> np.ndarray:
    m = np.zeros(len(ts), dtype=bool)
    for s in spans:
        m |= (ts >= s.start) & (ts <= s.end)
    return m


def compute_frames(samples: np.ndarray, sr: int, mic_speech: list[Span]) -> ProsodyFrames:
    if samples.size < sr // 5 or not mic_speech:
        return ProsodyFrames()
    import parselmouth

    snd = parselmouth.Sound(samples.astype(np.float64), sampling_frequency=sr)
    pitch = snd.to_pitch_ac(time_step=TIME_STEP, pitch_floor=PITCH_FLOOR, pitch_ceiling=PITCH_CEILING)
    f0 = np.asarray(pitch.selected_array["frequency"], dtype=np.float64)
    pitch_t = np.asarray(pitch.xs(), dtype=np.float64)
    inten = snd.to_intensity(minimum_pitch=75.0, time_step=TIME_STEP)
    db = np.asarray(inten.values[0], dtype=np.float64)
    int_t = np.asarray(inten.xs(), dtype=np.float64)
    fr = ProsodyFrames(pitch_t=pitch_t, f0=f0, int_t=int_t, db=db, pitch_mine=_mask(pitch_t, mic_speech), int_mine=_mask(int_t, mic_speech))
    voiced = f0[(f0 > 0) & fr.pitch_mine]
    fr.speaker_median_st = float(np.median(st(voiced))) if voiced.size else None
    return fr


def _voiced_in(fr: ProsodyFrames, a: float, b: float) -> tuple[np.ndarray, np.ndarray]:
    m = (fr.pitch_t >= a) & (fr.pitch_t <= b) & fr.pitch_mine & (fr.f0 > 0)
    return fr.pitch_t[m], fr.f0[m]


def _db_in(fr: ProsodyFrames, a: float, b: float) -> np.ndarray:
    m = (fr.int_t >= a) & (fr.int_t <= b) & fr.int_mine & np.isfinite(fr.db)
    return fr.db[m]


def energy_mean_db(db: np.ndarray) -> float:
    """Средняя интенсивность в дБ через энергию (10·log10 mean 10^(dB/10)):
    среднее по дБ тянут вниз смычки и микропаузы, а по энергии — это громкость гласных."""
    return float(10.0 * np.log10(np.mean(np.power(10.0, np.asarray(db, dtype=np.float64) / 10.0))))


def phrase_final_decay(fr: ProsodyFrames, sentences: list[Sentence]) -> tuple[float | None, list[SpeechEvent]]:
    """Последние 0,5 с речи предложения (по кадрам внутри моих сегментов VAD) против средних 50 %."""
    vals: list[float] = []
    events: list[SpeechEvent] = []
    last_n = int(round(0.5 / TIME_STEP))
    for s in sentences:
        if s.duration <= DECAY_MIN_SENTENCE:
            continue
        db = _db_in(fr, s.start, s.end)
        if db.size < last_n + 10:
            continue
        last = db[-last_n:]
        mid = db[db.size // 4 : (3 * db.size) // 4]
        if last.size < 3 or mid.size < 3:
            continue
        decay = energy_mean_db(mid) - energy_mean_db(last)
        vals.append(decay)
        if decay > DECAY_EVENT_DB:
            events.append(
                SpeechEvent(t=max(s.start, s.end - 0.5), end=s.end, kind="decay", label=fmt_signed(-decay, "дБ"), source="signal", word_i=s.word_to, sentence_i=s.i, value=decay)
            )
    return (float(np.median(vals)) if vals else None), events


def rising_statements(fr: ProsodyFrames, sentences: list[Sentence]) -> tuple[float | None, list[SpeechEvent]]:
    n = 0
    rising = 0
    events: list[SpeechEvent] = []
    for s in sentences:
        if s.is_question or s.duration <= RISING_MIN_SENTENCE:
            continue
        ts, f0 = _voiced_in(fr, s.start, s.end)
        if ts.size < 10:
            continue
        t_last = ts[-1]
        tail = f0[ts >= t_last - 0.4]
        head = f0[(ts < t_last - 0.4) & (ts >= t_last - 1.0)]
        if tail.size < 3 or head.size < 3:
            continue
        n += 1
        diff = float(np.median(st(tail)) - np.median(st(head)))
        if diff >= RISING_ST:
            rising += 1
            events.append(
                SpeechEvent(t=s.start, end=s.end, kind="rising_statement", label=fmt_signed(diff, "пт"), source="signal", word_i=s.word_to, sentence_i=s.i, value=diff)
            )
    return (rising / n if n else None), events


def _jitter_shimmer(samples: np.ndarray, sr: int) -> tuple[float | None, float | None]:
    import parselmouth
    from parselmouth.praat import call

    if samples.size < sr // 2:
        return None, None
    snd = parselmouth.Sound(samples.astype(np.float64), sampling_frequency=sr)
    try:
        pp = call(snd, "To PointProcess (periodic, cc)", PITCH_FLOOR, PITCH_CEILING)
        jit = call(pp, "Get jitter (local)", 0, 0, 0.0001, 0.02, 1.3)
        shim = call([snd, pp], "Get shimmer (local)", 0, 0, 0.0001, 0.02, 1.3, 1.6)
    except Exception:  # noqa: BLE001
        return None, None
    j = None if jit is None or jit != jit else float(jit) * 100.0
    s = None if shim is None or shim != shim else float(shim) * 100.0
    return j, s


def _concat_speech(samples: np.ndarray, sr: int, spans: list[Span]) -> np.ndarray:
    parts = [samples[int(s.start * sr) : int(s.end * sr)] for s in spans]
    parts = [p for p in parts if p.size]
    return np.concatenate(parts) if parts else np.zeros(0, dtype=samples.dtype)


def jitter_shimmer_weighted(samples: np.ndarray, sr: int, spans: list[Span]) -> tuple[float | None, float | None]:
    """Среднее по кускам ~30 с моей речи, взвешенное длительностью."""
    speech = _concat_speech(samples, sr, spans)
    if speech.size < sr // 2:
        return None, None
    chunk = int(JITTER_CHUNK_SEC * sr)
    jw = sw = 0.0
    jn = sn = 0.0
    for a in range(0, speech.size, chunk):
        part = speech[a : a + chunk]
        if part.size < sr // 2:
            continue
        j, s = _jitter_shimmer(part, sr)
        w = part.size / sr
        if j is not None:
            jw += j * w
            jn += w
        if s is not None:
            sw += s * w
            sn += w
    return (jw / jn if jn else None), (sw / sn if sn else None)


def start_jitter_ratio(samples: np.ndarray, sr: int, spans: list[Span], duration_sec: float) -> float | None:
    if duration_sec < START_RATIO_MIN_DURATION:
        return None
    first = [Span(s.start, min(s.end, START_WINDOW_SEC)) for s in spans if s.start < START_WINDOW_SEC]
    rest = [Span(max(s.start, START_WINDOW_SEC), s.end) for s in spans if s.end > START_WINDOW_SEC]
    j1, _ = jitter_shimmer_weighted(samples, sr, first)
    j2, _ = jitter_shimmer_weighted(samples, sr, rest)
    if j1 is None or j2 is None or j2 <= 0:
        return None
    return j1 / j2


def analyze(samples: np.ndarray, sr: int, mic_speech: list[Span], sentences: list[Sentence], duration_sec: float) -> ProsodyResult:
    values: dict[str, float | None] = {
        "pitch_median_hz": None,
        "pitch_range_st": None,
        "phrase_final_decay_db": None,
        "rising_statements_share": None,
        "jitter_pct": None,
        "shimmer_pct": None,
        "start_jitter_ratio": None,
        "loudness_drift_db": None,
        "loudness_mean_db": None,
    }
    events: list[SpeechEvent] = []
    fr = compute_frames(samples, sr, mic_speech)
    if fr.empty:
        return ProsodyResult(values, events, fr)
    voiced = fr.f0[(fr.f0 > 0) & fr.pitch_mine]
    if voiced.size >= 10:
        values["pitch_median_hz"] = float(np.median(voiced))
        s = st(voiced)
        values["pitch_range_st"] = float(np.percentile(s, 90) - np.percentile(s, 10))
    decay, ev = phrase_final_decay(fr, sentences)
    values["phrase_final_decay_db"] = decay
    events += ev
    share, ev = rising_statements(fr, sentences)
    values["rising_statements_share"] = share
    events += ev
    mine_db = fr.db[fr.int_mine & np.isfinite(fr.db)]
    if mine_db.size >= 10:
        values["loudness_mean_db"] = float(np.mean(mine_db))
        half = mine_db.size // 2
        values["loudness_drift_db"] = float(np.mean(mine_db[half:]) - np.mean(mine_db[:half]))
    j, sh = jitter_shimmer_weighted(samples, sr, mic_speech)
    values["jitter_pct"] = j
    values["shimmer_pct"] = sh
    values["start_jitter_ratio"] = start_jitter_ratio(samples, sr, mic_speech, duration_sec)
    return ProsodyResult(values, events, fr)
