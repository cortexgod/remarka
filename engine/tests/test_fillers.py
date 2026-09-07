import numpy as np
from conftest import SR, words_from_text

from remarka_engine import fillers
from remarka_engine.model import SpeechEvent
from remarka_engine.spans import Span


def test_match_filler_patterns():
    assert fillers.match_filler("э-э") == "э-э"
    assert fillers.match_filler("ээ") == "э-э"
    assert fillers.match_filler("м-м") == "м-м"
    assert fillers.match_filler("мм") == "м-м"
    assert fillers.match_filler("а-а") == "а-а"
    assert fillers.match_filler("хм") == "хм"
    assert fillers.match_filler("а") is None  # союз «а» — не филлер
    assert fillers.match_filler("мама") is None
    assert fillers.match_filler("это") is None


def test_mark_asr_fillers_sets_kind_and_events():
    words = words_from_text("Э-э, сегодня м-м, я, хм, думаю.")
    ev = fillers.mark_asr_fillers(words)
    assert [w.kind for w in words] == ["filler", "word", "filler", "word", "filler", "word"]
    assert [e.label for e in ev] == ["э-э", "м-м", "хм"]
    assert all(e.kind == "filled_pause" and e.source == "asr" for e in ev)
    assert ev[0].word_i == 0 and ev[0].t == words[0].start


def _tone(freq: float, dur: float, amp: float = 0.3, harmonics: int = 1) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    x = np.zeros_like(t)
    for h in range(1, harmonics + 1):
        x += (amp / h) * np.sin(2 * np.pi * freq * h * t)
    return x.astype(np.float32)


def test_detector_accepts_steady_tone_and_rejects_noise():
    tone = _tone(120.0, 0.6)
    f = fillers.analyze_candidate(tone, SR, ref_db=None)
    assert f.ok and f.voiced_share >= 0.6 and f.f0_std_st <= 1.5
    assert f.label == "м-м"  # чистый тон 120 Гц: центроид < 500 Гц
    noise = (0.3 * np.random.default_rng(0).standard_normal(int(0.6 * SR))).astype(np.float32)
    assert not fillers.analyze_candidate(noise, SR, ref_db=None).ok


def test_detector_labels_bright_tone_as_e():
    buzz = _tone(140.0, 0.6, harmonics=20)
    f = fillers.analyze_candidate(buzz, SR, ref_db=None)
    assert f.ok and f.label == "э-э"


def test_detector_rejects_quiet_candidate():
    tone = _tone(120.0, 0.6, amp=0.003)
    loud_ref = fillers.analyze_candidate(_tone(120.0, 0.6, amp=0.3), SR, None).mean_db
    assert not fillers.analyze_candidate(tone, SR, ref_db=loud_ref).ok


def test_detector_rejects_gliding_tone():
    t = np.arange(int(0.6 * SR)) / SR
    glide = (0.3 * np.sin(2 * np.pi * (120 + 80 * t / 0.6) * t)).astype(np.float32)
    f = fillers.analyze_candidate(glide, SR, ref_db=None)
    assert f.f0_std_st > 1.5 and not f.ok


def test_candidate_regions():
    mic = [Span(0.0, 0.6), Span(1.0, 4.0), Span(5.0, 5.1)]
    words = [Span(1.0, 1.5), Span(1.6, 2.0), Span(2.8, 4.0)]
    regions = fillers.candidate_regions(mic, words)
    # первый сегмент без слов; внутри второго — дыра 2.15–2.65 (с запасом 0,15 с от слов); третий короче 0,25 с
    assert regions[0] == Span(0.0, 0.6)
    assert any(abs(r.start - 2.15) < 1e-6 and abs(r.end - 2.65) < 1e-6 for r in regions)
    assert len(regions) == 2
    # щель 0,3 с между словами — слишком мала после запаса: кандидатом не становится
    assert fillers.candidate_regions([Span(0, 3)], [Span(0, 1.0), Span(1.3, 3.0)]) == []


def test_detect_filled_pauses_end_to_end_synthetic():
    sig = np.zeros(SR * 3, dtype=np.float32)
    tone = _tone(140.0, 0.6, harmonics=20)
    sig[SR : SR + tone.size] = tone
    ev = fillers.detect_filled_pauses(sig, SR, [Span(1.0, 1.6)], [], ref_db=None)
    assert len(ev) == 1 and ev[0].kind == "filled_pause" and ev[0].source == "detector" and ev[0].label == "э-э"
    assert abs(ev[0].t - 1.0) < 1e-6 and abs(ev[0].end - 1.6) < 1e-6


def test_merge_dedup_marks_both():
    a = [SpeechEvent(t=1.0, end=1.4, kind="filled_pause", label="э-э", source="asr", word_i=3)]
    d = [
        SpeechEvent(t=1.1, end=1.5, kind="filled_pause", label="э-э", source="detector"),
        SpeechEvent(t=5.0, end=5.5, kind="filled_pause", label="м-м", source="detector"),
    ]
    merged = fillers.merge_filler_events(a, d)
    assert len(merged) == 2
    assert merged[0].source == "both" and merged[0].word_i == 3
    assert merged[1].source == "detector"
