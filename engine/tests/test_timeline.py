from conftest import words_from_text

from remarka_engine import timeline
from remarka_engine.spans import Span


def test_window_bounds():
    b = timeline.window_bounds(48.0)
    assert b[0] == (0.0, 15.0) and b[-1] == (30.0, 45.0) and len(b) == 7
    assert timeline.window_bounds(10.0) == [(0.0, 10.0)]
    assert timeline.window_bounds(15.0) == [(0.0, 15.0)]
    assert timeline.window_bounds(0.0) == []


def test_wpm_and_articulation_and_fast_burst():
    words = words_from_text(" ".join(["слово"] * 30), word_dur=0.3, gap=0.2)  # 30 слов, 0–14.8 с
    mic = [Span(0, 14.8)]
    tl = timeline.build(words, mic, [], 30.0, None, ref_high_wpm=130)
    assert tl.wpm[0].t == 7.5 and abs(tl.wpm[0].v - 120.0) < 1e-6
    assert abs(tl.articulation_wpm[0].v - 30 / (14.8 / 60)) < 1e-6
    assert tl.wpm[-1].v == 0.0  # окно без моей речи
    assert tl.fast_bursts == []
    # собеседник говорит один 5 с внутри первого окна → моё время 10 с → 180 сл/мин > 130·1,2
    tl2 = timeline.build(words, [Span(0, 10)], [Span(10, 15)], 30.0, None, ref_high_wpm=130)
    assert abs(tl2.wpm[0].v - 180.0) < 1e-6
    assert tl2.fast_bursts and tl2.fast_bursts[0].kind == "fast_burst" and tl2.fast_bursts[0].t == 0.0 and tl2.fast_bursts[0].end == 15.0
    assert tl2.other_speaking == [Span(10, 15)]


def test_median_wpm_ignores_sparse_windows():
    words = words_from_text(" ".join(["слово"] * 10), word_dur=0.3, gap=0.2)  # 10 слов за 5 с
    tl = timeline.build(words, [Span(0, 4.8)], [], 30.0, None, None)
    assert tl.median_wpm() == 40.0  # только первое окно имеет ≥ 5 слов
    assert tl.to_dict()["window_sec"] == 15 and len(tl.to_dict()["wpm"]) == 4
