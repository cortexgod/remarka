import numpy as np
from conftest import SR

from remarka_engine import prosody
from remarka_engine.model import Sentence
from remarka_engine.spans import Span


def _voice(dur: float, f0_from: float, f0_to: float, amp_from: float = 0.3, amp_to: float = 0.3) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    f0 = np.linspace(f0_from, f0_to, n)
    phase = 2 * np.pi * np.cumsum(f0) / SR
    amp = np.linspace(amp_from, amp_to, n)
    x = np.zeros(n)
    for h in range(1, 12):
        x += np.sin(h * phase) / h
    return (amp * x / 3).astype(np.float32)


def test_pitch_range_and_median():
    sig = np.concatenate([_voice(1.0, 100, 100), np.zeros(SR // 2, dtype=np.float32), _voice(1.0, 200, 200)])
    res = prosody.analyze(sig, SR, [Span(0, 1.0), Span(1.5, 2.5)], [], 2.5)
    assert res.values["pitch_median_hz"] is not None
    assert res.values["pitch_range_st"] is not None and res.values["pitch_range_st"] > 10  # октава ≈ 12 пт
    assert res.values["loudness_mean_db"] is not None
    assert res.values["start_jitter_ratio"] is None  # запись < 4 мин
    assert res.frames.pitch_mine.any()


def test_rising_statement_detected():
    sig = _voice(2.0, 120, 120)
    sig[-int(0.5 * SR) :] = _voice(0.5, 120, 180)[: int(0.5 * SR)]  # хвост уходит вверх ≈ 7 пт
    sents = [Sentence(i=0, start=0.0, end=2.0, text="утверждение", word_from=0, word_to=0, n_words=1, is_question=False)]
    share, ev = prosody.rising_statements(prosody.compute_frames(sig, SR, [Span(0, 2.0)]), sents)
    assert share == 1.0 and ev[0].kind == "rising_statement" and ev[0].value >= 2
    flat = _voice(2.0, 120, 120)
    share2, ev2 = prosody.rising_statements(prosody.compute_frames(flat, SR, [Span(0, 2.0)]), sents)
    assert share2 == 0.0 and ev2 == []


def test_phrase_final_decay_detects_fade():
    fade = _voice(2.0, 120, 120, amp_from=0.3, amp_to=0.3)
    fade[-int(0.5 * SR) :] *= 0.1  # −20 дБ на последних 0,5 с
    sents = [Sentence(i=0, start=0.0, end=2.0, text="фраза", word_from=0, word_to=0, n_words=1, is_question=False)]
    decay, ev = prosody.phrase_final_decay(prosody.compute_frames(fade, SR, [Span(0, 2.0)]), sents)
    assert decay is not None and decay > 6 and ev and ev[0].kind == "decay"
    flat = _voice(2.0, 120, 120)
    decay2, ev2 = prosody.phrase_final_decay(prosody.compute_frames(flat, SR, [Span(0, 2.0)]), sents)
    assert decay2 is not None and abs(decay2) < 3 and ev2 == []


def test_empty_signal_gives_nulls():
    res = prosody.analyze(np.zeros(SR * 2, dtype=np.float32), SR, [], [], 2.0)
    assert all(v is None for v in res.values.values()) and res.events == [] and res.frames.empty
